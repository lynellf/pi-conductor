/**
 * Orchestration loop — spec §7.2, §8, §11.4, §12.1, §15.3.
 *
 * The synchronous loop over role sessions. While `checkpoint.current_role
 * !== "done"`, the loop:
 *
 *   1. Spawns the current role's session via `host.spawnRole`.
 *   2. Fires `reduceLifecycle(session_started)` (clears `active_role_session`
 *      for the spawn and sets it for the live session).
 *   3. Subscribes to events (Task 17 wires usage capture; Task 15 ships the
 *      subscription contract only).
 *   4. Builds the seed (initial goal or the previous handoff's payload) and
 *      `await session.prompt(seed)`.
 *   5. Reads the per-session capture buffer and feeds it to
 *      `validateEmission` (Phase 3). The buffer-state machine — populated
 *      by the handoff/end tool wrappers (Task 14) — deterministically
 *      yields one of: `ok`, `breach: no_emission`,
 *      `breach: extra_emission`, `breach: schema_invalid`.
 *
 *   6. On `breach`: fires `reduceLifecycle(session_failed)` with the
 *      breach reason, persists exactly one `session_failed` record, and
 *      **does not call `reduce`** (§11.3: contract breaches are
 *      `session_failed`, not `transition_rejected`). The run ends here;
 *      escalation is out of scope for v1 (§9.4 / Task 18).
 *
 *   7. On `ok`: calls `reduce` (Phase 2) and persists the resulting
 *      `transition_accepted` / `transition_rejected` record. The canonical
 *      reducer call order (§12.1) is followed on accepted transitions:
 *
 *        a. `reduce` (current_role advances; active_role_session still
 *           identifies the just-finished session).
 *        b. Persist `CheckpointSnapshot` (the new state).
 *        c. `reduceLifecycle(session_ended)` for the just-finished session
 *           (clears `active_role_session`).
 *        d. The next outer iteration spawns the next session and fires
 *           `reduceLifecycle(session_started)` with `parent_session` =
 *           the just-finished session id (§11.4 tree link).
 *
 *   8. On `reduce.rejected`: persists the `transition_rejected` record
 *      (no checkpoint change, no `session_ended`), clears the capture
 *      buffer (`resetCaptureBuffer`), and re-prompts the same session
 *      with a message surfacing `legal_targets`. This is the retry-in-
 *      session path (§11.3 verbatim: "These keep a live session: the
 *      emitting role can retry against the surfaced legal_targets.").
 *      A second machine-event call from the model would deterministically
 *      read as `extra_emission` against the old capture; clearing the
 *      buffer makes the new attempt's emission the sole candidate for
 *      `validateEmission`. The loop terminates this retry path on
 *      success (`accepted`) or on a fresh contract breach.
 *
 * ## Single-owner rule (§12, plan Task 15)
 *
 * `reduce` and `reduceLifecycle` are called ONLY here — never from the
 * tool wrappers (Task 14), never from the host's session management.
 * Persistence (`host.persistRecord`) is also called ONLY here. Each
 * role session's outcome produces exactly one `transition_accepted` /
 * `transition_rejected` / `session_failed` record, plus the lifecycle
 * records (`session_started` / `session_ended`) bracketing it. Plus a
 * checkpoint snapshot on accepted transitions. No double-reduce / double-
 * persist path is possible.
 *
 * ## What this module does NOT do
 *
 *   - Cost caps (§11.7): Task 17.
 *   - Run memory seeding for orchestrator sessions (§8.4): Task 16.5.
 *   - Model fallback on `model_error` (§8.2): Task 18.
 *   - Resume / crash reconciliation (§11.1): Task 13.5.
 *   - Post-emission tool wrapping (§12.1 sealing): Task 15.5.
 *
 * Host-agnostic: imports SDK types as type-only refs. The runtime I/O is
 * delegated to `Host` (which is the SDK-backed implementation in Task 15's
 * sibling module, or a `FakeHost` in tests).
 */

