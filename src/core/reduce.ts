/**
 * Pure FSM reducer — spec §7.2, §7.3, §7.4, §12.
 *
 * Two pure functions:
 *   - `createInitialCheckpoint(def)` — the canonical way to mint the
 *     run-start Checkpoint (§12). The host MUST use this; hand-rolling
 *     the initial checkpoint would diverge from crash-resume (§11.1).
 *   - `reduce(checkpoint, event, def, meta)` — the transition reducer.
 *     Returns either `accepted` (state advanced, effect recorded) or
 *     `rejected` (state unchanged, `legal_targets` surfaced for retry).
 *
 * Determinism (§12): same `(checkpoint, event, def, meta)` always yields
 * the same `state` / `effect` / `reason` / `legal_targets` / record-shape,
 * modulo `meta.ts` (which flows into `record.ts` as the only divergence
 * the spec allows).
 *
 * Host-agnostic: no pi imports, no I/O, no ambient config. The declared
 * role set + caps come ONLY from `def` (pinned manifest snapshot, §12).
 *
 * Invariant assertion (§12): `meta.role === checkpoint.current_role`.
 * Mismatch throws a typed `ReduceInvariantError` — this is by construction
 * a host logic bug, not a legal rejection. Silently trusting a mismatched
 * `meta.role` would let a host bug mis-evaluate role-keyed transitions.
 *
 * `payload_summary` (§11.2): the reducer never inspects payload content
 * (§3 / §12). It emits a structural placeholder `{ field_names: [] }`;
 * the Phase 3 seam/host enriches the record with the real field_names
 * (extracted from the validated payload) before persistence. Keeping
 * `meta` minimal (§12 verbatim) and the reducer payload-blind.
 *
 * `suggests_next` (§8.3): a safe structural pass extracts a string
 * `suggests_next` from the payload if present; otherwise `null`. This is
 * observability metadata, not legality — the host seam is the validator.
 */

import { availableTargets } from "./targets.js";
import type {
  Checkpoint,
  Effect,
  EndRequest,
  LegalTargets,
  MachineDefinition,
  MachineEvent,
  PayloadSummary,
  RejectReason,
  Role,
  TransitionAccepted,
  TransitionRejected,
  TransitionResult,
} from "./types.js";

// ─── Invariant error ───────────────────────────────────────────────────

/**
 * §12 invariant violation: `meta.role !== checkpoint.current_role`.
 *
 * Thrown (not returned as a rejection) because this is by construction a
 * host logic bug — there is no legal reduction when the host says "this
 * event came from role X" while the checkpoint says "the current role is Y."
 * The reducer MUST NOT silently trust a mismatched `meta.role`; that would
 * let a host bug mis-evaluate role-keyed transitions.
 */
export class ReduceInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReduceInvariantError";
  }
}

// ─── §12: createInitialCheckpoint ──────────────────────────────────────

/**
 * Mint the canonical run-start `Checkpoint` (§12).
 *
 * - `run_id` is a fresh UUID; the host reads it back from this record
 *   rather than generating it separately (§11.9).
 * - `visit_count` is zero for every declared worker (no visits yet).
 * - `current_role` is the orchestrator (the hub is the entry point, §6).
 * - `active_role_session` is `null` (no session has begun yet; set on
 *   `session_started`, cleared on `session_ended` / `session_failed`).
 * - `updated_at` is the wall-clock epoch ms at run-start.
 *
 * The returned object is frozen to defend against accidental mutation
 * downstream. Subsequent `reduce` calls return fresh objects.
 */
export function createInitialCheckpoint(def: MachineDefinition): Checkpoint {
  const visit_count: Record<Role, number> = {};
  for (const w of def.workers) {
    visit_count[w] = 0;
  }
  return Object.freeze({
    run_id: crypto.randomUUID(),
    manifest_version: def.manifest_version,
    current_role: def.orchestrator,
    visit_count: Object.freeze(visit_count),
    end_request: null,
    active_role_session: null,
    updated_at: Date.now(),
  }) as Checkpoint;
}

// ─── §12: reduce ───────────────────────────────────────────────────────

/**
 * §12 `reduce`. Pure transition reducer.
 *
 * Returns `accepted` when `(state, event)` is a legal pair and any
 * required guard passes; `rejected` otherwise. `state` on the result
 * is the post-transition state (the new `current_role` for `accepted`,
 * unchanged for `rejected`).
 *
 * The record fields (`record.from`, `record.to`, etc.) are documented
 * in §11.2 / §11.3.
 */
