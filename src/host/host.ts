/**
 * Host interface — spec §8, §12, §15.3.
 *
 * The orchestration loop (Task 15) programs against this interface rather
 * than against pi SDK primitives directly. The Phase 4 SDK-backed Host
 * implementation lands in Task 15 (and lands the seam pieces in Task 14 +
 * the sealing wrapper in Task 15.5). Unit tests implement the same
 * interface as a fake, so the loop is testable without an LLM or SDK.
 *
 * **Why an interface?** Two reasons:
 *   1. The orchestration loop is the load-bearing correctness surface —
 *      canonical reducer call order (§12.1), post-emission sealing
 *      (§12.1), run-cap deferral (§11.7), capture-buffer enforcement
 *      (§11.3). It must be unit-testable with deterministic fakes.
 *   2. The SDK's `createAgentSession` is async, depends on real
 *      network/auth, and emits events asynchronously. We want the
 *      loop's *logic* — reducer ordering, capture-buffer contract,
 *      sealing — testable independently of those concerns.
 *
 * **Six methods (plan Task 13):**
 *   - `spawnRole`     — create a fresh role session (Task 15).
 *   - `captureUsage`  — read the session's aggregated usage (Task 17).
 *   - `persistRecord` — append to the run_id-keyed log (Task 13.5).
 *   - `seedRunMemory` — build the orchestrator's externalized memory
 *                       (Task 16.5).
 *   - `abortSession`  — signal the session to stop (Task 18 / §11.7).
 *   - `sealSession`   — flip the post-emission sealed flag (Task 15.5).
 *
 * `RoleSession.readCaptureBuffer()` is per-session host state — the
 * loop reads it after `prompt()` resolves. It is exposed on the
 * session (not as a Host method) because it is owned by the session
 * itself; both the tool wrappers and the loop touch it.
 *
 * **Host-agnosticism invariant** (spec §12, plan invariant 1): the
 * *interface* imports SDK types (`Model`, `ToolDefinition`,
 * `SessionManager`, `AgentSessionEvent`) as type-only references —
 * these are erased at compile time. The SDK runtime is never imported
 * by this module's compiled output. The grep-guard test scans source
 * text for the package name; this file is in `src/host/` which the
 * guard explicitly excludes.
 */

