/** Settlement-triggered immutable native output publication and recovery — issue #116. */
import type { ControllerConfig } from "../../manifest/controller.js";
import type { ControllerOutputPrincipal } from "../../manifest/controller-output.js";
import { combineInputAudiences, intersectOutputAudience } from "../../manifest/output-audience.js";
import type { ChildOutputBinding } from "../../persistence/child-output-artifact.js";
import type {
  ChildOutputCapture,
  ChildOutputRecord,
  ChildOutputStartedRecord,
} from "../../persistence/child-output-records.js";
import { reconstructChildOutputTimeline } from "../../persistence/child-output-timeline.js";
import type { ControllerActivationStartedRecord } from "../../persistence/controller-records.js";
import type {
  PersistedRecord,
  SubagentCompletedRecord,
  SubagentFailedRecord,
} from "../../persistence/log.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import type { PoolChildResult } from "../delegation/pool.js";
import { type CapturedChildOutput, captureTrustedChildOutputs } from "./child-output-capture.js";
import type { ChildOutputStore, PublishedChildOutput } from "./child-output-store.js";

type Terminal = SubagentCompletedRecord | SubagentFailedRecord;
interface Options {
  readonly activation: ControllerActivationStartedRecord;
  readonly config: ControllerConfig;
  readonly store: ChildOutputStore;
  readonly records: () => readonly PersistedRecord[];
  readonly persist: (record: ChildOutputRecord) => void;
  readonly inputAudience: (
    ref: string,
    principal: ControllerOutputPrincipal,
  ) => Promise<readonly ControllerOutputPrincipal[] | null>;
  readonly assertOpen: () => void;
  readonly wake: () => void;
  readonly onFatal: (cause: unknown) => void;
}
/** Collect before the native terminal; publish only after the exact terminal is durable. */
export function createChildOutputPublication(options: Options) {
  const captured = new Map<string, readonly CapturedChildOutput[]>();
  const running = new Map<string, Promise<void>>();
  let poison: unknown;
  const append = (record: ChildOutputRecord): void => {
    try {
      options.persist(record);
    } catch (cause) {
      poison = cause;
      throw cause;
    }
    options.wake();
  };
  const common = (terminal: Terminal) => {
    const records = options.records();
    const ordinal = records.findIndex(
      (record) =>
        (record.type === "subagent_completed" || record.type === "subagent_failed") &&
        record.child_id === terminal.child_id,
    );
    if (ordinal < 0) throw new Error("child output has no durable terminal");
    return {
      schema_version: 1 as const,
      run_id: options.activation.run_id,
      controller_id: options.activation.controller_id,
      definition_digest: options.activation.definition_digest,
      activation_id: options.activation.activation_id,
      owner_epoch: options.activation.owner_epoch,
      child_id: terminal.child_id,
      task_id: terminal.task_id,
      producer_profile_id: terminal.subagent,
      terminal: { ordinal, record_digest: sha256Canonical(terminal) },
      ts: Date.now(),
    };
  };
  const publish = async (terminal: Terminal): Promise<void> => {
    const policy = options.config.child_outputs?.find(
      (item) => item.profile_id === terminal.subagent,
    );
    if (policy === undefined) return;
    const prior = reconstructChildOutputTimeline(options.records()).children.find(
      (item) => item.child_id === terminal.child_id,
    );
    if (prior !== undefined && prior.status !== "pending") return;
    let start = prior?.start ?? null;
    if (terminal.output_capture === undefined) {
      if (terminal.output_capture_failure === undefined) return; // Historical child predates output capture.
      append({
        ...common(terminal),
        type: "controller_child_output_failed",
        intent_digest: null,
        code: terminal.output_capture_failure,
      });
      return;
    }
    try {
      options.assertOpen();
      if (start === null) {
        const inputAudience = await nativeInputAudience(terminal.child_id, options);
        options.assertOpen();
        start = {
          ...common(terminal),
          type: "controller_child_output_started",
          capture: terminal.output_capture,
          policy,
          input_audience: inputAudience === null ? null : [...inputAudience],
        };
        append(start);
      }
      const cached = captured.get(terminal.child_id);
      const outputs: PublishedChildOutput[] = [];
      for (const fingerprint of start.capture.outputs) {
        options.assertOpen();
        const binding = outputBinding(start, fingerprint);
        const source = cached?.find((item) => item.id === fingerprint.id);
        const output =
          source === undefined
            ? await options.store.recover(binding)
            : await options.store.publish({
                binding,
                bytes: source.bytes,
                inputAudience: start.input_audience,
              });
        if (output.sha256 !== fingerprint.sha256 || output.byteLength !== fingerprint.byte_length)
          throw new Error("child output source fingerprint mismatch");
        outputs.push(output);
      }
      options.assertOpen();
      append({
        ...common(terminal),
        type: "controller_child_output_published",
        intent_digest: sha256Canonical(start),
        outputs: outputs.map((output) => ({
          ref: output.ref,
          sha256: output.sha256,
          byte_length: output.byteLength,
          media_type: output.mediaType,
          binding: output.binding,
        })),
      });
    } catch (cause) {
      if (poison !== undefined) throw cause;
      // Missing sealed bytes are unresolved; replaying the native worker cannot recreate evidence.
      if (start === null) throw cause;
      append({
        ...common(terminal),
        type: "controller_child_output_failed",
        intent_digest: sha256Canonical(start),
        code: "child-output-publication-unresolved",
      });
    } finally {
      captured.delete(terminal.child_id);
    }
  };
  const queue = (terminal: Terminal): void => {
    if (running.has(terminal.child_id)) return;
    const work = publish(terminal);
    running.set(terminal.child_id, work);
    void work.then(
      () => {
        running.delete(terminal.child_id);
        options.wake();
      },
      (cause) => {
        running.delete(terminal.child_id);
        options.onFatal(cause);
      },
    );
  };
  return {
    async capture(result: PoolChildResult): Promise<ChildOutputCapture | undefined> {
      const policy = options.config.child_outputs?.find(
        (item) => item.profile_id === result.subagent,
      );
      if (policy === undefined) return undefined;
      options.assertOpen();
      const value = await captureTrustedChildOutputs({
        worktree: {
          path: result.worktreePath,
          branch: result.branch,
          acceptedBase: result.baseCommit,
        },
        policy,
        policyDigest: sha256Canonical(policy),
      });
      options.assertOpen();
      captured.set(result.childId, value.outputs);
      return value.capture;
    },
    /** Wake-up data is advisory; read the authoritative terminal before using it. */
    terminal(result: PoolChildResult): void {
      const terminal = options
        .records()
        .find(
          (record) =>
            (record.type === "subagent_completed" || record.type === "subagent_failed") &&
            record.child_id === result.childId,
        );
      if (terminal?.type !== "subagent_completed" && terminal?.type !== "subagent_failed")
        throw new Error("child output notification has no terminal");
      queue(terminal);
    },
    recover(): void {
      for (const record of options.records())
        if (
          (record.type === "subagent_completed" || record.type === "subagent_failed") &&
          (record.output_capture !== undefined || record.output_capture_failure !== undefined)
        )
          queue(record);
    },
    async settle(): Promise<void> {
      while (running.size > 0) await Promise.all([...running.values()]);
      if (poison !== undefined) throw poison;
    },
    pendingCount: () => running.size,
  };
}