import { createInitialCheckpoint, reduce } from "../core/reduce.js";
import { reduceLifecycle } from "../core/reduce-lifecycle.js";
import type { Checkpoint, MachineDefinition, Role, UsageRecord } from "../core/types.js";
import type { CheckpointSnapshot, PersistedRecord } from "../persistence/log.js";
import { validateEmission } from "../seam/validate-emission.js";
import type { Host, RoleSession, SeedRunMemoryArgs, SpawnRoleOptions } from "./host.js";

// ─── Public API ────────────────────────────────────────────────────────

/** Options for `runLoop`. */
export interface RunLoopOptions {
  /** Pinned manifest snapshot the reducer consumes as `def` (§12). */
  readonly def: MachineDefinition;
  /** Initial checkpoint (from `createInitialCheckpoint(def)`). For Task 15
   *  this is a fresh checkpoint; Task 13.5 reuses the run loop for resume
   *  by passing a reconstructed snapshot's `Checkpoint`. */
  readonly initialCheckpoint: Checkpoint;
  /** Host the loop programs against (Task 13's seam). */
  readonly host: Host;
  /** Initial goal text seeded into the first orchestrator session. */
  readonly initialGoal: string;
  /** Optional: per-role spawn overrides. Defaults to a minimal call
   *  that lets the host derive model + system prompt + tools from the
   *  loaded manifest. Tests pass `sessionManager: SessionManager.inMemory()`
   *  to skip real disk I/O. */
  readonly spawnDefaults?: Partial<SpawnRoleOptions>;
}

/** Result of `runLoop`. */
export interface RunLoopResult {
  /** Final checkpoint (state may be `"done"` or the role that hit a breach). */
  readonly finalCheckpoint: Checkpoint;
  /** Why the loop returned. */
  readonly exitReason: "done" | "session_failed";
}

/**
 * Run the orchestration loop until `current_role === "done"` or a
 * session breach terminates the run. Pure with respect to the
 * reducer + persistence: the loop calls `reduce` and `reduceLifecycle`
 * exactly once per role-session outcome and `host.persistRecord` once
 * per record. Side effects are confined to `host.spawnRole`,
 * `host.captureUsage`, and `host.persistRecord`.
 *
 * The loop awaits each session's `prompt()` to completion before
 * reading the capture buffer; termination is enforced by the loop
 * reading the buffer, not by trusting the model to stop (§12.1).
 */
