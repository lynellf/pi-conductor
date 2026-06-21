/**
 * Session-lifecycle reducer — spec §8.2, §11.4, §12, §12.1.
 *
 * Pure, same contract as `reduce`. Three branches:
 *
 *  `session_started`
 *   - `meta.role` MUST equal `checkpoint.current_role` (§12 invariant).
 *   - `checkpoint.active_role_session` MUST be `null` (no overlapping session).
 *   - Sets `active_role_session = { id: meta.sessionId, role: meta.role,
 *     session_file: meta.sessionFile }`.
 *   - Emits a `session_started` record with NO usage, NO failure_reason.
 *   - Does NOT change `current_role` or `visit_count` (these belong to
 *     `reduce`). Model retry (§8.2) re-issues `session_started` for the
 *     same role with a fresh session id; the checkpoint changes only in
 *     `active_role_session.id` — not `current_role`, not `visit_count`.
 *
 *  `session_ended` / `session_failed` (terminals)
 *   - `meta.sessionId` and `meta.role` MUST match `checkpoint.active_role_session`
 *     (lifecycle identity is checked against the live session, §12 verbatim).
 *   - Clears `active_role_session`.
 *   - Emits the record with `usage` (terminals cost, §11.4), `visit_index`,
 *     `model`, `parent_session`, and `failure_reason` (failed only).
 *   - Does NOT require `meta.role === checkpoint.current_role`, because the
 *     canonical accepted-handoff path (§12.1) calls `reduce` first and may
 *     have moved `current_role` to the next role before this terminal fires.
 *     Asserting terminal `meta.role === checkpoint.current_role` would be
 *     wrong: it would reject the legal canonical sequence.
 *
 * Host MUST call `reduce` and `reduceLifecycle` in the §12.1 order; any
 * other order corrupts the checkpoint. The composition test
 * (`tests/core/reducer-composition.test.ts`) pins the seam before the host
 * is built.
 *
 * Phase 3 extension: meta carries `usage`, `visit_index`, `parent_session`,
 * and `model_effort` (documented on `ReduceLifecycleMeta` in ./types.ts).
 * These come from the host's record log, not the checkpoint. The reducer is
 * the single-source-of-truth plumb: it doesn't compute visit_index (it can't,
 * without records) and doesn't inspect usage content (seam/§3).
 *
 * Host-agnostic. No pi imports, no I/O.
 */

import type {
  ActiveRoleSession,
  Checkpoint,
  MachineDefinition,
  ReduceLifecycleMeta,
  Role,
  SessionLifecycleEvent,
} from "./types.js";

// ─── Error type (§12 invariant / identity mismatch) ─────────────────────

/**
 * §12 invariant violation in `reduceLifecycle` (mismatched `meta.role` /
 * `current_role` for `session_started`, or mismatched `meta.sessionId` /
 * `meta.role` against `active_role_session` for terminals).
 *
 * Thrown — not returned as a rejection — because by construction these
 * are host logic bugs, not legal lifecycle events. Silently trusting a
 * mismatched identity would let a host bug mis-evaluate lifecycle state.
 */
export class ReduceLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReduceLifecycleError";
  }
}

// ─── Public reducer ────────────────────────────────────────────────────

export function reduceLifecycle(
  checkpoint: Checkpoint,
  lifecycle: "session_started" | "session_ended" | "session_failed",
  _def: MachineDefinition,
  meta: ReduceLifecycleMeta,
): { checkpoint: Checkpoint; record: SessionLifecycleEvent } {
  if (lifecycle === "session_started") {
    return sessionStarted(checkpoint, meta);
  }
  return sessionTerminal(checkpoint, lifecycle, meta);
}

// ─── session_started ───────────────────────────────────────────────────

