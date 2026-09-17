/** Asynchronous dispatch of already-committed controller actions — issue #115 §§4, 6. */
// Keep the shared receipt fence and its native/adapter/source queues together; below the 500-line exception ceiling.

import { writeFile } from "node:fs/promises";
import {
  type ControllerActionReceiptRecord,
  type ControllerActionState,
  getControllerAction,
  reconstructControllerTimeline,
} from "../../persistence/log.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import type { PoolChildResult } from "../delegation/pool.js";
import { ToolExecutionError } from "../execution/tool-execution-controller.js";
import type {
  ControllerActionDispatcher,
  ControllerReadResult,
  CreateControllerActionDispatcherOptions,
  ReceiptFields,
} from "./action-dispatcher-contract.js";
import { intentCursor, operationIdForExecution } from "./action-dispatcher-query.js";
import { assertControllerReadRange, createControllerActionReader } from "./action-reader.js";
import { controllerAcceptedSubmissionRef } from "./controller-refs.js";
import { EffectBrokerPoisonedError } from "./effect-broker.js";
import { getControllerEvents } from "./event-page.js";
import { ControllerEffectPendingError } from "./production-effects.js";
import { assertControllerReadResult, controllerReadResultSchemaDigest } from "./read-result.js";
import { SourceWorkspaceError } from "./source-workspace-contract.js";

const MAX_READ_BYTES = 32 * 1024;
const MAX_ADAPTERS = 4;