export async function runLoop(opts: RunLoopOptions): Promise<RunLoopResult> {
  const { def, host, initialCheckpoint, initialGoal } = opts;
  let checkpoint: Checkpoint = initialCheckpoint;
  // parent_session for the next session_started (§11.4). Initialized to
  // the snapshot's active_role_session id (resume case) or null (fresh).
  let parentSessionId: string | null = checkpoint.active_role_session?.id ?? null;
  let seed = initialGoal;

  while (checkpoint.current_role !== "done") {
    const role = checkpoint.current_role;
    // Defensive: a non-null active_role_session on a non-done state is
    // a host bug (session_started requires no active session). The
    // reducer would throw on the next session_started, but we guard
    // here for clarity.
    if (checkpoint.active_role_session !== null) {
      throw new Error(
        `runLoop: checkpoint.current_role='${String(role)}' but active_role_session is set (id='${checkpoint.active_role_session.id}'); resume/crash reconciliation is Task 13.5's responsibility`,
      );
    }

    const session = await host.spawnRole(role, opts.spawnDefaults ?? {});
    const sessionId = session.sessionId;
    const sessionFile = session.sessionFile;
    const visitIndex = host.nextVisitIndex(role);
    const sessionParentId = parentSessionId;

    // ── §12.1 step 4: session_started for the new session ─────────
    const started = reduceLifecycle(checkpoint, "session_started", def, {
      role,
      sessionId,
      sessionFile,
      ts: Date.now(),
      visit_index: visitIndex,
      parent_session: sessionParentId,
    });
    checkpoint = started.checkpoint;
    host.persistRecord(started.record);
    // §11.1: each transition produces a new full checkpoint snapshot.
    // session_started sets active_role_session; a snapshot here is
    // what resumeRun reads when a run crashed mid-prompt — without
    // it, latestCheckpoint would still point to the previous visit's
    // cleared terminal and crash detection wouldn't fire.
    host.persistRecord({ type: "checkpoint_snapshot", checkpoint });

    // Track this session as parent for the next session_started.
    parentSessionId = sessionId;

    // ── Inner loop: prompt → validate → reduce (with retry on rejection) ──
    let inner: InnerOutcome;
    let nextSeed = seed;
    let capturedUsage: UsageRecord = ZERO_USAGE;

    while (true) {
      await session.prompt(nextSeed);
      capturedUsage = host.captureUsage(session);

      const captures = session.readCaptureBuffer();
      const validated = validateEmission(captures);

      if (validated.kind === "breach") {
        // ── §11.3 contract breach: session_failed, NO reduce call ──
        const failed = reduceLifecycle(checkpoint, "session_failed", def, {
          role,
          sessionId,
          sessionFile,
          ts: Date.now(),
          visit_index: visitIndex,
          parent_session: sessionParentId,
          usage: capturedUsage,
          failureReason: validated.reason,
        });
        checkpoint = failed.checkpoint;
        host.persistRecord(failed.record);
        // §11.1: each transition produces a new full checkpoint
        // snapshot. session_failed clears active_role_session;
        // persist a fresh snapshot so latestCheckpoint reflects
        // the post-terminal state (active=null).
        host.persistRecord({ type: "checkpoint_snapshot", checkpoint });
        inner = { kind: "failed" };
        break;
      }

      // ── Single valid emission — call reduce (§12) ──────────────
      const reduceResult = reduce(checkpoint, validated.event, def, {
        role,
        sessionFile,
        ts: Date.now(),
      });
      host.persistRecord(reduceResult.record);

      // Clear the capture buffer for the next attempt (whether the
      // reduce was accepted or rejected). For accepted: defensive;
      // the session is about to end anyway. For rejected: required,
      // so the next prompt's emission is the sole candidate for
      // validateEmission (without this, a second emission would read
      // as `extra_emission` against the rejected capture).
      session.resetCaptureBuffer();

      if (reduceResult.kind === "rejected") {
        // ── Retry in-session: re-prompt with legal_targets (§11.3) ─
        // No terminal lifecycle — the session continues. Persist the
        // rejected record (above), then surface legal_targets to the
        // model and re-prompt.
        nextSeed = formatRejectionMessage(reduceResult);
        continue;
      }

      // ── Accepted (§12.1) ─────────────────────────────────────────
      // 1. Update the checkpoint from the reducer and persist it.
      checkpoint = reduceResult.checkpoint;
      const snapshot: CheckpointSnapshot = {
        type: "checkpoint_snapshot",
        checkpoint,
      };
      host.persistRecord(snapshot);

      // 2. §12.1 step 2: session_ended for the just-finished session.
      // active_role_session was set by session_started above; reduce
      // did NOT clear it (only lifecycle terminals do). session_ended
      // validates meta.sessionId/role against the live session and
      // clears active_role_session.
      const ended = reduceLifecycle(checkpoint, "session_ended", def, {
        role,
        sessionId,
        sessionFile,
        ts: Date.now(),
        visit_index: visitIndex,
        parent_session: sessionParentId,
        usage: capturedUsage,
      });
      checkpoint = ended.checkpoint;
      host.persistRecord(ended.record);
      // §11.1: each transition produces a new full checkpoint
      // snapshot. session_ended clears active_role_session;
      // persist a fresh snapshot so latestCheckpoint reflects
      // the post-terminal state (active=null). This is what
      // resumeRun reads — a non-null active_role_session on
      // the latest snapshot is the crash signal.
      host.persistRecord({ type: "checkpoint_snapshot", checkpoint });

      if (reduceResult.state === "done") {
        inner = { kind: "done" };
        break;
      }

      // ── Accepted handoff to next role. Prepare the seed for the
      // outer loop's next iteration (§8.3: `suggests_next` is
      // advisory, surfaced as orchestrator context). The host's next
      // spawnRole + session_started (next outer iteration) wires
      // parent_session = sessionId automatically. ─────────────────
      const nextRole: Role = reduceResult.state;
      const payload = validated.event.payload as Record<string, unknown> | undefined;
      const suggestsNext =
        validated.event.type === "handoff" &&
        payload !== undefined &&
        typeof payload === "object" &&
        typeof payload.suggests_next === "string"
          ? (payload.suggests_next as Role)
          : null;
      nextSeed = formatHandoffSeed(payload, nextRole, suggestsNext);
      inner = { kind: "advance", nextSeed };
      break;
    }

    if (inner.kind === "failed") {
      return { finalCheckpoint: checkpoint, exitReason: "session_failed" };
    }
    if (inner.kind === "done") {
      return { finalCheckpoint: checkpoint, exitReason: "done" };
    }
    // advance: continue outer loop with the new seed.
    seed = inner.nextSeed;
  }

  return { finalCheckpoint: checkpoint, exitReason: "done" };
}

