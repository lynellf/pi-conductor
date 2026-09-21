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

// ─── Host-agnostic model effort ────────────────────────────────────────

/** pi thinking level / model effort token (§8.1, manifest layer). */
export type ModelEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** conductor-owned default effort when a manifest omits it (§8.1). */
export const DEFAULT_MODEL_EFFORT: ModelEffort = "medium";

// ─── §12: Pinned manifest snapshot ──────────────────────────────────────

/**
 * Issue #135: opt-in, strict policy for bounded host-observed handoff evidence.
 *
 * All four bounds are required and range-checked (`max_dirty_paths ≤ 64`,
 * `max_commands ≤ 16`, `max_command_identity_chars ≤ 512`,
 * `max_output_head_bytes ≤ 1024`). The block is a strict opt-in gate: its
 * presence enables collection, its absence leaves the continuity seed
 * byte-identical to the legacy v2 seed (issue-135 host-handoff-evidence plan).
 */
export interface HandoffEvidencePolicy {
  /** Max dirty paths captured per git snapshot. */
  readonly max_dirty_paths: number;
  /** Max command executions captured per handoff, most recent first. */
  readonly max_commands: number;
  /** Max characters per redacted, single-line command identity. */
  readonly max_command_identity_chars: number;
  /** Max bytes per redacted output head, in addition to the sha256 digest. */
  readonly max_output_head_bytes: number;
}

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
  /** Authorized completion requesters; null preserves legacy ungated ending. */
  readonly end_request_roles: readonly Role[] | null;
  /**
   * Issue #135: opt-in, bounded host-observed handoff evidence policy, or `null`
   * when the manifest omits the `handoff_evidence:` block (disabled: the
   * continuity seed stays byte-identical to the legacy v2 seed). Pinned at
   * run-start from the manifest, like the rest of `MachineDefinition`.
   */
  readonly handoff_evidence: HandoffEvidencePolicy | null;
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
  | {
      readonly type: "handoff";
      readonly target_role: Role;
      readonly request_end: boolean;
      readonly payload: unknown;
    }
  | {
      readonly type: "end";
      readonly authority: "role" | "run_cost_cap";
      readonly payload: unknown;
    };

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
  readonly end_request: EndRequest | null;
  readonly active_role_session: ActiveRoleSession | null;
  readonly updated_at: number;
}