function sessionStarted(
  checkpoint: Checkpoint,
  meta: ReduceLifecycleMeta,
): { checkpoint: Checkpoint; record: SessionLifecycleEvent } {
  // §12 invariant: meta.role must match the current role.
  if (meta.role !== checkpoint.current_role) {
    throw new ReduceLifecycleError(
      `session_started: meta.role '${meta.role}' does not match checkpoint.current_role '${String(
        checkpoint.current_role,
      )}' (spec §12)`,
    );
  }

  // §11.4 / §12: no overlapping active session allowed.
  if (checkpoint.active_role_session !== null) {
    throw new ReduceLifecycleError(
      `session_started: a role session is already active (id='${checkpoint.active_role_session.id}', role='${checkpoint.active_role_session.role}'); session_started requires no active session`,
    );
  }

  const active_role_session: ActiveRoleSession = {
    id: meta.sessionId,
    role: meta.role,
    session_file: meta.sessionFile,
  };

  const newCheckpoint: Checkpoint = Object.freeze({
    run_id: checkpoint.run_id,
    manifest_version: checkpoint.manifest_version,
    current_role: checkpoint.current_role, // unchanged
    visit_count: checkpoint.visit_count, // unchanged
    active_role_session: Object.freeze(active_role_session) as ActiveRoleSession,
    updated_at: meta.ts,
  }) as Checkpoint;

  const record: SessionLifecycleEvent = {
    type: "session_started",
    run_id: checkpoint.run_id,
    role: meta.role,
    visit_index: meta.visit_index,
    state: checkpoint.current_role,
    model: meta.model ?? null,
    ...(meta.model_effort !== undefined ? { model_effort: meta.model_effort } : {}),
    session_file: meta.sessionFile,
    parent_session: meta.parent_session,
    // intentionally NO usage / failure_reason on session_started (§11.4)
    ts: meta.ts,
  };

  return { checkpoint: newCheckpoint, record };
}

// ─── session_ended / session_failed ─────────────────────────────────────

function sessionTerminal(
  checkpoint: Checkpoint,
  lifecycle: "session_ended" | "session_failed",
  meta: ReduceLifecycleMeta,
): { checkpoint: Checkpoint; record: SessionLifecycleEvent } {
  // §12: lifecycle identity is checked against `active_role_session`,
  // NOT against `current_role`. The canonical §12.1 path has already
  // moved `current_role` to the next role by the time a terminal fires,
  // so asserting meta.role === current_role would reject the legal
  // canonical sequence. The match is on the live session's identity.
  const active = checkpoint.active_role_session;
  if (active === null) {
    throw new ReduceLifecycleError(
      `${lifecycle}: no active role session to terminate (active_role_session is null)`,
    );
  }
  if (meta.sessionId !== active.id) {
    throw new ReduceLifecycleError(
      `${lifecycle}: meta.sessionId '${meta.sessionId}' does not match active_role_session.id '${active.id}' (spec §12)`,
    );
  }
  const activeRole: Role = active.role;
  if (meta.role !== activeRole) {
    throw new ReduceLifecycleError(
      `${lifecycle}: meta.role '${meta.role}' does not match active_role_session.role '${activeRole}' (spec §12)`,
    );
  }

  // §11.4: usage is REQUIRED on both terminals (both cost). The host
  // MUST supply it. A terminal without usage breaks reconciliation
  // (§11.4 cache-caveshot caveat, §11.6 roll-up).
  if (meta.usage === undefined) {
    throw new ReduceLifecycleError(
      `${lifecycle}: meta.usage is required on terminal lifecycle events (§11.4)`,
    );
  }

  // §11.4: failure_reason only on session_failed. The host supplies it;
  // the reducer plumbs it. We do not default or synthesize.
  const failureReason = lifecycle === "session_failed" ? meta.failureReason : undefined;

  const newCheckpoint: Checkpoint = Object.freeze({
    run_id: checkpoint.run_id,
    manifest_version: checkpoint.manifest_version,
    // current_role and visit_count are unchanged — the terminal is for
    // the previously-active session; current_role may already point to
    // the next role (canonical §12.1 path) or still to the same role
    // (rejected-handoff retry / model-retry scenarios).
    current_role: checkpoint.current_role,
    visit_count: checkpoint.visit_count,
    active_role_session: null,
    updated_at: meta.ts,
  }) as Checkpoint;

  const record: SessionLifecycleEvent = {
    type: lifecycle,
    run_id: checkpoint.run_id,
    role: meta.role,
    visit_index: meta.visit_index,
    state: checkpoint.current_role,
    model: meta.model ?? null,
    ...(meta.model_effort !== undefined ? { model_effort: meta.model_effort } : {}),
    session_file: meta.sessionFile,
    parent_session: meta.parent_session,
    usage: meta.usage,
    ...(failureReason !== undefined && { failure_reason: failureReason }),
    ts: meta.ts,
  };

  return { checkpoint: newCheckpoint, record };
}