// ─── Internals ─────────────────────────────────────────────────────────

type InnerOutcome =
  | { readonly kind: "failed" }
  | { readonly kind: "done" }
  | { readonly kind: "advance"; readonly nextSeed: string };

const ZERO_USAGE: UsageRecord = Object.freeze({
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  tokens: 0,
  cost: 0,
}) as UsageRecord;

/**
 * Format a `transition_rejected` result into a follow-up user message
 * that surfaces `legal_targets` to the model. The model sees this
 * message in its next turn (after the host queues it via
 * `session.prompt(rejectionMessage)`); it can then emit a corrected
 * `handoff` or `end`.
 *
 * Format is human-readable text so the model can act on it without
 * structured parsing. The model is expected to be reasonable about
 * retrying — but if it isn't, the next prompt deterministically reads
 * as a contract breach (§3 / §11.3).
 */
function formatRejectionMessage(result: {
  readonly reason: string;
  readonly legal_targets: { readonly handoff: readonly Role[]; readonly end: boolean };
}): string {
  const targets = result.legal_targets.handoff.join(", ");
  const endClause = result.legal_targets.end ? " or call end" : "";
  return [
    "Your previous machine-event was rejected by the reducer.",
    `Reason: ${result.reason}.`,
    `Legal targets: handoff to [${targets}]${endClause}.`,
    "Please emit exactly one of those machine events in your next turn.",
  ].join(" ");
}

/**
 * Format a handoff's payload into the next role's seed text. The next
 * role gets this as its first user message via `session.prompt(seed)`.
 * `suggests_next` is surfaced as advisory context (§8.3) — the machine
 * never validates it; the next role decides where to go next.
 */
function formatHandoffSeed(
  payload: Record<string, unknown> | undefined,
  targetRole: Role,
  suggestsNext: Role | null,
): string {
  const payloadStr = payload === undefined ? "(no payload)" : JSON.stringify(payload, null, 2);
  const suggestsLine =
    suggestsNext !== null
      ? `\nThe previous role suggests you may next hand off to: ${suggestsNext} (advisory; §8.3).`
      : "";
  return [
    `[handoff → ${targetRole}]`,
    payloadStr,
    suggestsLine,
    "",
    "Continue your work for this role. When done, emit exactly one handoff (target_role=<next role>) or, if you are the orchestrator, end.",
  ].join("\n");
}

// Type re-exports for downstream convenience.
// Re-export the host types the run-lifecycle entry point (Task 13.5) needs.
export type { Host, PersistedRecord, RoleSession, SeedRunMemoryArgs };
/**
 * Re-export `createInitialCheckpoint` so the run-lifecycle entry point
 * (Task 13.5) can mint + persist the initial checkpoint in one call.
 * Kept here so the loop's callers have a single import surface.
 */
export { createInitialCheckpoint };
