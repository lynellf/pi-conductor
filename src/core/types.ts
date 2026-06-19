/**
 * Pure FSM types — spec §5, §7, §11, §12.
 *
 * Pure type module. No runtime logic. Implementation lives in:
 *   - reduce / createInitialCheckpoint   (Phase 2, Tasks 6–7: src/core/reduce.ts)
 *   - reduceLifecycle                    (Phase 3, Tasks 9–10)
 *   - declaredTargets / availableTargets (Phase 2, Task 5:  src/core/targets.ts)
 *
 * Host-agnostic: this file must not import the pi SDK. Enforced by
 * tests/grep-guard.test.ts (which scans source as text, so the package
 * name string must not appear anywhere in this file).
 */

// ─── §7.1: Roles and states ─────────────────────────────────────────────

/** A role name declared in the manifest. */
export type Role = string;

/** Machine state = the currently active role, plus the terminal marker. */
export type State = Role | "done";

// ─── §12: Pinned manifest snapshot ──────────────────────────────────────

/**
 * Pinned, immutable snapshot of the manifest config the reducer consumes.
 * Derived once at run-start from the pinned manifest version (§10/§12).
 *
 * The declared role set and per-worker `max_visits` come ONLY from `def`,
 * never from ambient config or imports — that is what makes the reducer
 * deterministic given `(checkpoint, event, def)`.
 */
export interface MachineDefinition {
  /** Pinned manifest version (string form of the manifest's integer `version:`). */
  readonly manifest_version: string;
  /** The one role with `is_orchestrator: true` in the manifest. */
  readonly orchestrator: Role;
  /** Declared worker roles (every role in the manifest that is not the orchestrator). */
  readonly workers: readonly Role[];
  /** Per-worker visit cap (finite), keyed by worker role. §7.4. */
  readonly max_visits: Readonly<Record<Role, number>>;
}

// ─── §5.1, §12: Machine events ──────────────────────────────────────────

/**
 * Role-issued machine event. The reducer's only transition input.
 *
 * `payload: unknown` is deliberate: the reducer never branches on payload
 * content (§3/§4 — semantic adequacy is the orchestrator's job, not the
 * machine's). Payload shape validation lives at the seam (host), not here.
 */
export type MachineEvent =
  | { readonly type: "handoff"; readonly target_role: Role; readonly payload: unknown }
  | { readonly type: "end"; readonly payload: unknown };

// ─── §11.1: Checkpoint record ───────────────────────────────────────────

/**
 * The machine's persisted state. Snapshot-appended per transition; never
 * mutated in place. On crash, resume reads the latest snapshot for
 * `run_id` from the host's append-only log (§11.1).
 */
export interface Checkpoint {
  readonly run_id: string;
  readonly manifest_version: string;
  readonly current_role: Role | "done";
  readonly visit_count: Readonly<Record<Role, number>>;
  readonly active_role_session: ActiveRoleSession | null;
  readonly updated_at: number;
}

/** Live role session reference held on the checkpoint while a session runs. */
export interface ActiveRoleSession {
  readonly id: string;
  readonly role: Role;
  readonly session_file: string;
}

// ─── §11.2, §11.3: Transition records ───────────────────────────────────

/** Free-form effect descriptor emitted by accepted transitions. */
export type Effect = string;

/**
 * Rejection reason vocabulary. The reducer returns ONLY
 * `illegal_event | guard_failed` (§11.3); the breach values
 * (`schema_invalid | extra_emission | no_emission`) live here for
 * vocabulary sharing with `session_failed.failure_reason` and are
 * exercised in Phase 3 as lifecycle events, never as `transition_rejected`.
 */
export type RejectReason =
  | "illegal_event"
  | "guard_failed"
  | "schema_invalid"
  | "extra_emission"
  | "no_emission";

/** §11.2: stable structural fingerprint of the validated payload. */
export interface PayloadSummary {
  readonly reason?: string;
  readonly suggests_next?: Role | null;
  readonly field_names: readonly string[];
}

/**
 * §11.2: accepted transition record. Shape-validated at the seam; the
 * full validated payload is held by the host for seeding the next
 * session and is NOT part of this persisted record.
 */
export interface TransitionAccepted {
  readonly type: "transition_accepted";
  readonly run_id: string;
  readonly from: Role | "done";
  readonly to: Role | "done";
  readonly event: "handoff" | "end";
  readonly target_role: Role | null;
  readonly role: Role;
  readonly suggests_next: Role | null;
  readonly payload_summary: PayloadSummary;
  readonly guard: string | null;
  readonly effect: readonly Effect[];
  readonly session_file: string;
  readonly ts: number;
}

/** Legal retry targets surfaced on a rejected record. Cap-aware. */
export interface LegalTargets {
  readonly handoff: readonly Role[];
  readonly end: boolean;
}

/**
 * §11.3: rejected transition record. Records only legal-but-blocked
 * transitions. Contract breaches (§3) are `session_failed` lifecycle
 * events — the host persists exactly one record for a breach, never a
 * `transition_rejected`.
 */
