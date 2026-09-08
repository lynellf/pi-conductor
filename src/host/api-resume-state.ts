/** Durable resume reconstruction helpers (spec §11.1). */

import { reduceLifecycle } from "../core/reduce-lifecycle.js";
import type {
  Checkpoint,
  HandoffContextRef,
  MachineDefinition,
  Role,
  SessionLifecycleEvent,
} from "../core/types.js";
import { DEFAULT_MODEL_EFFORT } from "../core/types.js";
import { modeFor } from "../manifest/handoffs.js";
import type {
  ArtifactDeliveryRecord,
  CheckpointSnapshot,
  PersistedRecord,
  RecordLog,
} from "../persistence/log.js";
import {
  type HandoffTransportSelectedRecord,
  type ManifestSnapshotRecord,
  type TrajectoryHandoffFailedRecord,
  TrajectoryResumeError,
  validateTrajectorySelector,
  verifyManifestSnapshot,
} from "../persistence/trajectory-records.js";
import { reconcileDelegationChildren } from "./delegation/reconcile.js";
import type { LoadedManifest } from "./manifest.js";
import { notifyListeners } from "./record-emitter.js";
/** Find and validate the latest pinned manifest snapshot for a run. */
export function latestManifestSnapshot(
  records: readonly PersistedRecord[],
  runId: string,
): ManifestSnapshotRecord | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.type !== "manifest_snapshot" || record.run_id !== runId) continue;
    return verifyManifestSnapshot(record);
  }
  return null;
}

/** Find the latest artifact delivery addressed to the resumed checkpoint. */
export function latestArtifactDelivery(
  records: readonly PersistedRecord[],
  runId: string,
  checkpoint: Checkpoint,
): ArtifactDeliveryRecord | null {
  if (checkpoint.current_role === "done") return null;

  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.type !== "artifact_delivery" || record.run_id !== runId) continue;
    return record.receiver_role === checkpoint.current_role ? record : null;
  }
  return null;
}

/**
 * Fail closed when a crash reaches a trajectory receiver before its exact
 * target environment was made durable (Issue #63 §4.5). A fresh spawn cannot
 * reconstruct that environment without changing the selected transport.
 */
export function assertNoUnselectedTrajectoryHandoff(
  records: readonly PersistedRecord[],
  runId: string,
  checkpoint: Checkpoint,
  handoffs: LoadedManifest["manifest"]["handoffs"],
  log: RecordLog,
): void {
  if (checkpoint.current_role === "done") return;

  const acceptedIndex = findIncomingAcceptedHandoff(records, runId, checkpoint.current_role);
  if (acceptedIndex === null) return;
  const accepted = records[acceptedIndex];
  if (accepted?.type !== "transition_accepted") return;
  if (modeFor(handoffs, accepted.from, accepted.to) !== "trajectory") return;

  const source = sourceConversationForAcceptedHandoff(records, acceptedIndex, accepted);
  const laterRecords = records.slice(acceptedIndex + 1);
  const matchingSelector = laterRecords.find(
    (record): record is HandoffTransportSelectedRecord =>
      record.type === "handoff_transport_selected" &&
      record.from === accepted.from &&
      record.to === accepted.to &&
      record.source_role_session_id === source.roleSessionId,
  );
  if (matchingSelector !== undefined) {
    // Preserve the existing typed corrupt-selector path; it must not become
    // an invented fresh receiver merely because this guard ran first.
    validateTrajectorySelector(matchingSelector);
    return;
  }

  const priorFailure = laterRecords.find(
    (record): record is TrajectoryHandoffFailedRecord =>
      record.type === "trajectory_handoff_failed" &&
      record.from === accepted.from &&
      record.to === accepted.to &&
      record.source_conversation.id === source.conversation.id &&
      record.source_conversation.file === source.conversation.file,
  );
  if (priorFailure !== undefined) {
    throw new TrajectoryResumeError(priorFailure.message, priorFailure.code);
  }

  const message =
    "trajectory receiver checkpoint has no durable target environment; refusing fresh resume";
  log.append({
    type: "trajectory_handoff_failed",
    schema_version: 1,
    run_id: runId,
    from: accepted.from,
    to: accepted.to,
    source_conversation: source.conversation,
    code: "trajectory_transport_unrecoverable",
    message,
    ts: Date.now(),
  });
  throw new TrajectoryResumeError(message, "trajectory_transport_unrecoverable");
}