function outputBinding(
  start: ChildOutputStartedRecord,
  output: ChildOutputCapture["outputs"][number],
): ChildOutputBinding {
  const selected = start.policy.reports.find((item) => item.id === output.id) ?? start.policy.patch;
  if (selected === undefined || selected.id !== output.id)
    throw new Error("child output policy selection is missing");
  return {
    runId: start.run_id,
    definitionDigest: start.definition_digest,
    childId: start.child_id,
    taskId: start.task_id,
    acceptedBase: start.capture.accepted_base,
    terminal: { ordinal: start.terminal.ordinal, recordDigest: start.terminal.record_digest },
    producerProfileId: start.producer_profile_id,
    output: { id: output.id, path: output.path, kind: output.kind },
    outputPolicyDigest: start.capture.policy_digest,
    mediaType: output.media_type,
    audience: [...intersectOutputAudience(selected.consumers, start.input_audience)],
  };
}
async function nativeInputAudience(
  childId: string,
  options: Options,
): Promise<readonly ControllerOutputPrincipal[] | null> {
  const accepted = options
    .records()
    .find(
      (record) =>
        record.type === "delegation_submission_accepted" &&
        record.children.some((child) => child.child_id === childId),
    );
  if (
    accepted?.type !== "delegation_submission_accepted" ||
    (accepted.schema_version !== 2 && accepted.schema_version !== 3) ||
    accepted.origin.kind !== "controller_action"
  )
    throw new Error("child output acceptance is missing");
  const child = accepted.children.find((entry) => entry.child_id === childId);
  const taskId = child?.task_id;
  const task = accepted.accepted_args.tasks.find((item) => item.id === taskId);
  if (task === undefined) throw new Error("child output accepted task is missing");
  const audiences = await Promise.all(
    (task.context_artifacts ?? []).flatMap((item) =>
      item.source === "host_artifact"
        ? [options.inputAudience(item.ref, { kind: "native", profile_id: task.subagent })]
        : [],
    ),
  );
  return combineInputAudiences([
    ...audiences,
    ...(child?.source_workspace === undefined ? [] : [child.source_workspace.audience]),
  ]);
}
