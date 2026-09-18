/** Replay-time evidence audience checks — durable-continuity spec §7, §10. */
import type { ContinuityEvidenceResolution } from "../core/types.js";
import type { EvidenceRef } from "../seam/continuity.js";
import { childStartForAttempt } from "./continuity-materialization-provenance.js";
import type { ContinuityEnvelopeV1, ContinuityResolvedEvaluation } from "./continuity-types.js";
import type { PersistedRecord } from "./log.js";

/** Execution outcome plus the host-owned child sandbox identity, when any. */
export type DurableContinuityExecution = ContinuityResolvedEvaluation & {
  readonly child_id?: string;
  /** Append-order delegated attempt that admitted this sandbox execution. */
  readonly attempt?: number;
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
    // identity names that same child and exact retry attempt. A handoff has no
    // child grant and may reference a reconciled run-level role execution.
    return envelope.child === undefined ||
      (execution.child_id === envelope.child.child_id &&
        execution.attempt === envelope.child.attempt)
      ? "verified"
      : "missing";
  }
  if (envelope.child === undefined) return "missing";
  const start = childStartForAttempt(records, {
    run_id: envelope.run_id,
    child_id: envelope.child.child_id,
    task_id: envelope.child.task_id,
    attempt: envelope.child.attempt,
  });
  // A persisted child packet can claim only the context inventory from its
  // exact durable retry attempt. Duplicate starts and wrong task bindings fail
  // closed as a missing resolution.
  if (start === null) return "missing";
  return start.start.context_artifacts?.artifacts.some(
    (artifact) => artifact.id === ref.artifact_id && artifact.sha256 === ref.sha256,
  )
    ? "verified"
    : "missing";
}