export function reduce(
  checkpoint: Checkpoint,
  event: MachineEvent,
  def: MachineDefinition,
  meta: { readonly role: Role; readonly sessionFile: string; readonly ts: number },
): TransitionResult {
  // §12 invariant. Mismatch → throw (not a legal rejection).
  if (meta.role !== checkpoint.current_role) {
    throw new ReduceInvariantError(
      `meta.role '${meta.role}' does not match checkpoint.current_role '${String(checkpoint.current_role)}' (spec §12)`,
    );
  }

  // §7.2: from "done" — everything is rejected (terminal).
  if (checkpoint.current_role === "done") {
    return reject(checkpoint, event, def, meta, "illegal_event");
  }

  // Dispatch on the active role's branch of the uniform table (§7.2).
  if (checkpoint.current_role === def.orchestrator) {
    return reduceFromOrchestrator(checkpoint, event, def, meta);
  }
  return reduceFromWorker(checkpoint, event, def, meta);
}

// ─── Dispatch: orchestrator ────────────────────────────────────────────

function reduceFromOrchestrator(
  checkpoint: Checkpoint,
  event: MachineEvent,
  def: MachineDefinition,
  meta: { readonly role: Role; readonly sessionFile: string; readonly ts: number },
): TransitionResult {
  // A driver-owned cost-cap close bypasses normal end-request gating.
  if (event.type === "end") {
    if (
      event.authority === "role" &&
      def.end_request_roles !== null &&
      (checkpoint.end_request ?? null) === null
    ) {
      return reject(checkpoint, event, def, meta, "end_request_required");
    }
    return accept(checkpoint, event, def, meta, {
      from: def.orchestrator,
      to: "done",
      target_role: null,
      effects: [],
      guard: null,
      end_request: null,
    });
  }

  // handoff → target: must be a declared worker; visit cap must allow it.
  if (event.type === "handoff") {
    const target = event.target_role;

    // §7.3: handoff → undeclared role is illegal.
    if (!def.workers.includes(target)) {
      return reject(checkpoint, event, def, meta, "illegal_event");
    }

    // §7.4: visit cap guard. The cap is config data from `def.max_visits`,
    // never read from ambient state.
    const cap = def.max_visits[target];
    if (cap === undefined) {
      // Defensive: validateManifest already enforces this. A missing cap
      // means a corrupted `def`, which the host must not have produced.
      throw new ReduceInvariantError(
        `worker '${target}' has no max_visits in def (should have been caught by validateManifest)`,
      );
    }
    const count = checkpoint.visit_count[target] ?? 0;
    if (count >= cap) {
      return reject(checkpoint, event, def, meta, "guard_failed");
    }

    // Accepted: increment visit_count, record effect + guard string.
    return accept(checkpoint, event, def, meta, {
      from: def.orchestrator,
      to: target,
      target_role: target,
      effects: [`visit_count[${target}] += 1`],
      guard: `visit_count[${target}] < max_visits[${target}]`,
      end_request: null,
    });
  }

  // Unreachable: MachineEvent's two variants are exhaustive.
  return reject(checkpoint, event, def, meta, "illegal_event");
}

// ─── Dispatch: worker ──────────────────────────────────────────────────

function reduceFromWorker(
  checkpoint: Checkpoint,
  event: MachineEvent,
  def: MachineDefinition,
  meta: { readonly role: Role; readonly sessionFile: string; readonly ts: number },
): TransitionResult {
  // §7.2 / §7.3: a worker's only legal target is the orchestrator.
  // end from a worker is illegal; handoff to a non-orchestrator role
  // (including another worker) is illegal.
  if (event.type === "handoff" && event.target_role === def.orchestrator) {
    if (event.request_end && !def.end_request_roles?.includes(checkpoint.current_role)) {
      return reject(checkpoint, event, def, meta, "end_request_unauthorized");
    }
    const endRequest: EndRequest | null = event.request_end
      ? Object.freeze({ role: checkpoint.current_role, session_file: meta.sessionFile })
      : (checkpoint.end_request ?? null);
    return accept(checkpoint, event, def, meta, {
      from: checkpoint.current_role,
      to: def.orchestrator,
      target_role: def.orchestrator,
      effects: [], // no visit_count change (orchestrator has no cap)
      guard: null,
      end_request: endRequest,
    });
  }
  return reject(checkpoint, event, def, meta, "illegal_event");
}

// ─── Build helpers ─────────────────────────────────────────────────────

interface AcceptPlan {
  readonly from: Role | "done";
  readonly to: Role | "done";
  readonly target_role: Role | null;
  readonly effects: readonly Effect[];
  readonly guard: string | null;
  readonly end_request: EndRequest | null;
}

