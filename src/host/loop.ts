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
 *   6. On `breach`: `no_emission` gets one in-session recovery prompt.
 *      If recovery also breaches, or if the first breach is
 *      `extra_emission` / `schema_invalid`, fires
 *      `reduceLifecycle(session_failed)` with the breach reason,
 *      persists exactly one `session_failed` record, and **does not
 *      call `reduce`** (§11.3: contract breaches are `session_failed`,
 *      not `transition_rejected`).
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
import type {
  Checkpoint,
  HandoffContextRef,
  MachineDefinition,
  MachineEvent,
  Role,
  UsageRecord,
} from "../core/types.js";
import type { CheckpointSnapshot, PersistedRecord } from "../persistence/log.js";
import { summarizePayload } from "../seam/payload-summary.js";
import { validateEmission } from "../seam/validate-emission.js";
import { NoMoreModelsError } from "./errors.js";
import type {
  Host,
  RoleSession,
  SeedRunMemoryArgs,
  SessionTerminalReason,
  SpawnRoleOptions,
} from "./host.js";
import { formatRunMemorySeed } from "./run-memory.js";

// ─── Public API ────────────────────────────────────────────────────────

/** Options for `runLoop`. */
export interface RunAbortControl {
  /** Register the session currently awaiting prompt() or cleanup. */
  setActiveSession(session: RoleSession | null): Promise<void>;
  /** Request abort for the active session (if any). */
  requestAbort(reason: string): Promise<void>;
}

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
  /**
   * Latest persisted handoff reference when entering a run at a non-initial
   * role (resume). Fresh runs leave this unset.
   */
  readonly initialHandoffContextRef?: HandoffContextRef | null;
  /** Optional: per-role spawn overrides. Defaults to a minimal call
   *  that lets the host derive model + system prompt + tools from the
   *  loaded manifest. Tests pass `sessionManager: SessionManager.inMemory()`
   *  to skip real disk I/O. */
  readonly spawnDefaults?: Partial<SpawnRoleOptions>;
  /**
   * Optional: dynamic cap reader for `max_run_cost_usd` (§11.7, Task 17).
   * Called on every terminal usage capture to evaluate the run cap.
   * `null` = uncapped. The RunHandle's `runConfig()` override flows
   * through this callback (api.ts wires `getRunCostCap` to read the
   * override or the manifest orchestrator's `max_run_cost_usd`).
   *
   * If omitted, the run is treated as uncapped (the loop's
   * Task-16.5 seed still uses the static `runCostCap` option).
   */
  readonly getRunCostCap?: () => number | null;
  /**
   * Optional: static `max_run_cost_usd` (§11.7, Task 17). A fallback
   * for callers that don't need `runConfig()` overrides (tests, CLI
   * runs without a RunHandle). The loop reads `getRunCostCap()` first
   * and falls back to this value. `null` / undefined = uncapped.
   *
   * Production: prefer `getRunCostCap` (wired to `RunHandle.runConfig`
   * in api.ts). This static option exists so unit tests can pin the
   * cap without constructing a RunHandle.
   */
  readonly runCostCap?: number | null;
  /** Optional abort bridge used by `RunHandle.abort()` / Escape. */
  readonly abortControl?: RunAbortControl;
}

