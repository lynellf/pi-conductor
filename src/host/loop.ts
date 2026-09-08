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
 *   6. On `breach`: `no_emission` gets up to three in-session recovery
 *      prompts. If recovery still breaches, or if the first breach is
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
import type {
  Checkpoint,
  HandoffContextRef,
  MachineDefinition,
  MachineEvent,
  Role,
  UsageRecord,
} from "../core/types.js";
import type {
  ArtifactDeliveryRecord,
  EndGuardRecord,
  PersistedRecord,
} from "../persistence/log.js";
import { summarizePayload } from "../seam/payload-summary.js";
import type { EndGuardConfig } from "./end-guard-runner.js";
import { NoMoreModelsError } from "./errors.js";
import type {
  Host,
  RoleSession,
  SeedRunMemoryArgs,
  SessionTerminalReason,
  SpawnRoleOptions,
} from "./host.js";
import { formatRoleUnavailableSeed, waitForRetry } from "./loop-format.js";
import { runSession } from "./loop-session.js";
import type { InnerOutcome, PendingArtifactRoute, RoleOutcome } from "./loop-types.js";
import { ZERO_USAGE } from "./loop-types.js";
import type { RunControl } from "./run-control.js";
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
  /** Durable accepted-handoff delivery resumed before the receiver can prompt. */
  readonly initialArtifactDelivery?: ArtifactDeliveryRecord | null;
  /** Logical predecessor restored from a trajectory selector before a resumed target starts. */
  readonly initialParentSessionId?: string | null;
  /** Exact host-generated target prompt persisted by a selected trajectory handoff. */
  readonly initialTrajectorySeed?: string | null;
  /** Next visit index per role reconstructed from durable lifecycle starts on resume. */
  readonly initialVisitIndexByRole?: Readonly<Record<string, number>>;
  /** Fresh executable invocation index per role for operator resume. */
  readonly initialExecutionVisitIndexByRole?: Readonly<Record<string, number>>;
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
  /** Run-owned steering, follow-up mailbox, abort, and response state. */
  readonly runControl?: RunControl;
  /** Coherent pinned #75 guard capability; absent preserves legacy ending. */
  readonly endGuard?: {
    readonly config: EndGuardConfig;
    readonly records: () => readonly EndGuardRecord[];
    readonly requestId: (checkpoint: Checkpoint) => string;
  };
}

/** Result of `runLoop`. */
export interface RunLoopResult {
  /** Final checkpoint (state may be `"done"` or the role that hit a breach). */
  readonly finalCheckpoint: Checkpoint;
  /** Why the loop returned. */
  readonly exitReason: "done" | "session_failed" | "aborted";
}