function accept(
  checkpoint: Checkpoint,
  event: MachineEvent,
  def: MachineDefinition,
  meta: { readonly role: Role; readonly sessionFile: string; readonly ts: number },
  plan: AcceptPlan,
): TransitionResult {
  // Apply visit_count effect if the plan says so (orchestrator → worker
  // is the only case that mutates visit_count in Phase 2). The post-
  // transition checkpoint normalizes visit_count to include every
  // declared worker (def.workers), with 0 for any the input omitted —
  // matches createInitialCheckpoint's contract and makes `Record<Role,
  // number>` a true invariant rather than a sparse convention.
  const visit_countBase: Record<Role, number> = {};
  for (const w of def.workers) {
    visit_countBase[w] = checkpoint.visit_count[w] ?? 0;
  }
  for (const eff of plan.effects) {
    const m = eff.match(/^visit_count\[(.+)\] \+= 1$/);
    if (m?.[1]) {
      const role = m[1];
      visit_countBase[role] = (visit_countBase[role] ?? 0) + 1;
    }
  }
  const visit_count = Object.freeze(visit_countBase);

  const newCheckpoint: Checkpoint = Object.freeze({
    run_id: checkpoint.run_id,
    manifest_version: checkpoint.manifest_version,
    current_role: plan.to,
    visit_count,
    end_request: plan.end_request,
    // active_role_session is unchanged by reduce; reduceLifecycle owns it.
    active_role_session: checkpoint.active_role_session,
    updated_at: meta.ts,
  }) as Checkpoint;

  const record: TransitionAccepted = {
    type: "transition_accepted",
    run_id: checkpoint.run_id,
    from: plan.from,
    to: plan.to,
    event: event.type,
    target_role: plan.target_role,
    request_end: event.type === "handoff" ? event.request_end : false,
    end_authority: event.type === "end" ? event.authority : null,
    end_requested_by:
      event.type === "end" && event.authority === "role"
        ? (checkpoint.end_request?.role ?? null)
        : null,
    role: meta.role,
    suggests_next: extractSuggestsNext(event.payload),
    // Structural placeholder (§11.2). The Phase 3 seam enriches this
    // record with the real `field_names` (and a surfaced `reason`)
    // extracted from the shape-validated payload before persistence.
    payload_summary: PAYLOAD_SUMMARY_PLACEHOLDER,
    guard: plan.guard,
    effect: plan.effects,
    session_file: meta.sessionFile,
    ts: meta.ts,
  };

  return {
    kind: "accepted",
    state: plan.to,
    checkpoint: newCheckpoint,
    effect: plan.effects,
    record,
  };
}

function reject(
  checkpoint: Checkpoint,
  event: MachineEvent,
  def: MachineDefinition,
  meta: { readonly role: Role; readonly sessionFile: string; readonly ts: number },
  reason: RejectReason,
): TransitionResult {
  // legal_targets for retry guidance: cap-aware (§11.3).
  const legal_targets: LegalTargets = availableTargets(checkpoint, def);

  // Rejected records carry the event shape as the reducer saw it. The
  // `<malformed>` variant (§11.3) is for records the host persists
  // directly without going through `reduce` (e.g. a capture-buffer entry
  // that failed seam validation); it never reaches this function.
  const eventField: TransitionRejected["event"] = event.type;
  const target_role: Role | null = event.type === "handoff" ? event.target_role : null;

  const record: TransitionRejected = {
    type: "transition_rejected",
    run_id: checkpoint.run_id,
    state: checkpoint.current_role,
    event: eventField,
    target_role,
    request_end: event.type === "handoff" ? event.request_end : false,
    reason,
    legal_targets,
    role: meta.role,
    session_file: meta.sessionFile,
    ts: meta.ts,
  };

  // On reject the state didn't change, but the snapshot is fresh
  // (§11.1: every reduce call produces a new full snapshot). visit_count
  // is normalized to the same shape as the accepted branch so the host
  // can persist either without special-casing.
  const visit_countBase: Record<Role, number> = {};
  for (const w of def.workers) {
    visit_countBase[w] = checkpoint.visit_count[w] ?? 0;
  }
  const sameCheckpoint: Checkpoint = Object.freeze({
    run_id: checkpoint.run_id,
    manifest_version: checkpoint.manifest_version,
    current_role: checkpoint.current_role,
    visit_count: Object.freeze(visit_countBase),
    end_request: checkpoint.end_request ?? null,
    active_role_session: checkpoint.active_role_session,
    updated_at: meta.ts,
  }) as Checkpoint;

  return {
    kind: "rejected",
    state: checkpoint.current_role,
    checkpoint: sameCheckpoint,
    reason,
    legal_targets,
    record,
  };
}

// ─── Payload accessors (structural-only, non-branching) ────────────────

/**
 * §11.2 placeholder for `payload_summary` on accepted records.
 *
 * The reducer never inspects payload content (§3 / §12). The Phase 3
 * seam replaces this object with the real summary (built from the
 * validated payload's `field_names`, plus surfaced `reason` /
 * `suggests_next`) before persisting the record.
 */
const PAYLOAD_SUMMARY_PLACEHOLDER: PayloadSummary = Object.freeze({
  field_names: Object.freeze([]),
}) as PayloadSummary;

/**
 * §8.3 / §11.2: surface a string `suggests_next` from the payload if
 * present, otherwise null. Structural pass only — the host seam is
 * the validator; this function does not assert semantics.
 */
function extractSuggestsNext(payload: unknown): Role | null {
  if (typeof payload !== "object" || payload === null) return null;
  const v = (payload as Record<string, unknown>).suggests_next;
  return typeof v === "string" ? v : null;
}