/** Result of `runLoop`. */
export interface RunLoopResult {
  /** Final checkpoint (state may be `"done"` or the role that hit a breach). */
  readonly finalCheckpoint: Checkpoint;
  /** Why the loop returned. */
  readonly exitReason: "done" | "session_failed" | "aborted";
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
  // Host-generated predecessor pointer for the next role's optional
  // handoff_context tool. It is replaced only by an accepted handoff or by
  // the persisted run-memory envelope on an orchestrator/resume turn.
  let handoffContextRef: HandoffContextRef | null = opts.initialHandoffContextRef ?? null;
  // Task 17 §11.7 worker-deferral guard: a run-cap breach detected on
  // a worker terminal defers the synthesized `end` to the next
  // orchestrator-current moment (spec: "the host does NOT synthesize
  // `end` while a worker is current"). Set here, consumed at the
  // top of the next outer iteration.
  let pendingForcedEnd = false;
  // Task 18: visit_index tracking. A role's visit_index is the same
  // across all model retries within that visit (the role didn't
  // transition, it re-ran). The index is captured BEFORE the fallback
  // loop so both the primary and fallback sessions share it, and
  // incremented AFTER the visit ends (accepted handoff, done, or
  // exhaustion) so the next visit to the same role gets the next
  // index. This is the loop's source of truth for visit_index;
  // `host.nextVisitIndex` is no longer used by the loop (the host
  // method stays in the `Host` interface for backward compat with
  // existing fakes, but its terminal-counting logic is incorrect
  // for model retries — the primary's `session_failed` is recorded
  // before the fallback's `session_started`, which would inflate
  // the count).
  const visitIndexByRole = new Map<Role, number>();
  // Sentinel sessionFile for the synthesized `end` records. There is
  // no live session at the time of synthesis, so the record's
  // `session_file` field carries a stable marker rather than a real
  // path. `run_id` is the real runId; the marker is just a hint for
  // log consumers.
  const SYNTHESIZED_SESSION_FILE = "<synthesized:end:run-cost-cap>";
  // Sentinel sessionFile for the synthesized handoff to the
  // orchestrator on model-fallback exhaustion (Task 18, §8.2/§9.4).
  // Distinct from the run-cap sentinel so log consumers can tell the
  // two synthesized-event paths apart.
  const SYNTHESIZED_UNAVAILABLE_SESSION_FILE = "<synthesized:handoff:role-unavailable>";