/** Find the accepted handoff that produced the currently resumed role. */
export function findIncomingAcceptedHandoff(
  records: readonly PersistedRecord[],
  runId: string,
  role: Role,
): number | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (
      record?.type === "transition_accepted" &&
      record.run_id === runId &&
      record.event === "handoff" &&
      record.to === role
    ) {
      return index;
    }
  }
  return null;
}

/** Recover the source's durable logical and physical identities for a failed selection. */
export function sourceConversationForAcceptedHandoff(
  records: readonly PersistedRecord[],
  acceptedIndex: number,
  accepted: Extract<PersistedRecord, { readonly type: "transition_accepted" }>,
): {
  readonly roleSessionId: string;
  readonly conversation: { readonly id: string; readonly file: string };
} {
  for (let index = acceptedIndex - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (
      record?.type === "session_started" &&
      record.role === accepted.role &&
      record.session_file === accepted.session_file
    ) {
      const roleSessionId = record.role_session_id ?? accepted.session_file;
      return {
        roleSessionId,
        conversation: {
          id: record.conversation_id ?? roleSessionId,
          file: accepted.session_file,
        },
      };
    }
  }

  // A policy-bearing run writes lifecycle identities. If a damaged log lacks
  // one, the session file remains the only durable identity; it is still
  // safer to close the run than to reinterpret the selected edge as fresh.
  return {
    roleSessionId: accepted.session_file,
    conversation: { id: accepted.session_file, file: accepted.session_file },
  };
}

/** Find and validate the exact selector that still targets this checkpoint. */
export function latestTrajectorySelector(
  records: readonly PersistedRecord[],
  runId: string,
  checkpoint: Checkpoint,
): HandoffTransportSelectedRecord | null {
  if (checkpoint.current_role === "done") return null;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record === undefined || !("run_id" in record) || record.run_id !== runId) continue;
    if (record.type === "handoff_transport_selected" && record.to === checkpoint.current_role) {
      return validateTrajectorySelector(record);
    }
    if (
      record.type === "transition_accepted" &&
      record.event === "handoff" &&
      record.to === checkpoint.current_role
    ) {
      return null;
    }
  }
  return null;
}

/** Reconstruct each role's next logical visit index from durable lifecycle starts. */
export function nextVisitIndexes(
  records: readonly PersistedRecord[],
  runId: string,
): Readonly<Record<string, number>> {
  const highest = new Map<string, number>();
  for (const record of records) {
    if (record.type !== "session_started" || record.run_id !== runId) continue;
    highest.set(record.role, Math.max(highest.get(record.role) ?? 0, record.visit_index));
  }
  return Object.freeze(
    Object.fromEntries([...highest].map(([role, visitIndex]) => [role, visitIndex + 1])),
  );
}

/** Recover the latest predecessor context reference for a resumed run. */
export function latestHandoffContextRef(
  records: readonly PersistedRecord[],
  runId: string,
): HandoffContextRef | null {
  let latest: HandoffContextRef | null = null;
  for (const record of records) {
    if (record.type !== "transition_accepted") continue;
    if (record.run_id !== runId || record.event !== "handoff") continue;
    if (record.context_ref !== undefined) {
      latest = record.context_ref;
      continue;
    }
    latest = record.session_file.startsWith("<synthesized:")
      ? null
      : {
          run_id: runId,
          source_role: record.role,
          source_session_file: record.session_file,
        };
  }
  return latest;
}

/**
 * Detect a crash-mid-session and reconcile via
 * `session_failed("crashed")` + cleared checkpoint. Returns the
 * checkpoint the loop should resume from.
 */