import type { Model } from "@earendil-works/pi-ai";
import type {
  AgentSessionEvent,
  SessionManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { RunMemory } from "../core/run-memory.js";
import type {
  Checkpoint,
  HandoffContextRef,
  MachineDefinition,
  ModelEffort,
  Role,
  UsageRecord,
} from "../core/types.js";
import type { PersistedRecord } from "../persistence/log.js";
import type { EmissionCapture } from "../seam/validate-emission.js";

// ─── RoleSession ───────────────────────────────────────────────────────

/**
 * A live role session returned by `Host.spawnRole`. The orchestration
 * loop reads its capture buffer after `prompt()` resolves, persists
 * lifecycle records keyed by its `sessionId`/`sessionFile`, and
 * delegates abort / seal / usage capture back to the Host.
 *
 * Lifecycle (Task 15, §12.1):
 *   1. Host.spawnRole(role, opts) → returns `RoleSession`.
 *   2. Loop calls `reduceLifecycle(session_started, { sessionId, sessionFile, role, … })`.
 *   3. Loop subscribes to events, captures usage, calls `prompt(seed)` and awaits.
 *   4. Loop reads `readCaptureBuffer()` — empty / >1 / schema-invalid → session_failed;
 *      exactly one valid → `validateEmission` + `reduce`.
 *   5. Loop persists the resulting record + checkpoint snapshot, then either
 *      calls `Host.spawnRole` for the next role or terminates.
 *   6. Loop calls `reduceLifecycle(session_ended | session_failed, …)`.
 *   7. `session.dispose()` when the session's resources are no longer needed.
 *
 * **Capture buffer ownership** (Task 14, §12.1): the buffer is
 * session-internal mutable state written by the host's `handoff`/`end`
 * tool wrappers and read by the loop after `prompt()` resolves. The
 * `readCaptureBuffer()` view is frozen to make accidental mutation a
 * runtime error.
 */
export interface RoleSession {
  /** The role this session was spawned for. */
  readonly role: Role;
  /** Host-allocated session id (used in `reduceLifecycle`, §11.4). */
  readonly sessionId: string;
  /** Path to the session log file (used in `reduceLifecycle`, §11.4). */
  readonly sessionFile: string;
  /**
   * The model this session ran on, as a `provider:id` string
   * (Task 17, §11.4). `null` for sessions that ran on the
   * system/default model (no `models:` field on the role, §8.1).
   * The loop reads this and passes it to `reduceLifecycle` as
   * the `model` field on the persisted record (§11.4).
   */
  readonly model: string | null;
  /** The effort / thinking level this session ran with (§8.1, §11.4). */
  readonly effort: ModelEffort;
  /** Additional fresh-session attempts allowed for this model entry (§8.2). */
  readonly retries?: number;
  /** Delay before each same-model retry, in milliseconds (§8.2). */
  readonly retryDelayMs?: number;

  /**
   * Read the per-session machine-event capture buffer (Task 14).
   *   - Empty array → loop records `session_failed` (`no_emission`).
   *   - > 1 entry   → loop records `session_failed` (`extra_emission`).
   *   - 1 entry     → loop calls `validateEmission`; on `ok` → `reduce`;
   *                   on `breach` → `session_failed` (`schema_invalid`).
   * The buffer is only mutated by the host's handoff/end tool wrappers;
   * `readCaptureBuffer` returns a frozen view of the current contents.
   */
  readCaptureBuffer(): readonly EmissionCapture[];

  /**
   * Clear the capture buffer. Called by the orchestration loop (Task 15)
   * after `reduce` returns, so the next `prompt()` is evaluated against
   * a fresh buffer. Used on the reducer-rejection retry path: after a
   * `transition_rejected`, the loop re-prompts the same session; the
   * rejected capture must not count as the new attempt's emission
   * (which would deterministically read as `extra_emission`).
   *
   * Production: delegates to `SessionSeam.reset()` (Task 14). Idempotent;
   * a no-op on an empty buffer.
   */
  resetCaptureBuffer(): void;

  /** Return and clear incomplete-handoff attempts for loop persistence. */
  takeHandoffValidationFailures?(): readonly {
    readonly missingFields: readonly string[];
    readonly invalidFields: readonly string[];
  }[];

  /** Subscribe to session events (Task 17: capture usage on `message_end`,
   *  evaluate session-cap on `turn_end`). Returns an unsubscribe fn. */
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;

  /** Send a prompt and await completion of the role's turn. The
   *  orchestrator or worker speaks once; the loop awaits resolution
   *  before reading the capture buffer. */
  prompt(text: string): Promise<void>;

  /** Release the session's underlying resources (file handles, …). */
  dispose(): Promise<void>;
}

// ─── Spawn options ─────────────────────────────────────────────────────

/**
 * Options for `Host.spawnRole` (Task 15). The Host resolves the
 * per-role wiring: it loads the system prompt from
 * `role.system_prompt`, builds the `DefaultResourceLoader`, and
 * force-injects `handoff`/`end` into the tool allowlist (§8.1).
 *
 * `tools` is the declared allowlist from the manifest + the two
 * machine-event tools. The Host is responsible for building the
 * `createAgentSession` `tools` array with `handoff` and `end` named
 * (sdk-surface.md §1: forgetting to name them in `tools` silently
 * disables them even though they're in `customTools`).
 */
export interface SpawnRoleOptions {
  /** Resolved model for this role invocation (Host resolves from
   *  `role.models` via `modelRegistry.find` or the system default, §8.1). */
  readonly model?: Model<// biome-ignore lint/suspicious/noExplicitAny: pi-coding-agent's own `CreateAgentSessionOptions.model` is `Model<any>`; matching the SDK convention.
  any>;
  /** Per-role system prompt (loaded from `role.system_prompt`). */
  readonly systemPrompt?: string;
  /** Tool allowlist for this role (already includes `handoff`/`end`). */
  readonly tools?: readonly string[];
  /** Custom tools to register (`handoff` + `end` from Task 14). */
  readonly customTools?: readonly ToolDefinition[];
  /** Session manager (in-memory for tests, file-backed for real runs). */
  readonly sessionManager?: SessionManager;
  /** Working directory for the session (default: `process.cwd()`). */
  readonly cwd?: string;
  /**
   * 0-based index into the role's `models[]` list (Task 18, §8.2).
   * `0` = primary model; `1` = first fallback, etc. The Host resolves
   * the actual `Model<any>` from the role config + the index. The
   * loop increments this on `session_failed(model_error)` and re-spawns
   * until the list is exhausted (Task 18). Defaults to `0`.
   */
  readonly modelIndex?: number;
  /**
   * Host-generated predecessor pointer for the optional bounded context tool
   * (issue #14). Callers must not derive this from model payload.
   */
  readonly handoffContextRef?: HandoffContextRef;
}

// ─── seedRunMemory args ────────────────────────────────────────────────

/**
 * Arguments for `Host.seedRunMemory` (Task 16.5).
 *
 * `goal` is the orchestrator's initial goal — either the `seed` passed
 * to `startRun({ seed })` or, by default, a stub string the caller
 * supplies. `runCostCap` is the orchestrator's `max_run_cost_usd`
 * (null = uncapped; the artifact still records `remaining_budget: null`).
 */
export interface SeedRunMemoryArgs {
  readonly checkpoint: Checkpoint;
  readonly def: MachineDefinition;
  readonly goal: string;
  readonly runCostCap: number | null;
}

// ─── Host ──────────────────────────────────────────────────────────────

/**
 * Host — the orchestration loop's seam to the SDK.
 *
 * The Host owns:
 *   - session creation (via `createAgentSession`),
 *   - event subscription + per-session usage accumulation,
 *   - the run_id-keyed append-only log (Task 13.5),
 *   - per-session state (capture buffer, sealed flag, cost accumulator).
 *
 * The Host does NOT own:
 *   - `reduce` / `reduceLifecycle` — pure, called by the loop (§12),
 *   - persistence policy — the loop decides *when* to call `persistRecord`,
 *     the Host just appends to the log,
 *   - the canonical reducer call order (§12.1) — loop's exclusive job,
 *   - lifecycle record content — the loop supplies role/sessionId/etc.,
 *   - cost-cap policy — the loop reads `captureUsage` and decides.
 *
 * The split keeps the loop deterministic and unit-testable; the Host
 * is the only place that touches SDK I/O.
 */
export interface Host {
  /**
   * Spawn a fresh role session. The Host calls `createAgentSession`
   * with the per-role options (model, system prompt via
   * `DefaultResourceLoader({ systemPromptOverride })`, tools allowlist,
   * customTools, sessionManager) and returns a `RoleSession`.
   *
   * The returned session has NOT been prompted yet — the loop subscribes
   * to events and calls `session.prompt(seed)` after wiring listeners.
   */
  spawnRole(role: Role, opts: SpawnRoleOptions): Promise<RoleSession>;

  /**
   * Aggregate usage for the session (§11.4 SDK mapping). The Host
   * accumulates per-session usage from `message_end` events with
   * `message.role === "assistant"` (guarded; sdk-surface.md §3
   * "message_end fires for user / assistant / toolResult messages").
   *
   * Returns zeros for a session with no assistant emissions. The
   * per-session `usage` is the SUM across that session's assistant
   * `message_end` events — not a single capture (a role may emit
   * many assistant messages).
   */
  captureUsage(session: RoleSession): UsageRecord;

  /**
   * Append a single record to the run_id-keyed append-only log
   * (§11.1–§11.5). The Host is the sole writer; the loop calls
   * this exactly once per `reduce` / `reduceLifecycle` result, plus
   * once per checkpoint snapshot (§11.1: each transition produces a
   * new full snapshot the host persists).
   *
   * Implementations MUST be append-only: previously-appended records
   * are immutable. The in-memory impl (`InMemoryRecordLog`,
   * Phase 3 Task 12) and the file-backed impl (Task 13.5) both honor
   * this contract.
   */
  persistRecord(record: PersistedRecord): void;

  /**
   * Build the orchestrator's run-memory artifact (§8.4) for the next
   * orchestrator session. Pure over the current checkpoint + records.
   *
   * The Host wraps `buildRunMemory` (Phase 3 Task 12): same call,
   * same return shape. The method exists on the Host so the loop
   * has a single seam for "prepare orchestrator context" — the Host
   * can later add caching / staleness checks without disturbing the
   * loop.
   */
  seedRunMemory(args: SeedRunMemoryArgs): RunMemory;

  /**
   * Signal the session to stop its current operation (Task 18 / §11.7
   * cost-cap breach). The Host calls `session.abort()` on the SDK
   * session; the loop records `session_failed` separately based on
   * the policy decision.
   *
   * `reason` is for observability only — the persisted
   * `failure_reason` is the loop's choice (e.g.
   * `session_cost_cap_exceeded` vs `model_error` vs `crashed`).
   */
  abortSession(session: RoleSession, reason: string): Promise<void>;

  /**
   * Flip the session's emission-sealed flag (Task 15.5, §12.1).
   * After this call, the Host's wrapped tool implementations
   * short-circuit to error results WITHOUT invoking the underlying
   * tool — preventing work-after-handoff from mutating the workspace
   * after the role has declared its exit intent.
   *
   * The flag is host state on the session; the reducer never sees it.
   * Idempotent: a second call is a no-op (the flag stays sealed).
   * `handoff`/`end` themselves remain callable so the `extra_emission`
   * path (Task 14) still works — they don't execute side effects,
   * they only write the `extra_emission` marker.
   */
  sealSession(session: RoleSession): void;

  /**
   * Get the 1-based visit_index for the next visit to `role` (§11.4).
   * Counts `session_started` records for `role` already in the
   * `run_id`-keyed log and returns that count + 1. The loop calls
   * this immediately before `reduceLifecycle(session_started)` so
   * the recorded `visit_index` reflects the current visit number.
   *
   * Reconstructable from records alone: "implementer ran 3 times"
   * (§11.4) is deterministically recoverable from the persisted
   * `session_started` history.
   */
  nextVisitIndex(role: Role): number;

  /**
   * Host-owned per-session terminal reason. Read by the loop after
   * `prompt()` resolves; the loop uses it to set
   * `session_failed.failure_reason` (Task 17 / Task 18).
   *
   * Returns `null` when the session ended normally — the loop records
   * `session_ended` rather than `session_failed` in that case.
   *
   *  - `session_cost_cap_exceeded` — the host's per-session cap
   *    (`max_session_cost_usd`) fired on a `turn_end` event
   *    (§11.7, Task 17). The host called `session.abort()` and the
   *    session terminated.
   *  - `model_error` — the session failed because the model
   *    errored; the loop should try the next model in the role's
   *    `models[]` list (Task 18, §8.2). On list exhaustion, the
   *    loop records `session_failed(model_error)` and dispatches
   *    the orchestrator with a "role unavailable" payload.
   *  - `user_aborted` — the user explicitly aborted the run via
   *    `/conduct:abort` or confirmed Escape.
   *
   * The host's contract: this method returns a non-null value iff
   * the session terminated abnormally AND the host knows the
   * reason. The session_failed record is recorded by the loop,
   * never the host; the host only signals the reason.
   */
  sessionTerminalReason(session: RoleSession): SessionTerminalReason;

  /**
   * Get the next model in the role's `models[]` list (Task 18, §8.2).
   * Returns the `provider:id` string at `currentModelIndex + 1`, or
   * `null` if the list is exhausted (or the role has no `models` field).
   * The loop uses this to populate the `model_fallback` record's
   * `to_model` field on each model transition.
   *
   * Distinct from `spawnRole`'s `modelIndex` option: this is a read
   * for observability (recording which model is being tried next),
   * not a spawn. The loop increments `modelIndex` and calls
   * `spawnRole` separately.
   */
  getNextModel(role: Role, currentModelIndex: number): string | null;

  /**
   * Cumulative run cost across all persisted terminal sessions
   * (`session_ended` AND `session_failed`, §11.4 — both terminals
   * cost) in the run, summed over `usage.cost`. Excludes the
   * current session's terminal usage (the loop adds it manually
   * before evaluating the cap, per §11.7's "persisted roll-up
   * plus the current terminal's captured usage before reducing
   * the role's captured machine event").
   *
   * The host reads the log and applies the §11.6 rollup. The
   * reducer is uninvolved — the host owns the I/O, the loop owns
   * the policy.
   */
  runCostSoFar(): number;
}

/**
 * Per-session terminal reason the host surfaces (Task 17 / Task 18).
 * See `Host.sessionTerminalReason`. `null` is represented as the
 * absence of a string — the function returns a union with `null`.
 */
export type SessionTerminalReason =
  | "session_cost_cap_exceeded"
  | "model_error"
  | "user_aborted"
  | null;
