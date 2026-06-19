/**
 * Pure FSM types — spec §5, §7, §11, §12.
 *
 * Pure type module. No runtime logic. Implementation lives in:
 *   - reduce / reduceLifecycle       (Phase 2, Tasks 6–7)
 *   - createInitialCheckpoint        (Phase 2, Task 6)
 *   - declaredTargets / availableTargets (Phase 2, Task 5)
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
 */
export type TransitionResult =
  | {
      readonly kind: "accepted";
      readonly state: Role | "done";
      readonly effect: readonly Effect[];
      readonly record: TransitionAccepted;
    }
  | {
      readonly kind: "rejected";
      readonly state: Role | "done";
      readonly reason: RejectReason;
      readonly legal_targets: LegalTargets;
      readonly record: TransitionRejected;
    };

// ─── §12: Reducer + createInitialCheckpoint signatures ──────────────────
//
// Type-level signatures only. Implementations land in Phase 2 (Task 6)
// and Phase 3 (Tasks 9–10). `declare function` keeps this module
// runtime-empty while still giving downstream code a real signature to
// import — the body arrives in Phase 2.

/**
 * §12 `reduce` signature. Pure: no I/O, no ambient config. The declared
 * role set + caps come from `def` (pinned manifest snapshot, §12). The
 * reducer asserts `meta.role === checkpoint.current_role`; a mismatch
 * is rejected/throws rather than silently trusted.
 */
export declare function reduce(
  checkpoint: Checkpoint,
  event: MachineEvent,
  def: MachineDefinition,
  meta: { readonly role: Role; readonly sessionFile: string; readonly ts: number },
): TransitionResult;

/**
 * §12 `reduceLifecycle` signature. Same purity contract. Never advances
 * `current_role` — only `reduce` does. Lifecycle identity is checked
 * against `checkpoint.active_role_session`, not blindly against
 * `current_role` (§12).
 */
export declare function reduceLifecycle(
  checkpoint: Checkpoint,
  lifecycle: "session_started" | "session_ended" | "session_failed",
  def: MachineDefinition,
  meta: {
    readonly role: Role;
    readonly sessionId: string;
    readonly sessionFile: string;
    readonly model?: string | null;
    readonly failureReason?: string;
    readonly ts: number;
  },
): { readonly checkpoint: Checkpoint; readonly record: SessionLifecycleEvent };

/**
 * §12 `createInitialCheckpoint` signature. Implementation lands in
 * Phase 2 (Task 6). The canonical way to mint a Checkpoint; the host
 * must not hand-roll one (otherwise crash-resume diverges).
 */
export declare function createInitialCheckpoint(def: MachineDefinition): Checkpoint;

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
