/** Asynchronous dispatch of already-committed controller actions — issue #115 §§4, 6. */

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
import {
  artifactRefs,
  findControllerRef,
  intentCursor,
  operationIdForExecution,
  parseStrictJson,
} from "./action-dispatcher-query.js";
import {
  controllerAcceptedSubmissionRef,
  controllerRefNamespace,
  parseControllerRef,
} from "./controller-refs.js";
import { getControllerEvents } from "./event-page.js";
import { assertControllerReadResult, controllerReadResultSchemaDigest } from "./read-result.js";

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
  const action = (actionId: string) => getControllerAction(timeline(), actionId);
  const identity = options.activation;

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
    if (cause instanceof ToolExecutionError && cause.code === "tool_persistence_ambiguous") {
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
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_READ_BYTES
    )
      throw new Error("controller read range is invalid");
    if (ref.startsWith("artifact/v1/")) {
      return {
        kind: "artifact",
        value: await options.artifacts.rangeReadForController({
          ref,
          runId: identity.run_id,
          definitionDigest: identity.definition_digest,
          offset,
          length: limit,
        }),
      };
    }
    const parsed = parseControllerRef(ref);
    if (parsed.namespace !== controllerRefNamespace(identity))
      throw new Error("controller ref is outside active namespace");
    const value = findControllerRef(
      parsed.kind,
      parsed.digest,
      timeline(),
      options.admission,
      options.readRecords(),
      identity.run_id,
    );
    if (value === undefined) throw new Error("controller ref is unavailable");
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    if (offset > bytes.byteLength) throw new Error("controller read range is invalid");
    const page = bytes.subarray(offset, offset + Math.min(limit, bytes.byteLength - offset));
    return {
      kind: parsed.kind,
      value: {
        encoding: "base64",
        data: page.toString("base64"),
        offset,
        next_offset: offset + page.byteLength,
        total_bytes: bytes.byteLength,
        eof: offset + page.byteLength === bytes.byteLength,
      },
    };
  };

  const publishRead = async (
    state: ControllerActionState,
    request: Extract<ControllerActionState["intent"]["request"], { readonly kind: "read" }>,
  ): Promise<{ readonly ref: string; readonly result: unknown }> => {
    const result = await read(request.ref, request.offset, request.limit);
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
      },
      validate: (candidate) => assertControllerReadResult(JSON.parse(candidate.toString("utf8"))),
    });
    return { ref: published.ref, result: document };
  };

  const dispatcher: ControllerActionDispatcher = {
    async validateReferences(actions) {
      for (const candidate of actions) {
        if (candidate.kind === "adapter") {
          for (const ref of candidate.input_refs) await read(ref, 0, 1);
        } else if (candidate.kind === "read") {
          await read(candidate.ref, candidate.offset, candidate.limit);
        } else if (candidate.kind === "delegate") {
          for (const ref of artifactRefs(candidate)) await read(ref, 0, 1);
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
    },
    getAction: action,
    getAcceptedSubmission: (actionId: string) => options.admission.acceptedSubmission(actionId),
    getEvents: (cursor, limit) =>
      getControllerEvents(options.readRecords(), identity, cursor, limit),
    read,
    async resolveRef(ref) {
      if (!ref.startsWith("artifact/v1/")) {
        const first = await read(ref, 0, MAX_READ_BYTES);
        if (first.kind === "artifact") throw new Error("unexpected artifact resolver result");
        if (!first.value.eof)
          throw new Error("controller reference exceeds bounded resolver limit");
        return parseStrictJson(Buffer.from(first.value.data, "base64"));
      }
      const chunks: Buffer[] = [];
      let offset = 0;
      let total: number | undefined;
      while (true) {
        const page = await read(ref, offset, MAX_READ_BYTES);
        if (page.kind !== "artifact")
          throw new Error("artifact reference resolved to non-artifact");
        if (total === undefined) total = page.value.byteLength;
        if (page.value.byteLength !== total || page.value.bytes.byteLength > MAX_READ_BYTES)
          throw new Error("artifact range binding changed during resolution");
        chunks.push(page.value.bytes);
        offset += page.value.bytes.byteLength;
        if (offset === total) break;
        if (page.value.bytes.byteLength === 0 || total > 1024 * 1024)
          throw new Error("artifact cannot be fully resolved within bounds");
      }
      return parseStrictJson(Buffer.concat(chunks));
    },
    pendingCount: () => running.size + adapterQueue.length,
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
  return String(cause instanceof Error ? cause.message : cause).slice(0, 4096);
}