export async function runLoop(opts: RunLoopOptions): Promise<RunLoopResult> {
  const { def, host, initialCheckpoint, initialGoal } = opts;
  if (opts.endGuard !== undefined && host.runEndGuard === undefined) {
    throw new Error("configured end_guard requires Host.runEndGuard");
  }
  let checkpoint: Checkpoint = initialCheckpoint;
  // parent_session for the next session_started (§11.4). Initialized to
  // the snapshot's active_role_session id (resume case) or null (fresh).
  let parentSessionId: string | null =
    checkpoint.active_role_session?.id ?? opts.initialParentSessionId ?? null;
  let seed = opts.initialTrajectorySeed ?? initialGoal;
  // A resumed trajectory target must receive its durable, admission-checked
  // user prompt byte-for-byte, including when that target is the orchestrator.
  let useInitialTrajectorySeed = opts.initialTrajectorySeed !== undefined;
  // Host-generated predecessor pointer for the next role's optional
  // handoff_context tool. It is replaced only by an accepted handoff or by
  // the persisted run-memory envelope on an orchestrator/resume turn.
  let handoffContextRef: HandoffContextRef | null = opts.initialHandoffContextRef ?? null;
  // A route exists only for the immediately preceding accepted handoff. Its
  // host-owned intent is durable before the target checkpoint is persisted,
  // so public resume can re-materialize and seed before a receiver prompt.
  let pendingArtifactRoute: PendingArtifactRoute | null =
    opts.initialArtifactDelivery === null || opts.initialArtifactDelivery === undefined
      ? null
      : {
          role: opts.initialArtifactDelivery.role,
          visitIndex: opts.initialArtifactDelivery.visit_index,
          sessionId: opts.initialArtifactDelivery.session_id,
          receiverRole: opts.initialArtifactDelivery.receiver_role,
          status: opts.initialArtifactDelivery.status,
          artifactSeed: opts.initialArtifactDelivery.artifact_seed,
          ...(opts.initialArtifactDelivery.failure_reason !== undefined && {
            failureReason: opts.initialArtifactDelivery.failure_reason,
          }),
        };
  // Task 17 §11.7 worker-deferral guard: a run-cap breach detected on
  // a worker terminal defers the synthesized `end` to the next
  // orchestrator-current moment (spec: "the host does NOT synthesize
  // `end` while a worker is current"). Set here, consumed at the
  // top of the next outer iteration.
  let pendingForcedEnd = false;
  // A selected trajectory target is already a reconfigured, idle SDK
  // session. It bypasses only the next fresh spawn; every other loop path is
  // unchanged.
  let pendingTrajectorySession: RoleSession | null = null;
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
  const visitIndexByRole = new Map<Role, number>(
    Object.entries(opts.initialVisitIndexByRole ?? {}) as [Role, number][],
  );
  const executionVisitIndexByRole = new Map<Role, number>(
    Object.entries(opts.initialExecutionVisitIndexByRole ?? {}) as [Role, number][],
  );
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
  // A fallback spawn can fail before it has a real session identity. This
  // marker keeps that terminal visible without pretending a live session
  // started (issue #44).
  const SYNTHESIZED_FALLBACK_FAILURE_SESSION_FILE = "<synthesized:session-failed:fallback-start>";

  while (checkpoint.current_role !== "done") {
    // ── §11.7 deferred forced end (Task 17) ──────────────────
    // A previous worker's terminal tripped the run cap; the worker's
    // handoff returned control to the orchestrator (state advanced).
    // On the first orchestrator-current moment, the loop synthesizes
    // a machine `end` event and feeds it to `reduce` (the only
    // legal mechanism — the host MUST NOT mutate the checkpoint to
    // `done` directly, §11.7). The explicit run_cost_cap authority
    // lets the reducer bypass normal end-request gating without
    // bypassing the reducer itself.
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
        authority: "run_cost_cap",
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
    if (role === def.orchestrator && !useInitialTrajectorySeed) {
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
    useInitialTrajectorySeed = false;

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
    const executionVisitIndex = executionVisitIndexByRole.get(role) ?? visitIndex;
    let modelIndex = 0;
    let retryAttempt = 0;
    let roleOutcome: RoleOutcome = { kind: "advance", nextSeed: seed };
    // This is scoped to one receiving visit, so every fresh process attempt
    // gets the same host-owned section while the host materializes only once.
    let artifactSeedForVisit: string | null =
      pendingArtifactRoute?.receiverRole === role && pendingArtifactRoute.status !== "pending"
        ? (pendingArtifactRoute.artifactSeed ?? null)
        : null;

    while (true) {
      // Spawn (may throw `NoMoreModelsError` when the list is
      // exhausted, or `RoleEscalationError` when the orchestrator
      // re-dispatches the same role after exhaustion). The former
      // is caught here and converted to `roleOutcome = "exhausted"`;
      // the latter propagates to abort the run per §9.4.
      let session: RoleSession;
      try {
        if (pendingTrajectorySession !== null) {
          session = pendingTrajectorySession;
          pendingTrajectorySession = null;
        } else {
          // `spawnDefaults` is a test/host override surface, not a provenance
          // surface. Remove any caller-supplied reference before adding the
          // loop's trusted value so it cannot override or seed the envelope.
          const spawnDefaults = { ...(opts.spawnDefaults ?? {}) };
          delete spawnDefaults.handoffContextRef;
          session = await host.spawnRole(role, {
            ...spawnDefaults,
            visitIndex,
            executionVisitIndex,
            modelIndex,
            getRunCostCap: opts.getRunCostCap ?? (() => opts.runCostCap ?? null),
            getCurrentParentUsage: () => host.captureUsage(session).cost,
            ...(handoffContextRef !== null && { handoffContextRef }),
          });
        }
      } catch (err) {
        if (err instanceof NoMoreModelsError) {
          roleOutcome = { kind: "exhausted" };
          break;
        }
        if (modelIndex > 0) {
          // A fallback spawn has no active lifecycle session to terminate:
          // the primary already emitted `session_failed`, and this spawn
          // failed before `session_started` could be reduced. Persist an
          // explicit terminal lifecycle record with a synthetic identity so
          // run projections cannot remain `running` after a fallback startup
          // error (issue #44). The next model is the attempted fallback.
          const attemptedModel = host.getNextModel(role, modelIndex - 1);
          const failureMessage = err instanceof Error ? err.message : String(err);
          host.persistRecord({
            type: "session_failed",
            run_id: checkpoint.run_id,
            role,
            visit_index: visitIndex,
            state: checkpoint.current_role,
            model: attemptedModel,
            session_file: SYNTHESIZED_FALLBACK_FAILURE_SESSION_FILE,
            parent_session: parentSessionId,
            usage: ZERO_USAGE,
            failure_reason: `fallback_start_failed: ${failureMessage}`,
            ts: Date.now(),
          });
          roleOutcome = { kind: "failed" };
          break;
        }
        // RoleEscalationError and other errors from the initial spawn
        // propagate up to abort the run. A fallback startup error is
        // handled above so it cannot leave the run nonterminal.
        throw err;
      }

      let inner: InnerOutcome = { kind: "failed" };
      let sessionHostReason: SessionTerminalReason = null;
      let _capturedUsage: UsageRecord = ZERO_USAGE;
      let _nextSeed = seed;
      const sessionResult = await runSession({
        opts,
        def,
        host,
        role,
        visitIndex,
        executionVisitIndex,
        session,
        sessionParentId: parentSessionId,
        seed,
        artifactSeedForVisit,
        checkpoint,
        pendingArtifactRoute,
        pendingForcedEnd,
        parentSessionId,
        handoffContextRef,
        pendingTrajectorySession,
        visitIndexByRole,
        executionVisitIndexByRole,
        nextSeed: seed,
      });
      if (sessionResult.kind === "terminal") return sessionResult.result;
      checkpoint = sessionResult.checkpoint;
      parentSessionId = sessionResult.parentSessionId;
      handoffContextRef = sessionResult.handoffContextRef;
      pendingTrajectorySession = sessionResult.pendingTrajectorySession;
      pendingArtifactRoute = sessionResult.pendingArtifactRoute;
      pendingForcedEnd = sessionResult.pendingForcedEnd;
      artifactSeedForVisit = sessionResult.artifactSeedForVisit;
      inner = sessionResult.inner;
      sessionHostReason = sessionResult.sessionHostReason;
      _capturedUsage = sessionResult.capturedUsage;
      _nextSeed = sessionResult.nextSeed;

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
      if (
        inner.kind === "failed" &&
        sessionHostReason === "model_error" &&
        session.isTrajectory !== true
      ) {
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
      // A worker can return control to the hub. The hub itself has no
      // legal self-handoff, so its already-persisted session_failed is the
      // terminal outcome (§7.2 / §9.4).
      if (role === def.orchestrator) {
        return { finalCheckpoint: checkpoint, exitReason: "session_failed" };
      }

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
        request_end: false,
        target_role: def.orchestrator,
        payload: { reason: "role_unavailable", role: role },
      };
      const result = reduce(checkpoint, synthesized, def, {
        role: role,
        sessionFile: SYNTHESIZED_UNAVAILABLE_SESSION_FILE,
        ts: Date.now(),
      });
      if (result.kind !== "accepted") {
        throw new Error(
          [
            "runLoop: synthesized role-unavailable handoff was rejected",
            `reason=${result.reason}`,
            `current_role=${checkpoint.current_role}`,
            `target_role=${synthesized.target_role}`,
            `legal_targets=${JSON.stringify(result.legal_targets)}`,
            `visit_count=${JSON.stringify(checkpoint.visit_count)}`,
          ].join("; "),
        );
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
      seed = formatRoleUnavailableSeed(role, def.end_request_roles === null);
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
    executionVisitIndexByRole.set(role, executionVisitIndex + 1);
  }

  return { finalCheckpoint: checkpoint, exitReason: "done" };
}

export {
  appendArtifactSeedSection,
  artifactCollectionFailureReason,
  artifactDeliveryFailureReason,
  collectSessionArtifacts,
  formatArtifactsUnavailableSeedSection,
  formatDeferredEndPrompt,
  formatDelegationSettlementPrompt,
  formatHandoffSeed,
  formatRejectionMessage,
  formatRoleUnavailableSeed,
  MAX_NO_EMISSION_RECOVERY_PROMPTS,
  waitForRetry,
  withRoleSessionIdentity,
} from "./loop-format.js";

export type { InnerOutcome, PendingArtifactRoute, RoleOutcome } from "./loop-types.js";

// Type re-exports for downstream convenience.
// Re-export the host types the run-lifecycle entry point (Task 13.5) needs.
export type { Host, PersistedRecord, RoleSession, SeedRunMemoryArgs };
/**
 * Re-export `createInitialCheckpoint` so the run-lifecycle entry point
 * (Task 13.5) can mint + persist the initial checkpoint in one call.
 * Kept here so the loop's callers have a single import surface.
 */
export { createInitialCheckpoint };
