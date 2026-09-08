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
 */

import { createInitialCheckpoint, reduce } from "../core/reduce.js";
import type { Checkpoint, HandoffContextRef, MachineEvent, Role } from "../core/types.js";
import type { PersistedRecord } from "../persistence/log.js";
import { summarizePayload } from "../seam/payload-summary.js";
import type { Host, RoleSession, SeedRunMemoryArgs } from "./host.js";
import { runRoleVisit } from "./loop-fallback.js";
import { formatRoleUnavailableSeed } from "./loop-format.js";
import type { PendingArtifactRoute, RunLoopOptions, RunLoopResult } from "./loop-types.js";
import { formatRunMemorySeed } from "./run-memory.js";

// ─── Public API ────────────────────────────────────────────────────────

/** Runs the guarded role orchestration loop. */
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
    // This is scoped to one receiving visit, so every fresh process attempt
    // gets the same host-owned section while the host materializes only once.
    let artifactSeedForVisit: string | null =
      pendingArtifactRoute?.receiverRole === role && pendingArtifactRoute.status !== "pending"
        ? (pendingArtifactRoute.artifactSeed ?? null)
        : null;

    const visitResult = await runRoleVisit({
      opts,
      def,
      host,
      role,
      visitIndex,
      executionVisitIndex,
      seed,
      checkpoint,
      parentSessionId,
      handoffContextRef,
      pendingArtifactRoute,
      pendingForcedEnd,
      pendingTrajectorySession,
      artifactSeedForVisit,
      visitIndexByRole,
      executionVisitIndexByRole,
    });
    if (visitResult.kind === "terminal") return visitResult.result;
    checkpoint = visitResult.checkpoint;
    parentSessionId = visitResult.parentSessionId;
    handoffContextRef = visitResult.handoffContextRef;
    pendingTrajectorySession = visitResult.pendingTrajectorySession;
    pendingArtifactRoute = visitResult.pendingArtifactRoute;
    pendingForcedEnd = visitResult.pendingForcedEnd;
    artifactSeedForVisit = visitResult.artifactSeedForVisit;
    const { roleOutcome } = visitResult;

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

export type {
  InnerOutcome,
  PendingArtifactRoute,
  RoleOutcome,
  RunAbortControl,
  RunLoopOptions,
  RunLoopResult,
} from "./loop-types.js";

// Type re-exports for downstream convenience.
// Re-export the host types the run-lifecycle entry point (Task 13.5) needs.
export type { Host, PersistedRecord, RoleSession, SeedRunMemoryArgs };
/**
 * Re-export `createInitialCheckpoint` so the run-lifecycle entry point
 * (Task 13.5) can mint + persist the initial checkpoint in one call.
 * Kept here so the loop's callers have a single import surface.
 */
export { createInitialCheckpoint };