/** Single-use worker authorization for the next orchestrator end decision. */
export interface EndRequest {
  readonly role: Role;
  readonly session_file: string;
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
  | "end_request_unauthorized"
  | "end_request_required"
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
 * Host-generated pointer to the session that produced a handoff.
 * The reducer treats it as opaque record metadata; the host is the only
 * writer and the recipient's context tool is the only reader (issue #14).
 */
export interface HandoffContextRef {
  readonly run_id: string;
  readonly source_role: Role;
  readonly source_session_file: string;
}

/** Exactly bound visible prose retained by the v2 host control envelope. */
export interface ReportedContextV2 {
  readonly text: string;
  readonly utf8_bytes: number;
  readonly truncated: boolean;
}

/** Host-owned mechanical and model-reported task context for a v2 recipient. */
export interface RecipientTaskContextV2 {
  readonly host_directive: string;
  readonly reported_objective?: string;
  readonly reported_action?: string;
  readonly reported_context?: ReportedContextV2;
}

/** Durable host-generated control envelope for a v2 accepted handoff. */
export interface AcceptedControlV2 {
  readonly schema_version: 2;
  readonly direction: "dispatch" | "return";
  readonly recipient_role: string;
  readonly task: RecipientTaskContextV2;
  readonly reported_hints: {
    readonly summary?: string;
    readonly reason?: string;
    readonly verification?: readonly string[];
  };
  readonly ignored_hint_fields: readonly string[];
  readonly utf8_bytes: number;
}

/** Host-owned durable copy of a recipient-bound accepted handoff (issue #110). */
export interface AcceptedHandoffEnvelope {
  readonly schema_version: 1;
  readonly recipient_role: Role;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly utf8_bytes: number;
  /**
   * Spec §8: additive host-authored evidence-resolution metadata for the
   * durable continuity packet, when present. Absent on legacy envelopes
   * without continuity. Status is `verified | declared | missing`; the host
   * is the sole source. Model-supplied resolution status is never trusted.
   */
  readonly continuity_evidence?: readonly ContinuityEvidenceResolution[];
  /**
   * Spec §8: UTF-8 byte length of the normalized continuity packet when
   * present. Absent on legacy envelopes without continuity. Measured
   * deterministically from JSON-safe normalized content.
   */
  readonly continuity_packet_utf8_bytes?: number;
}

/** Host-derived resolution status for a single evidence reference (spec §7). */
export type ContinuityEvidenceStatus = "verified" | "declared" | "missing";

/**
 * Spec §7: host-authored evidence-resolution metadata, attached alongside
 * the normalized packet on an accepted envelope. The model cannot supply
 * or override this metadata; it is derived per-resolution with a stable
 * diagnostic code so failures are recoverable.
 */
export interface ContinuityEvidenceResolution {
  /**
   * Stable identifier the model uses to point at this evidence on the
   * packet (e.g. its array index, item id + reference tuple). The host
   * surfaces this unchanged in the persisted record.
   */
  readonly ref_key: string;
  readonly kind: string;
  readonly status: ContinuityEvidenceStatus;
  /** Stable diagnostic code (e.g. `tool_execution_not_found`). */
  readonly diagnostic?: string;
  /** Free resolution message surfaced to operators; safe to render. */
  readonly message?: string;
  /** Optional resolved path for repository evidence. */
  readonly resolved_path?: string;
  /** Optional resolved head OID when the host resolved a ref. */
  readonly resolved_commit?: string;
}

/**
 * §11.2: accepted transition record. Shape-validated at the seam; the
 * full validated payload is normally transient. Role-emitted handoffs may
 * carry the host-owned `accepted_handoff` snapshot for durable recipient
 * delivery (issue #110); older and synthesized records omit it.
 */
export interface TransitionAccepted {
  readonly type: "transition_accepted";
  readonly run_id: string;
  readonly from: Role | "done";
  readonly to: Role | "done";
  readonly event: "handoff" | "end";
  readonly target_role: Role | null;
  readonly request_end: boolean;
  readonly end_authority: "role" | "run_cost_cap" | null;
  readonly end_requested_by: Role | null;
  readonly role: Role;
  readonly suggests_next: Role | null;
  readonly payload_summary: PayloadSummary;
  readonly guard: string | null;
  readonly effect: readonly Effect[];
  readonly session_file: string;
  /** Host-generated predecessor pointer; absent in older persisted records. */
  readonly context_ref?: HandoffContextRef | null;
  /** Additive recipient-bound handoff transport; absent is legacy-compatible. */
  readonly accepted_handoff?: AcceptedHandoffEnvelope;
  /** Host-generated v2 recipient control envelope; absent on v1 records. */
  readonly accepted_control?: AcceptedControlV2;
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
  readonly request_end: boolean;
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
 *  - `model_effort?: ModelEffort` — the conductor-selected thinking
 *    level for the session (§8.1). Host reads it from the manifest and
 *    defaults omitted efforts to `medium`.
 *  - `workspace?: SessionWorkspaceDescriptor` — immutable, host-owned
 *    workspace metadata for `session_started` only (Issue #48 R2b).
 */
export interface ReduceLifecycleMeta {
  readonly role: Role;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly model?: string | null;
  readonly model_effort?: ModelEffort;
  readonly failureReason?: string;
  /** Upstream detail for a terminal failure; the reason remains the stable discriminator. */
  readonly failureDetail?: string;
  readonly ts: number;
  // Phase 3 extensions (see JSDoc above).
  readonly usage?: UsageRecord;
  readonly visit_index: number;
  readonly parent_session: string | null;
  /** Host-owned metadata emitted only on `session_started` (Issue #48 R2b). */
  readonly workspace?: SessionWorkspaceDescriptor;
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

/** Issue #48 R1: guarantees available from this host. */
export type WorkspaceGuarantee = "none" | "confined";

/**
 * Issue #48 §9: additive workspace descriptor on `session_started`.
 *
 * Present only when the role was spawned into an isolated workspace
 * (backend ≠ shared). Absent for shared-mode roles.
 */
export interface SessionWorkspaceDescriptor {
  readonly backend: string;
  readonly guarantee: WorkspaceGuarantee;
  /** Absolute path to the host-provisioned worktree or copy. */
  readonly path_or_image: string;
}

/** §11.4: fields shared by every role-session lifecycle record. */
interface SessionLifecycleEventBase {
  readonly run_id: string;
  readonly role: Role;
  readonly visit_index: number;
  readonly state: Role | "done";
  readonly model: string | null;
  readonly model_effort?: ModelEffort;
  readonly session_file: string;
  readonly parent_session: string | null;
  readonly usage?: UsageRecord;
  readonly failure_reason?: string;
  /** Optional provider/host diagnostic for a terminal failure (§11.4). */
  readonly failure_detail?: string;
  readonly ts: number;
}

/** §11.4: lifecycle record emitted when a role session begins. */
export interface SessionStartedEvent extends SessionLifecycleEventBase {
  readonly type: "session_started";
  /** Issue #48: optional immutable descriptor for this session's workspace. */
  readonly workspace?: SessionWorkspaceDescriptor;
}

/** §11.4: lifecycle record emitted when a role session ends cleanly. */
export interface SessionEndedEvent extends SessionLifecycleEventBase {
  readonly type: "session_ended";
  /** Issue #48: workspace metadata belongs exclusively to `session_started`. */
  readonly workspace?: never;
}

/** §11.4: lifecycle record emitted when a role session fails. */
export interface SessionFailedEvent extends SessionLifecycleEventBase {
  readonly type: "session_failed";
  /** Issue #48: workspace metadata belongs exclusively to `session_started`. */
  readonly workspace?: never;
}

/** §11.4: lifecycle record for a single role-session invocation. */
export type SessionLifecycleEvent = SessionStartedEvent | SessionEndedEvent | SessionFailedEvent;

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

/** Issue #16: driver-issued same-model retry record. */
export interface ModelRetry {
  readonly type: "model_retry";
  readonly run_id: string;
  readonly role: Role;
  readonly model: string | null;
  readonly attempt: number;
  readonly max_retries: number;
  readonly reason: "model_error";
  readonly delay_ms: number;
  readonly session_file: string;
  readonly ts: number;
}