/** Construct an activation-fenced dispatcher; construction never starts historical work. */
export function createControllerActionDispatcher(
  options: CreateControllerActionDispatcherOptions,
): ControllerActionDispatcher {
  const maxAdapters = options.maxAdapters ?? 1;
  if (!Number.isSafeInteger(maxAdapters) || maxAdapters < 1 || maxAdapters > MAX_ADAPTERS)
    throw new Error("controller adapter concurrency must be between one and four");
  const running = new Set<Promise<void>>();
  let nativeTail = Promise.resolve();
  let adapterRunning = 0;
  const adapterQueue: string[] = [];

  const timeline = () => reconstructControllerTimeline(options.readRecords());
  const identity = options.activation;
  const action = (actionId: string) => getControllerAction(timeline(), actionId);
  const legacyReader = createControllerActionReader({ dispatcher: options, identity, timeline });

  const receipt = (state: ControllerActionState, fields: ReceiptFields): void => {
    if (
      fields.outcome === "pending" ||
      fields.outcome === "accepted" ||
      fields.outcome === "completed"
    )
      options.assertOpen();
    const record: ControllerActionReceiptRecord = {
      type: "controller_action_receipt",
      schema_version: 1,
      run_id: identity.run_id,
      controller_id: identity.controller_id,
      definition_digest: identity.definition_digest,
      action_id: state.actionId,
      activation_id: identity.activation_id,
      owner_epoch: identity.owner_epoch,
      intent_activation_id: state.intentActivationId,
      causal_revision: state.originalRevision,
      request_sha256: state.intent.request_sha256,
      kind: state.intent.kind,
      outcome: fields.outcome,
      operation_id: fields.operation_id,
      result_refs: fields.result_refs,
      ...(fields.result === undefined ? {} : { result: fields.result }),
      diagnostic: fields.diagnostic,
      ts: Date.now(),
    };
    try {
      options.persist(record);
    } catch (cause) {
      throw new ToolExecutionError(
        "tool_persistence_ambiguous",
        "controller receipt persistence is ambiguous",
        { cause },
      );
    }
    options.wake();
  };

  const track = (work: Promise<void>): void => {
    running.add(work);
    void work.then(
      () => running.delete(work),
      (cause) => {
        running.delete(work);
        options.onFatal(cause);
      },
    );
  };
  const terminalFailure = (state: ControllerActionState, cause: unknown, fatal = false): void => {
    if (
      cause instanceof ControllerEffectPendingError ||
      cause instanceof EffectBrokerPoisonedError ||
      (state.intent.kind === "prepare_source" &&
        options
          .readRecords()
          .some(
            (record) =>
              record.type === "source_workspace_intent" &&
              record.action_id === state.actionId &&
              !options
                .readRecords()
                .some(
                  (terminal) =>
                    terminal.type === "source_workspace_failed" &&
                    terminal.workspace_id === record.workspace_id,
                ),
          )) ||
      options
        .readRecords()
        .some(
          (record) =>
            record.type === "controller_effect_intent" && record.action_id === state.actionId,
        ) ||
      (cause instanceof ToolExecutionError && cause.code === "tool_persistence_ambiguous")
    ) {
      options.onFatal(cause);
      throw cause;
    }
    const uncertain = cause instanceof ToolExecutionError && cause.cleanup === "unconfirmed";
    const operationId = uncertain
      ? operationIdForExecution(options.readRecords(), cause.executionId, state, identity)
      : null;
    if (uncertain && operationId === null) {
      options.onFatal(cause);
      throw cause;
    }
    receipt(state, {
      outcome: uncertain ? "uncertain" : "failed",
      operation_id: operationId,
      result_refs: [],
      diagnostic: diagnostic(cause),
    });
    if (uncertain || fatal) options.onFatal(cause);
  };

  const runAdapterQueue = (): void => {
    while (adapterRunning < maxAdapters && adapterQueue.length > 0) {
      const actionId = adapterQueue.shift();
      if (actionId === undefined) return;
      adapterRunning += 1;
      const work = runAdapter(actionId).finally(() => {
        adapterRunning -= 1;
        runAdapterQueue();
      });
      track(work);
    }
  };

  const runAdapter = async (actionId: string): Promise<void> => {
    const state = requiredPending(action(actionId), actionId);
    const request = state.intent.request;
    if (request.kind !== "adapter") throw new Error("adapter queue received non-adapter action");
    try {
      options.assertOpen();
      const result = await options.executables.invokeAdapter(
        request,
        state.intent.request_sha256,
        options.signal,
      );
      options.assertOpen();
      const effect = options.runAdapterEffect?.(request, result, options.signal) ?? null;
      if (effect !== null) {
        // The sandboxed adapter lane is released while the host broker awaits its own resource lane.
        track(
          effect
            .then((fields) => receipt(state, fields))
            .catch((cause: unknown) => terminalFailure(state, cause)),
        );
        return;
      }
      receipt(state, {
        outcome: "completed",
        operation_id: result.operationId,
        result_refs: [result.artifact.ref],
        diagnostic: null,
      });
    } catch (cause) {
      terminalFailure(state, cause);
    }
  };

  const runNative = async (actionId: string): Promise<void> => {
    const state = requiredPending(action(actionId), actionId);
    const request = state.intent.request;
    if (request.kind !== "delegate") throw new Error("native queue received non-delegate action");
    try {
      const childIds = await options.runNativePreparation(request, async () => {
        options.assertOpen();
        return options.admission.submit(
          { kind: "controller_action", actionId, activationId: identity.activation_id },
          { mode: "nonblocking", tasks: request.tasks },
          request.source_workspace_ref,
        );
      });
      options.assertOpen();
      const accepted = options.admission.acceptedSubmission(actionId);
      if (accepted === null) throw new Error("native acceptance is missing after durable submit");
      receipt(state, {
        outcome: "accepted",
        operation_id: null,
        result_refs: [controllerAcceptedSubmissionRef(identity, actionId)],
        diagnostic: null,
      });
      track(waitNativeChildren(state, childIds));
    } catch (cause) {
      terminalFailure(state, cause, true);
    }
  };

  const waitNativeChildren = async (
    state: ControllerActionState,
    childIds: readonly string[],
  ): Promise<void> => {
    try {
      const results = await Promise.all(childIds.map((childId) => options.admission.wait(childId)));
      options.assertOpen();
      receipt(state, {
        outcome: results.every(isCompleted) ? "completed" : "failed",
        operation_id: null,
        result_refs: [],
        diagnostic: null,
      });
    } catch (cause) {
      terminalFailure(state, cause);
    }
  };

  const dispatchSimple = async (actionId: string): Promise<void> => {
    const state = requiredPending(action(actionId), actionId);
    const request = state.intent.request;
    try {
      if (request.kind === "prepare_source") {
        if (options.sources === undefined) throw new Error("source workspaces are not configured");
        receipt(
          state,
          await options.sources.prepare(request, state.intent.request_sha256, options.signal),
        );
        return;
      }
      if (request.kind === "cancel") await options.admission.cancel(request.child_ids);
      const published = request.kind === "read" ? await publishRead(state, request) : undefined;
      receipt(state, {
        outcome: "completed",
        operation_id: null,
        result_refs: published === undefined ? [] : [published.ref],
        ...(published === undefined ? {} : { result: published.result }),
        diagnostic: null,
      });
    } catch (cause) {
      terminalFailure(state, cause);
    }
  };

  const read = async (
    ref: string,
    offset = 0,
    limit = MAX_READ_BYTES,
  ): Promise<ControllerReadResult> => {
    assertControllerReadRange(offset, limit);
    if (
      options.outputResolver !== undefined &&
      (ref.startsWith("artifact/v1/") || ref.startsWith("child-output/v2/"))
    ) {
      const value = await options.outputResolver.resolveRef(ref, { kind: "controller" });
      if (offset > value.byteLength) throw new Error("controller read range is invalid");
      const bytes = value.bytes.subarray(
        offset,
        offset + Math.min(limit, value.byteLength - offset),
      );
      return {
        kind: "child_output" as const,
        value: {
          encoding: "base64",
          data: bytes.toString("base64"),
          offset,
          next_offset: offset + bytes.byteLength,
          total_bytes: value.byteLength,
          eof: offset + bytes.byteLength === value.byteLength,
        },
      };
    }
    return legacyReader.read(ref, offset, limit);
  };

  const publishRead = async (
    state: ControllerActionState,
    request: Extract<ControllerActionState["intent"]["request"], { readonly kind: "read" }>,
  ): Promise<{ readonly ref: string; readonly result: unknown }> => {
    const result = await read(request.ref, request.offset, request.limit);
    const inputAudience =
      request.ref.startsWith("source-workspace/v1/") && options.sources !== undefined
        ? (await options.sources.resolve(request.ref, { kind: "controller" })).audience
        : options.outputResolver === undefined ||
            (!request.ref.startsWith("artifact/v1/") && !request.ref.startsWith("child-output/v2/"))
          ? null
          : await options.outputResolver.getInputAudience(request.ref, { kind: "controller" });
    const document = {
      source_ref: request.ref,
      result:
        result.kind === "artifact"
          ? {
              encoding: "base64",
              data: result.value.bytes.toString("base64"),
              offset: request.offset ?? 0,
              total_bytes: result.value.byteLength,
            }
          : result.value,
    };
    assertControllerReadResult(document);
    const bytes = Buffer.from(JSON.stringify(document), "utf8");
    const staging = await options.artifacts.createStaging(state.actionId);
    await writeFile(staging.outputPath, bytes, { flag: "wx", mode: 0o600 });
    const source = intentCursor(options.readRecords(), state.actionId);
    const published = await options.artifacts.publish({
      staging,
      binding: {
        runId: identity.run_id,
        definitionDigest: identity.definition_digest,
        actionId: state.actionId,
        requestDigest: state.intent.request_sha256,
        producer: {
          kind: "source_cursor",
          ordinal: source.ordinal,
          recordDigest: source.recordDigest,
        },
        outputSchema: { id: "host-controller-read-v1", digest: controllerReadResultSchemaDigest },
        capabilityDigest: sha256Canonical({ capability: "controller-read" }),
        mediaType: "application/json",
        allowedConsumerProfileIds: [],
        ...(inputAudience === null ? {} : { audience: [...inputAudience] }),
      },
      validate: (candidate) => assertControllerReadResult(JSON.parse(candidate.toString("utf8"))),
    });
    return { ref: published.ref, result: document };
  };

  const dispatcher: ControllerActionDispatcher = {
    async validateReferences(actions) {
      for (const candidate of actions) {
        if (candidate.kind === "prepare_source") {
          if (options.sources === undefined)
            throw new Error("source workspaces are not configured");
          await options.sources.validate(candidate);
        } else if (candidate.kind === "adapter") {
          for (const ref of candidate.input_refs) {
            await dispatcher.resolveRef(ref, {
              kind: "adapter",
              adapter_id: candidate.adapter_id,
            });
          }
        } else if (candidate.kind === "read") {
          await read(candidate.ref, candidate.offset, candidate.limit);
        } else if (candidate.kind === "delegate") {
          for (const task of candidate.tasks) {
            for (const artifact of task.context_artifacts ?? []) {
              if (artifact.source !== "host_artifact") continue;
              if (options.outputResolver !== undefined)
                await options.outputResolver.resolveRef(artifact.ref, {
                  kind: "native",
                  profile_id: task.subagent,
                });
              else await read(artifact.ref, 0, 1);
            }
          }
        }
      }
    },
    dispatchCommitted(actionId) {
      const state = action(actionId);
      if (state === null || state.latestReceipt !== null) return;
      receipt(state, { outcome: "pending", operation_id: null, result_refs: [], diagnostic: null });
      if (state.intent.kind === "delegate") {
        nativeTail = nativeTail.then(() => runNative(actionId));
        track(nativeTail);
      } else if (state.intent.kind === "adapter") {
        adapterQueue.push(actionId);
        runAdapterQueue();
      } else track(dispatchSimple(actionId));
    },
    async settle() {
      while (running.size > 0) await Promise.allSettled([...running]);
      await options.externalSettle?.();
    },
    getAction: action,
    getAcceptedSubmission: (actionId: string) => options.admission.acceptedSubmission(actionId),
    getEvents: (cursor, limit) =>
      getControllerEvents(options.readRecords(), identity, cursor, limit),
    read,
    async resolveRef(ref, principal = { kind: "controller" }) {
      if (ref.startsWith("source-workspace/v1/")) {
        if (options.sources === undefined) throw new Error("source workspaces are not configured");
        return (await options.sources.resolve(ref, principal)).descriptor;
      }
      if (
        options.outputResolver !== undefined &&
        (ref.startsWith("artifact/v1/") || ref.startsWith("child-output/v2/"))
      )
        return options.outputResolver.resolveRef(ref, principal);
      return legacyReader.resolveLegacyRef(ref);
    },
    pendingCount: () =>
      running.size + adapterQueue.length + (options.externalPendingCount?.() ?? 0),
  };
  return Object.freeze(dispatcher);
}

function requiredPending(
  state: ControllerActionState | null,
  actionId: string,
): ControllerActionState {
  if (state === null || state.latestReceipt?.outcome !== "pending")
    throw new Error(`controller action '${actionId}' is not pending`);
  return state;
}

function isCompleted(result: PoolChildResult): boolean {
  return result.status === "completed";
}
function diagnostic(cause: unknown): string {
  let nested = cause;
  for (let depth = 0; nested instanceof Error && depth < 8; depth++) {
    if (nested instanceof SourceWorkspaceError) return `source preparation failed: ${nested.code}`;
    nested = nested.cause;
  }
  return String(cause instanceof Error ? cause.message : cause).slice(0, 4096);
}