  while (checkpoint.current_role !== "done") {
    // ── §11.7 deferred forced end (Task 17) ──────────────────
    // A previous worker's terminal tripped the run cap; the worker's
    // handoff returned control to the orchestrator (state advanced).
    // On the first orchestrator-current moment, the loop synthesizes
    // a machine `end` event and feeds it to `reduce` (the only
    // legal mechanism — the host MUST NOT mutate the checkpoint to
    // `done` directly, §11.7). The reducer doesn't know the event
    // is synthesized; it sees a normal end from the orchestrator.
    if (pendingForcedEnd) {
      if (checkpoint.current_role !== def.orchestrator) {
        // Defensive: pendingForcedEnd should only be set on a
        // worker terminal, and a worker's only legal target is the
        // orchestrator (§6). If we ever reach this branch the
        // invariant is broken; surface as a typed error rather
        // than silently mis-close the run.
        throw new Error(
          `runLoop: pendingForcedEnd set but current_role='${String(
            checkpoint.current_role,
          )}' (expected '${def.orchestrator}'); §11.7 worker-deferral guard invariant violated`,
        );
      }
      const synthesized: MachineEvent = {
        type: "end",
        payload: { reason: "run_cost_cap_exceeded" },
      };
      const result = reduce(checkpoint, synthesized, def, {
        role: def.orchestrator,
        sessionFile: SYNTHESIZED_SESSION_FILE,
        ts: Date.now(),
      });
      host.persistRecord(result.record);
      checkpoint = result.checkpoint;
      host.persistRecord({ type: "checkpoint_snapshot", checkpoint });
      return { finalCheckpoint: checkpoint, exitReason: "done" };
    }

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

    // ── Task 16.5: orchestrator run-memory seed ──────────────────
    // Spec §8.4 single-writer rule: only orchestrator sessions
    // receive the artifact. Workers get the handoff payload
    // (Task 15's `formatHandoffSeed`) instead. The host owns the
    // record log and the buildRunMemory call — the loop just calls
    // host.seedRunMemory and formats the result.
    if (role === def.orchestrator) {
      const runMemory = host.seedRunMemory({
        checkpoint,
        def,
        goal: opts.initialGoal,
        // Task 17: the seed's runCostCap is the CURRENT cap (read
        // dynamically via getRunCostCap so runConfig overrides flow
        // through). Falls back to the static `runCostCap` option
        // for tests that don't provide a dynamic reader.
        runCostCap: opts.getRunCostCap?.() ?? opts.runCostCap ?? null,
      });
      seed = formatRunMemorySeed(runMemory);
      handoffContextRef = runMemory.last_message?.context_ref ?? null;
    }

    // ── Task 18: model-fallback loop ─────────────────────────
    // Per §8.2, on `session_failed(model_error)`, try the next model
    // in the role's `models[]` list (same role, fresh session, state
    // unchanged). Record `model_fallback` on each transition. On
    // list exhaustion (`NoMoreModelsError` from `host.spawnRole`),
    // break with `roleOutcome = "exhausted"` and synthesize a
    // handoff to the orchestrator with a "role unavailable" payload
    // (§9.4 v1 default: hand to orchestrator once, then escalate).
    //
    // Capture the visit_index BEFORE the fallback loop so all model
    // attempts within this visit share the same index. The index is
    // incremented after the visit ends (below) so the next visit to
    // the same role gets the next index.
    const visitIndex = visitIndexByRole.get(role) ?? 1;
    let modelIndex = 0;
    let retryAttempt = 0;
    let roleOutcome: RoleOutcome = { kind: "advance", nextSeed: seed };

    while (true) {
      // Spawn (may throw `NoMoreModelsError` when the list is
      // exhausted, or `RoleEscalationError` when the orchestrator
      // re-dispatches the same role after exhaustion). The former
      // is caught here and converted to `roleOutcome = "exhausted"`;
      // the latter propagates to abort the run per §9.4.
      let session: RoleSession;
      try {
        // `spawnDefaults` is a test/host override surface, not a provenance
        // surface. Remove any caller-supplied reference before adding the
        // loop's trusted value so it cannot override or seed the envelope.
        const spawnDefaults = { ...(opts.spawnDefaults ?? {}) };
        delete spawnDefaults.handoffContextRef;
        session = await host.spawnRole(role, {
          ...spawnDefaults,
          modelIndex,
          ...(handoffContextRef !== null && { handoffContextRef }),
        });
      } catch (err) {
        if (err instanceof NoMoreModelsError) {
          roleOutcome = { kind: "exhausted" };
          break;
        }
        // RoleEscalationError and other errors propagate up to abort
        // the run. The caller's `runLoop` does not catch typed
        // errors — surface to the caller, which catches (test,
        // RunHandle).
        throw err;
      }

      // Session block — declare exit variables before the
      // try-finally so the fallback loop can read them after dispose.
      // The inner loop always sets `inner` before breaking, so the
      // initial values are just type-system defaults.
      let inner: InnerOutcome = { kind: "failed" };
      let sessionHostReason: SessionTerminalReason = null;
      let capturedUsage: UsageRecord = ZERO_USAGE;
      let nextSeed = seed;
      let recoveringFromNoEmission = false;

      try {
        const sessionId = session.sessionId;
        const sessionFile = session.sessionFile;
        const sessionParentId = parentSessionId;

        // ── §12.1 step 4: session_started for the new session ─────────
        const started = reduceLifecycle(checkpoint, "session_started", def, {
          role,
          sessionId,
          sessionFile,
          ts: Date.now(),
          visit_index: visitIndex,
          parent_session: sessionParentId,
          model: session.model,
          model_effort: session.effort,
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

        const finishUserAbort = (usage: UsageRecord): RunLoopResult => {
          const failed = reduceLifecycle(checkpoint, "session_failed", def, {
            role,
            sessionId,
            sessionFile,
            ts: Date.now(),
            visit_index: visitIndex,
            parent_session: sessionParentId,
            usage,
            failureReason: "user_aborted",
            model: session.model,
            model_effort: session.effort,
          });
          checkpoint = failed.checkpoint;
          host.persistRecord(failed.record);
          host.persistRecord({ type: "checkpoint_snapshot", checkpoint });
          return { finalCheckpoint: checkpoint, exitReason: "aborted" };
        };

        // ── Inner loop: prompt → validate → reduce (with retry on rejection) ──
        while (true) {
          await opts.abortControl?.setActiveSession(session);
          const prePromptHostReason = host.sessionTerminalReason(session);
          if (prePromptHostReason === "user_aborted") {
            capturedUsage = host.captureUsage(session);
            inner = { kind: "failed" };
            return finishUserAbort(capturedUsage);
          }

          let promptError: unknown = null;
          try {
            await session.prompt(nextSeed);
          } catch (err) {
            promptError = err;
          }
          capturedUsage = host.captureUsage(session);

          const hostReasonOnPrompt = host.sessionTerminalReason(session);
          if (hostReasonOnPrompt === "user_aborted") {
            sessionHostReason = hostReasonOnPrompt;
            inner = { kind: "failed" };
            return finishUserAbort(capturedUsage);
          }
          if (promptError !== null && hostReasonOnPrompt === null) {
            throw promptError;
          }

          const captures = session.readCaptureBuffer();
          const validated = validateEmission(captures);

          if (validated.kind === "breach") {
            // ── §11.3 contract breach: session_failed, NO reduce call ──
            // The host may also have terminated the session (e.g., the
            // per-session cap fired on `turn_end` and called `abort()`,
            // Task 17). The host's reason, when set, takes precedence
            // over the buffer-derived reason: a cap-terminated session
            // still has an empty buffer, but the host knows WHY it
            // terminated. For model errors (Task 18) the same path
            // applies — the host's reason reflects the upstream cause.
            const hostReason = host.sessionTerminalReason(session);
            sessionHostReason = hostReason;
            if (
              hostReason === null &&
              validated.reason === "no_emission" &&
              !recoveringFromNoEmission
            ) {
              recoveringFromNoEmission = true;
              nextSeed = formatNoEmissionRecoveryMessage(role, def);
              continue;
            }
            const failureReason: string = hostReason ?? validated.reason;
            const failed = reduceLifecycle(checkpoint, "session_failed", def, {
              role,
              sessionId,
              sessionFile,
              ts: Date.now(),
              visit_index: visitIndex,
              parent_session: sessionParentId,
              usage: capturedUsage,
              failureReason,
              model: session.model,
              model_effort: session.effort,
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

          // ── §11.7 run-cap evaluation (Task 17) ──────────────
          // Evaluate the cap against the persisted rollup PLUS this
          // terminal's captured usage, before reducing the role's
          // captured machine event. The hard cap is non-negotiable;
          // a breach is the single legal mechanism to close the run.
          //
          // The cap is only meaningful when the captured emission is
          // a handoff (not an end). If the orchestrator emitted end,
          // the run is closing anyway — no synthesis needed.
          const runCap = opts.getRunCostCap?.() ?? opts.runCostCap ?? null;
          const runCapBreached =
            runCap !== null && host.runCostSoFar() + capturedUsage.cost >= runCap;
          const capturedIsHandoff = validated.event.type === "handoff";

          if (runCapBreached && capturedIsHandoff) {
            if (role === def.orchestrator) {
              // ── Orchestrator current: synthesize end, reduce it.
              // The captured handoff is SUPERSEDED; no worker is
              // spawned. session_ended for the orchestrator is
              // recorded normally first (it carries the captured
              // usage — both terminals cost, §11.4), then the
              // synthesized transition_accepted ends the run.
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
              host.persistRecord({ type: "checkpoint_snapshot", checkpoint });

              const synthesized: MachineEvent = {
                type: "end",
                payload: { reason: "run_cost_cap_exceeded" },
              };
              const result = reduce(checkpoint, synthesized, def, {
                role: def.orchestrator,
                sessionFile: SYNTHESIZED_SESSION_FILE,
                ts: Date.now(),
              });
              host.persistRecord(result.record);
              checkpoint = result.checkpoint;
              host.persistRecord({ type: "checkpoint_snapshot", checkpoint });
              return { finalCheckpoint: checkpoint, exitReason: "done" };
            }
            // ── Worker current: defer the synthesized end.
            // `end` from a worker is rejected (§7.2/§12.1). Let the
            // worker's natural handoff to the orchestrator reduce
            // normally (worker → orch is the only legal target,
            // §6); on the next outer iteration, the deferred-end
            // branch above synthesizes the end. The cap is still a
            // hard stop — no further dispatch, no orchestrator
            // session in between.
            pendingForcedEnd = true;
          }

          // ── Host-driven session termination (Task 17 / Task 18) ──────
          // The host may have terminated the session (e.g., the
          // per-session cap fired on a `message_end` and the abort
          // raced the tool-execution phase — the handoff tool
          // wrapper may have already written to the capture buffer
          // before the abort took effect). The host's terminal
          // reason, when set, takes precedence: the captured
          // emission is discarded and `session_failed` is recorded
          // with the host's reason. For model errors (Task 18) the
          // same path applies — the host's reason reflects the
          // upstream cause. This is the single point where the host
          // can override a non-empty capture buffer.
          const hostReasonOnOk = host.sessionTerminalReason(session);
          if (hostReasonOnOk !== null) {
            sessionHostReason = hostReasonOnOk;
            const failed = reduceLifecycle(checkpoint, "session_failed", def, {
              role,
              sessionId,
              sessionFile,
              ts: Date.now(),
              visit_index: visitIndex,
              parent_session: sessionParentId,
              usage: capturedUsage,
              failureReason: hostReasonOnOk,
              model: session.model,
              model_effort: session.effort,
            });
            checkpoint = failed.checkpoint;
            host.persistRecord(failed.record);
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
          // §11.2: the reducer emits a placeholder `payload_summary`
          // (it never inspects payload content, §3/§12). The seam is the
          // declared writer that enriches it with the real `field_names` +
          // surfaced `reason` before persistence — so the run-memory
          // `last_message` (§8.4) can deliver the worker's verdict/status
          // to the next orchestrator session.
          const acceptedContextRef: HandoffContextRef | null =
            reduceResult.kind === "accepted" && validated.event.type === "handoff"
              ? {
                  run_id: checkpoint.run_id,
                  source_role: role,
                  source_session_file: sessionFile,
                }
              : null;
          const enrichedRecord: typeof reduceResult.record =
            reduceResult.kind === "accepted"
              ? {
                  ...reduceResult.record,
                  payload_summary: summarizePayload(validated.event.payload),
                  context_ref: acceptedContextRef,
                }
              : reduceResult.record;
          host.persistRecord(enrichedRecord);

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
            recoveringFromNoEmission = false;
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
            model: session.model,
            model_effort: session.effort,
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
          if (acceptedContextRef === null) {
            throw new Error(
              "runLoop: accepted non-terminal handoff is missing its host-generated context_ref",
            );
          }
          const payload = validated.event.payload as Record<string, unknown> | undefined;
          const suggestsNext =
            validated.event.type === "handoff" &&
            payload !== undefined &&
            typeof payload === "object" &&
            typeof payload.suggests_next === "string"
              ? (payload.suggests_next as Role)
              : null;
          handoffContextRef = acceptedContextRef;
          nextSeed = formatHandoffSeed(payload, nextRole, suggestsNext, acceptedContextRef);
          inner = { kind: "advance", nextSeed };
          break;
        }
      } finally {
        // spec §12.1 lifecycle step 7 / `RoleSession.dispose` (host.ts):
        // release this iteration's session resources on EVERY exit path —
        // accepted handoff, session_failed (breach / host reason), done,
        // run-cap early return, or a thrown invariant. Without this, each
        // spawned session's runtime / listeners / file handles persist
        // until the Vitest worker exits, which dominated memory pressure
        // during Phase 5's host-heavy suite. The `finally` wraps the
        // session block (spawn is outside: a spawn failure leaves no
        // handle to dispose). The inner retry `continue` stays inside the
        // try, so the session is NOT disposed mid-retry — only on the
        // iteration's terminal exit.
        //
        // A dispose rejection must not shadow the run's authoritative
        // outcome (transition / session_failed / thrown invariant); we
        // suppress it here and route to structured logging once Task 5's
        // observability seam lands. This is a deliberate, documented
        // suppression — not a silent fallback on ambiguity.
        await session.dispose().catch((disposeError) => {
          void disposeError;
        });
        await opts.abortControl?.setActiveSession(null);
      }

      // ── Task 18: model_error → fallback to next model ──────────
      // The session ended with `model_error`. Record `model_fallback`
      // (per §11.5) only when the role has a next model in its
      // `models[]` list — a transition to a non-existent model is
      // not a real fallback, just exhaustion. Then `continue` to
      // try the next model. If the list is exhausted, the next
      // `spawnRole` call throws `NoMoreModelsError`, the host sets
      // its `unavailableRole` marker, and the catch below sets
      // `exhausted` and breaks. State is unchanged across model
      // retries (same role, same `visitIndex` captured above).
      if (inner.kind === "failed" && sessionHostReason === "model_error") {
        // The failed terminal is already persisted before this branch. Do
        // not start another session once the run budget is exhausted;
        // retries and model fallback must not bypass the run cap (§11.7).
        const runCap = opts.getRunCostCap?.() ?? opts.runCostCap ?? null;
        if (runCap !== null && host.runCostSoFar() >= runCap) {
          roleOutcome = { kind: "failed" };
          break;
        }

        const maxRetries = session.retries ?? 0;
        if (retryAttempt < maxRetries) {
          const attempt = retryAttempt + 1;
          const delayMs = session.retryDelayMs ?? 0;
          host.persistRecord({
            type: "model_retry",
            run_id: checkpoint.run_id,
            role,
            model: session.model,
            attempt,
            max_retries: maxRetries,
            reason: "model_error",
            delay_ms: delayMs,
            session_file: session.sessionFile,
            ts: Date.now(),
          });
          retryAttempt = attempt;
          await waitForRetry(delayMs);
          continue;
        }

        retryAttempt = 0;
        const nextModel = host.getNextModel(role, modelIndex);
        if (nextModel !== null) {
          host.persistRecord({
            type: "model_fallback",
            run_id: checkpoint.run_id,
            role,
            from_model: session.model,
            to_model: nextModel,
            reason: "model_error",
            session_file: session.sessionFile,
            ts: Date.now(),
          });
        }
        modelIndex += 1;
        continue; // try the next model (or hit NoMoreModelsError)
      }

      // Other outcomes — exit the fallback loop.
      if (inner.kind === "done") {
        roleOutcome = { kind: "done" };
      } else if (inner.kind === "failed") {
        roleOutcome = { kind: "failed" };
      } else {
        roleOutcome = { kind: "advance", nextSeed: inner.nextSeed };
      }
      break;
    }

    // Handle role outcome (after fallback loop)
    if (roleOutcome.kind === "done") {
      return { finalCheckpoint: checkpoint, exitReason: "done" };
    }
    if (roleOutcome.kind === "failed") {
      return { finalCheckpoint: checkpoint, exitReason: "session_failed" };
    }
    if (roleOutcome.kind === "exhausted") {
      // ── Task 18: synthesize handoff to orchestrator (§9.4) ────────
      // The role exhausted its model fallback list. Per §9.4 v1
      // default, hand to the orchestrator once with a "role
      // unavailable" payload. The orchestrator decides whether to
      // end, re-dispatch a different role, or re-dispatch the same
      // role (which escalates per §9.4). The synthesized handoff is
      // a legal transition (worker → orch is the only legal target,
      // §7.2) — the reducer accepts it and advances state.
      const synthesized: MachineEvent = {
        type: "handoff",
        target_role: def.orchestrator,
        payload: { reason: "role_unavailable", role: role },
      };
      const result = reduce(checkpoint, synthesized, def, {
        role: role,
        sessionFile: SYNTHESIZED_UNAVAILABLE_SESSION_FILE,
        ts: Date.now(),
      });
      if (result.kind !== "accepted") {
        throw new Error("runLoop: synthesized role-unavailable handoff was rejected");
      }
      host.persistRecord({
        ...result.record,
        payload_summary: summarizePayload(synthesized.payload),
        context_ref: null,
      });
      checkpoint = result.checkpoint;
      host.persistRecord({ type: "checkpoint_snapshot", checkpoint });
      // Continue outer loop with a "role unavailable" seed for the
      // orchestrator. The orchestrator's system prompt would handle
      // this payload; the loop just formats the surface text.
      handoffContextRef = null;
      seed = formatRoleUnavailableSeed(role);
    } else {
      // advance: continue outer loop with the new seed.
      seed = roleOutcome.nextSeed;
    }
    // Increment visit_index for the role that just finished its
    // visit. Covers both `exhausted` (the role is abandoned) and
    // `advance` (the role transitions away). The next visit to the
    // same role gets the next index. Model retries within this
    // visit already shared the captured `visitIndex` above.
    visitIndexByRole.set(role, visitIndex + 1);
  }

  return { finalCheckpoint: checkpoint, exitReason: "done" };
}

// ─── Internals ─────────────────────────────────────────────────────────

type InnerOutcome =
  | { readonly kind: "failed" }
  | { readonly kind: "done" }
  | { readonly kind: "advance"; readonly nextSeed: string };

/** Task 18: outcome of a role visit's fallback loop. */
type RoleOutcome =
  | { readonly kind: "failed" }
  | { readonly kind: "done" }
  | { readonly kind: "advance"; readonly nextSeed: string }
  | { readonly kind: "exhausted" };

const ZERO_USAGE: UsageRecord = Object.freeze({
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  tokens: 0,
  cost: 0,
}) as UsageRecord;

function waitForRetry(delayMs: number): Promise<void> {
  if (delayMs === 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * Format a recovery prompt for a role turn that returned without a
 * captured `handoff` or `end`. This stays in the same live session so
 * the model can convert its just-produced natural-language conclusion
 * into the required conductor tool call. If this prompt also produces
 * no emission, the normal `session_failed(no_emission)` path fires.
 */
function formatNoEmissionRecoveryMessage(role: Role, def: MachineDefinition): string {
  const action =
    role === def.orchestrator
      ? "call exactly one conductor tool now: `handoff` to a legal next role, or `end` if the run is complete."
      : `call exactly one conductor tool now: \`handoff\` to \`${def.orchestrator}\` with your verdict or status in \`reason\`.`;
  return [
    "Your previous response did not call `handoff` or `end`, so the conductor cannot advance.",
    "Do not do more investigation or call any non-conductor tools.",
    action,
  ].join(" ");
}

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
 * Format a "role unavailable" payload into the orchestrator's seed
 * text (Task 18, §9.4 v1 default). The orchestrator receives this
 * as its first user message when a role exhausts its model fallback
 * list. The orchestrator decides whether to end, re-dispatch a
 * different role, or re-dispatch the same role (which escalates
 * per §9.4).
 *
 * The text is human-readable so the model can act on it. The
 * payload itself is the structured handoff argument the loop
 * synthesized; the seed is a surface for the model, not a
 * machine-readable contract.
 */
function formatRoleUnavailableSeed(role: Role): string {
  return [
    `[role_unavailable: ${role}]`,
    `The role '${role}' exhausted its model fallback list (§8.2).`,
    `Per §9.4 v1 default, you have one chance to handle this:`,
    `  - end the run, OR`,
    `  - hand off to a different role (NOT '${role}'), OR`,
    `  - hand off to '${role}' (this will escalate per §9.4).`,
    "No readable source session exists for this synthesized handoff.",
    "When done, emit exactly one handoff (target_role=<next role>) or end.",
  ].join("\n");
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
  contextRef: HandoffContextRef,
): string {
  // `context_ref` is a host-owned reserved field. Keep arbitrary role fields
  // compatible, but do not echo a model-supplied value beside the trusted
  // envelope where a recipient could mistake it for the source pointer.
  const payloadForSeed =
    payload === undefined
      ? undefined
      : Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "context_ref"));
  const payloadStr =
    payloadForSeed === undefined ? "(no payload)" : JSON.stringify(payloadForSeed, null, 2);
  const suggestsLine =
    suggestsNext !== null
      ? `\nThe previous role suggests you may next hand off to: ${suggestsNext} (advisory; §8.3).`
      : "";
  return [
    `[handoff → ${targetRole}]`,
    "Host-generated predecessor context (trusted; payload fields cannot override it):",
    "context_ref:",
    `  run_id: ${contextRef.run_id}`,
    `  source_role: ${contextRef.source_role}`,
    `  source_session_file: ${contextRef.source_session_file}`,
    "",
    "handoff payload:",
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