export interface TransitionRejected {
  readonly type: "transition_rejected";
  readonly run_id: string;
  readonly state: Role | "done";
  readonly event: "handoff" | "end" | "<malformed>";
  readonly target_role: Role | null;
  readonly reason: RejectReason;
  readonly legal_targets: LegalTargets;
  readonly role: Role;
  readonly session_file: string;
  readonly ts: number;
}

// ─── §12: Reducer return shape ──────────────────────────────────────────

/**
 * §12 `TransitionResult` discriminant. `reduce` returns exactly one branch
 * per call. `state` is the post-transition state: for accepted, the new
 * `current_role`; for rejected, unchanged from the input checkpoint.
 *
 * `checkpoint` is the post-transition `Checkpoint` snapshot the host
 * persists (§11.1: "Each transition produces a new full checkpoint
 * snapshot"). For `accepted`, it reflects the new state (e.g. visit_count
 * increments, `current_role` advanced); for `rejected`, it is a fresh
 * object with the same content as the input (state unchanged) but a
 * fresh reference and `updated_at = meta.ts`. The reducer is the single
 * source of truth for the visit_count effect — duplicating that logic in
 * the host is the wrong seam.
 */
export type TransitionResult =
  | {
      readonly kind: "accepted";
      readonly state: Role | "done";
      readonly checkpoint: Checkpoint;
      readonly effect: readonly Effect[];
      readonly record: TransitionAccepted;
    }
  | {
      readonly kind: "rejected";
      readonly state: Role | "done";
      readonly checkpoint: Checkpoint;
      readonly reason: RejectReason;
      readonly legal_targets: LegalTargets;
      readonly record: TransitionRejected;
    };

// ─── §12: reduceLifecycle signature (Phase 3) ──────────────────────────
//
// Phase 2 implements `reduce` + `createInitialCheckpoint` (src/core/reduce.ts);
// `reduceLifecycle` lands in Phase 3 (Tasks 9–10). The `declare function`
// keeps the §12 signature importable today so downstream code and tests can
// reference it without a forward dependency.

/**
 * §12 `reduceLifecycle` signature. Pure, same contract as `reduce`.
 * Lifecycle identity is checked against `checkpoint.active_role_session`,
 * not blindly against `current_role` (§12, §12.1).
 *
 * **Phase 3 extension (documented deviation from the §12 sketch):**
 * the spec's sketched meta omits three fields that the §11.4 record shape
 * requires. The reducer cannot derive these from the checkpoint alone (it
 * has no record history; pure, §12), so the host supplies them:
 *
 *  - `usage?: UsageRecord` — present on `session_ended` / `session_failed`
 *    terminals (both terminals cost, §11.4). Omitted on `session_started`.
 *  - `visit_index: number` — the 1-based visit index of THIS role in the
 *    run. Host tracks session_started counts per role in its append-only
 *    log and supplies it; the reducer plumbs it onto the record.
 *    Records are "reconstructable from records alone" (§11.4) — the host
 *    is the single source of this number.
 *  - `parent_session: string | null` — the parent role session in the
 *    execution tree (§11.4). `null` for the first orchestrator session.
 *    Host knows the parent from its log.
 */
export interface ReduceLifecycleMeta {
  readonly role: Role;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly model?: string | null;
  readonly failureReason?: string;
  readonly ts: number;
  // Phase 3 extensions (see JSDoc above).
  readonly usage?: UsageRecord;
  readonly visit_index: number;
  readonly parent_session: string | null;
}

export declare function reduceLifecycle(
  checkpoint: Checkpoint,
  lifecycle: "session_started" | "session_ended" | "session_failed",
  def: MachineDefinition,
  meta: ReduceLifecycleMeta,
): { readonly checkpoint: Checkpoint; readonly record: SessionLifecycleEvent };

// ─── §11.4: Session-lifecycle record ───────────────────────────────────

/** §11.4: usage captured on `session_ended` AND `session_failed`. */
export interface UsageRecord {
  readonly input: number;
  readonly output: number;
  readonly cache_read: number;
  readonly cache_write: number;
  readonly tokens: number;
  readonly cost: number;
}

/** §11.4: lifecycle record for a single role-session invocation. */
export interface SessionLifecycleEvent {
  readonly type: "session_started" | "session_ended" | "session_failed";
  readonly run_id: string;
  readonly role: Role;
  readonly visit_index: number;
  readonly state: Role | "done";
  readonly model: string | null;
  readonly session_file: string;
  readonly parent_session: string | null;
  readonly usage?: UsageRecord;
  readonly failure_reason?: string;
  readonly ts: number;
}

// ─── §11.5: Model fallback record ───────────────────────────────────────

/** §11.5: driver-issued record; the machine does not track models. */
export interface ModelFallback {
  readonly type: "model_fallback";
  readonly run_id: string;
  readonly role: Role;
  readonly from_model: string | null;
  readonly to_model: string | null;
  readonly reason: string;
  readonly session_file: string;
  readonly ts: number;
}
