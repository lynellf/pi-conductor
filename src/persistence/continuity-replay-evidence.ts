/** Replay-time evidence audience checks — durable-continuity spec §7, §10. */
import type { ContinuityEvidenceResolution } from "../core/types.js";
import type { EvidenceRef } from "../seam/continuity.js";
import type { ContinuityEnvelopeV1, ContinuityResolvedEvaluation } from "./continuity-types.js";
import type { PersistedRecord, SubagentStartedRecord } from "./log.js";

/** Execution outcome plus the host-owned child sandbox identity, when any. */
export type DurableContinuityExecution = ContinuityResolvedEvaluation & {
  readonly child_id?: string;
};

/** Derive replay status from the envelope's durable audience, never stored status alone. */
export function expectedReplayEvidenceStatus(
  ref: EvidenceRef,
  envelope: ContinuityEnvelopeV1,
  executions: ReadonlyMap<string, DurableContinuityExecution>,
  records: readonly PersistedRecord[],
): ContinuityEvidenceResolution["status"] | undefined {
  if (ref.kind === "external") return "declared";
  // Repository verification is performed before persistence against the
  // canonical repository; pure replay intentionally has no filesystem.
  if (ref.kind === "repository") return undefined;
  if (ref.kind === "tool_execution") {
    const execution = executions.get(ref.execution_id);
    if (execution === undefined || execution.cleanup_disposition !== "confirmed") return "missing";
    // A child packet can certify only the execution whose durable sandbox
    // identity names that same child. A handoff has no child grant and may
    // reference a reconciled run-level role execution.
    return envelope.child === undefined || execution.child_id === envelope.child.child_id
      ? "verified"
      : "missing";
  }
  if (envelope.child === undefined) return "missing";
  const starts = records.filter(
    (record): record is SubagentStartedRecord =>
      record.type === "subagent_started" &&
      record.run_id === envelope.run_id &&
      record.child_id === envelope.child?.child_id,
  );
  // A unique child/task start is required before a persisted child packet can
  // claim any context artifact. Duplicate starts and wrong task bindings fail
  // closed as a missing resolution.
  if (starts.length !== 1 || starts[0]?.task_id !== envelope.child.task_id) return "missing";
  return starts[0].context_artifacts?.artifacts.some(
    (artifact) => artifact.id === ref.artifact_id && artifact.sha256 === ref.sha256,
  )
    ? "verified"
    : "missing";
}