export function reconcileCrash(
  runId: string,
  checkpoint: Checkpoint,
  def: MachineDefinition,
  log: RecordLog,
): Checkpoint {
  reconcileLostChildren(runId, log, (record) => {
    log.append(record);
    notifyListeners(record);
  });
  const active = checkpoint.active_role_session;
  if (active === null) return checkpoint;

  const records = log.records(runId);
  const sessionFile = active.session_file;

  // New records match the conductor invocation identity, not the shared
  // physical JSONL. Legacy records have no logical identity and retain the
  // historical session-file fallback.
  let sessionStarted:
    | (SessionLifecycleEvent & {
        readonly role_session_id?: string;
        readonly conversation_id?: string | null;
      })
    | null = null;
  let sessionStartedIndex = -1;
  // A durable Prewalk executor recovery intentionally retains the logical role-session
  // identity. Select the latest start so a second process crash cannot be mistaken for
  // the terminal of its earlier guide attempt.
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const r = records[index];
    if (r?.type !== "session_started") continue;
    const matchesLogical = r.role_session_id === active.id;
    const matchesLegacy = r.role_session_id === undefined && r.session_file === sessionFile;
    if (matchesLogical || matchesLegacy) {
      sessionStarted = r;
      sessionStartedIndex = index;
      break;
    }
  }
  if (sessionStarted === null) {
    // No matching session_started — defensive. Return as-is.
    return checkpoint;
  }

  // Has a terminal lifecycle record already been written for this session?
  let hasTerminal = false;
  for (const r of records.slice(sessionStartedIndex + 1)) {
    if (
      (r.type === "session_ended" || r.type === "session_failed") &&
      (sessionStarted.role_session_id !== undefined
        ? r.role_session_id === sessionStarted.role_session_id
        : r.role_session_id === undefined && r.session_file === sessionFile)
    ) {
      hasTerminal = true;
      break;
    }
  }
  if (hasTerminal) {
    // Already reconciled (or another resume already did this). Just
    // ensure the checkpoint's active_role_session is cleared.
    if (checkpoint.active_role_session !== null) {
      const cleared: Checkpoint = {
        ...checkpoint,
        active_role_session: null,
        updated_at: Date.now(),
      };
      log.append({ type: "checkpoint_snapshot", checkpoint: cleared });
      return cleared;
    }
    return checkpoint;
  }

  // No terminal → crashed. Record session_failed("crashed") via the
  // reducer. The reducer validates identity (meta.sessionId must
  // match active_role_session.id) and produces the canonical
  // record + checkpoint transition.
  //
  // §11.4: terminals cost — both session_ended and session_failed
  // carry `usage`. For a crashed session, the per-session usage is
  // unknown (the loop never reached a terminal); the reconciler
  // records zeros. The actual usage, if recoverable, would have to
  // come from a partial event-stream aggregation; that's a Phase 5
  // enhancement. The §11.6 roll-up treats this as zeros for the
  // crashed session, which is the conservative interpretation (we
  // don't know how much was spent).
  const ts = Date.now();
  const result = reduceLifecycle(checkpoint, "session_failed", def, {
    role: active.role,
    sessionId: active.id,
    sessionFile: active.session_file,
    failureReason: "crashed",
    ts,
    visit_index: sessionStarted.visit_index,
    parent_session: sessionStarted.parent_session,
    usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 },
    model: sessionStarted.model,
    model_effort: sessionStarted.model_effort ?? DEFAULT_MODEL_EFFORT,
  });
  log.append({
    ...result.record,
    ...(sessionStarted.role_session_id !== undefined && {
      role_session_id: sessionStarted.role_session_id,
      conversation_id: sessionStarted.conversation_id ?? null,
    }),
  });
  // Persist the cleared checkpoint.
  const snapshot: CheckpointSnapshot = {
    type: "checkpoint_snapshot",
    checkpoint: result.checkpoint,
  };
  log.append(snapshot);
  return result.checkpoint;
}

/**
 * Resume never relaunches a child; unmatched starts become one durable
 * cancellation (§7). The optional persistence seam lets the resume path emit
 * the synthesized terminal through the same live record bridge as normal
 * child terminals; direct callers retain the in-memory log-only behavior.
 */
export function reconcileLostChildren(
  runId: string,
  log: RecordLog,
  persistRecord: (record: PersistedRecord) => void = (record) => log.append(record),
): void {
  reconcileDelegationChildren(runId, log, persistRecord);
}
