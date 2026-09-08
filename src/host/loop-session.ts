/** Session lifecycle owner for one spawned role invocation. */

import { reduceLifecycle } from "../core/reduce-lifecycle.js";
import type {
  Checkpoint,
  HandoffContextRef,
  MachineDefinition,
  Role,
  UsageRecord,
} from "../core/types.js";
import { artifactDelivery } from "../persistence/log.js";
import type { ContextBoundaryReference } from "../persistence/orchestrator-context.js";
import type { Host, RoleSession, SessionTerminalReason } from "./host.js";
import {
  appendArtifactSeedSection,
  artifactDeliveryFailureReason,
  collectSessionArtifacts,
  formatArtifactsUnavailableSeedSection,
  withRoleSessionIdentity,
} from "./loop-format.js";
import { runSessionTurn, type SessionTurnState } from "./loop-session-turn.js";
import type {
  InnerOutcome,
  PendingArtifactRoute,
  RunLoopOptions,
  RunLoopResult,
} from "./loop-types.js";
import { ZERO_USAGE } from "./loop-types.js";

/** Explicit state and host dependencies for one role session lifecycle. */
export interface SessionLoopContext {
  readonly opts: RunLoopOptions;
  readonly def: MachineDefinition;
  readonly host: Host;
  readonly role: Role;
  readonly visitIndex: number;
  readonly executionVisitIndex: number;
  readonly session: RoleSession;
  readonly sessionParentId: string | null;
  readonly seed: string;
  artifactSeedForVisit: string | null;
  checkpoint: Checkpoint;
  pendingArtifactRoute: PendingArtifactRoute | null;
  pendingForcedEnd: boolean;
  parentSessionId: string | null;
  handoffContextRef: HandoffContextRef | null;
  pendingTrajectorySession: RoleSession | null;
  readonly visitIndexByRole: Map<Role, number>;
  readonly executionVisitIndexByRole: Map<Role, number>;
  nextSeed: string;
}

/** Result returned after lifecycle cleanup and child settlement. */
export type SessionLoopResult =
  | {
      readonly kind: "settled";
      readonly inner: InnerOutcome;
      readonly sessionHostReason: SessionTerminalReason;
      readonly capturedUsage: UsageRecord;
      readonly checkpoint: Checkpoint;
      readonly nextSeed: string;
      readonly pendingArtifactRoute: PendingArtifactRoute | null;
      readonly pendingForcedEnd: boolean;
      readonly parentSessionId: string | null;
      readonly handoffContextRef: HandoffContextRef | null;
      readonly pendingTrajectorySession: RoleSession | null;
      readonly artifactSeedForVisit: string | null;
    }
  | {
      readonly kind: "terminal";
      readonly result: {
        readonly finalCheckpoint: Checkpoint;
        readonly exitReason: "done" | "session_failed" | "aborted";
      };
    };

/** Runs one role session from start through settlement and disposal. */
export async function runSession(ctx: SessionLoopContext): Promise<SessionLoopResult> {
  const { opts, def, host, role, visitIndex, session, seed } = ctx;
  const state: SessionTurnState = {
    inner: { kind: "failed" },
    sessionHostReason: null,
    capturedUsage: ZERO_USAGE,
    noEmissionRecoveryPrompts: 0,
    trajectorySeedDeliveryRecorded: false,
    delegationSettled: false,
    delegationSettlementError: null,
    terminalPersisted: false,
  };
  ctx.nextSeed =
    ctx.artifactSeedForVisit === null
      ? seed
      : appendArtifactSeedSection(seed, ctx.artifactSeedForVisit);
  try {
    const sessionId = session.sessionId;
    const sessionFile = session.sessionFile;
    const sessionParentId = ctx.parentSessionId;

    if (ctx.pendingArtifactRoute !== null) {
      if (ctx.pendingArtifactRoute.receiverRole !== role) {
        throw new Error(
          `runLoop: artifact route receiver '${String(
            ctx.pendingArtifactRoute.receiverRole,
          )}' does not match spawned role '${String(role)}'`,
        );
      }

      let artifactSeed = ctx.pendingArtifactRoute.artifactSeed;
      if (ctx.pendingArtifactRoute.status === "unavailable") {
        if (artifactSeed === null || artifactSeed === undefined) {
          const failureReason =
            ctx.pendingArtifactRoute.failureReason ?? "artifact_delivery_failed";
          artifactSeed = formatArtifactsUnavailableSeedSection({
            emittingRole: ctx.pendingArtifactRoute.role,
            emittingVisitIndex: ctx.pendingArtifactRoute.visitIndex,
            phase: "delivery",
            failureReason,
          });
          host.persistRecord(
            artifactDelivery({
              run_id: ctx.checkpoint.run_id,
              role: ctx.pendingArtifactRoute.role,
              visit_index: ctx.pendingArtifactRoute.visitIndex,
              session_id: ctx.pendingArtifactRoute.sessionId,
              receiver_role: ctx.pendingArtifactRoute.receiverRole,
              status: "unavailable",
              artifact_seed: artifactSeed,
              failure_reason: failureReason,
            }),
          );
        }
      } else if (ctx.pendingArtifactRoute.status === "pending" || artifactSeed === undefined) {
        try {
          if (host.routeAcceptedHandoffArtifacts === undefined) {
            throw new Error("host does not provide accepted-handoff artifact routing");
          }
          artifactSeed = await host.routeAcceptedHandoffArtifacts(
            ctx.pendingArtifactRoute,
            session,
          );
          host.persistRecord(
            artifactDelivery({
              run_id: ctx.checkpoint.run_id,
              role: ctx.pendingArtifactRoute.role,
              visit_index: ctx.pendingArtifactRoute.visitIndex,
              session_id: ctx.pendingArtifactRoute.sessionId,
              receiver_role: ctx.pendingArtifactRoute.receiverRole,
              status: "materialized",
              artifact_seed: artifactSeed,
            }),
          );
        } catch (error) {
          const failureReason = artifactDeliveryFailureReason(error);
          artifactSeed = formatArtifactsUnavailableSeedSection({
            emittingRole: ctx.pendingArtifactRoute.role,
            emittingVisitIndex: ctx.pendingArtifactRoute.visitIndex,
            phase: "delivery",
            failureReason,
          });
          host.persistRecord(
            artifactDelivery({
              run_id: ctx.checkpoint.run_id,
              role: ctx.pendingArtifactRoute.role,
              visit_index: ctx.pendingArtifactRoute.visitIndex,
              session_id: ctx.pendingArtifactRoute.sessionId,
              receiver_role: ctx.pendingArtifactRoute.receiverRole,
              status: "unavailable",
              artifact_seed: artifactSeed,
              failure_reason: failureReason,
            }),
          );
        }
      }

      ctx.artifactSeedForVisit = artifactSeed ?? null;
      ctx.pendingArtifactRoute = null;
      ctx.nextSeed =
        ctx.artifactSeedForVisit === null
          ? seed
          : appendArtifactSeedSection(seed, ctx.artifactSeedForVisit);
    }

    // ── §12.1 step 4: session_started for the new session ─────────
    const started = reduceLifecycle(ctx.checkpoint, "session_started", def, {
      role,
      sessionId,
      sessionFile,
      ts: Date.now(),
      visit_index: visitIndex,
      parent_session: sessionParentId,
      model: session.model,
      model_effort: session.effort,
      ...(session.workspace !== undefined ? { workspace: session.workspace } : {}),
    });
    ctx.checkpoint = started.checkpoint;
    host.persistRecord(withRoleSessionIdentity(started.record, session));
    // §11.1: each transition produces a new full ctx.checkpoint snapshot.
    // session_started sets active_role_session; a snapshot here is
    // what resumeRun reads when a run crashed mid-prompt — without
    // it, latestCheckpoint would still point to the previous visit's
    // cleared terminal and crash detection wouldn't fire.
    host.persistRecord({ type: "checkpoint_snapshot", checkpoint: ctx.checkpoint });

    // Track this session as parent for the next session_started.
    ctx.parentSessionId = sessionId;

    const settleDelegationBeforeLifecycle = async (reason: string): Promise<void> => {
      if (state.delegationSettled) return;
      try {
        await host.settleDelegation?.(session, reason);
      } catch (cause) {
        state.delegationSettlementError = cause;
        throw cause;
      }
      state.delegationSettled = true;
    };

    const finishUserAbort = async (usage: UsageRecord): Promise<RunLoopResult> => {
      await settleDelegationBeforeLifecycle("parent session aborted");
      const failed = reduceLifecycle(ctx.checkpoint, "session_failed", def, {
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
      ctx.checkpoint = failed.checkpoint;
      host.persistRecord(withRoleSessionIdentity(failed.record, session));
      state.terminalPersisted = true;
      host.persistRecord({ type: "checkpoint_snapshot", checkpoint: ctx.checkpoint });
      await collectSessionArtifacts(host, session, {
        role,
        visitIndex,
        terminal: "session_failed",
      });
      return { finalCheckpoint: ctx.checkpoint, exitReason: "aborted" };
    };

    const finishEndGuardFailure = async (
      failureReason: "end_guard_exhausted" | "end_guard_cleanup_unconfirmed",
    ): Promise<RunLoopResult> => {
      await settleDelegationBeforeLifecycle(failureReason);
      const failed = reduceLifecycle(ctx.checkpoint, "session_failed", def, {
        role,
        sessionId,
        sessionFile,
        ts: Date.now(),
        visit_index: visitIndex,
        parent_session: sessionParentId,
        usage: state.capturedUsage,
        failureReason,
        model: session.model,
        model_effort: session.effort,
      });
      ctx.checkpoint = failed.checkpoint;
      host.persistRecord(withRoleSessionIdentity(failed.record, session));
      state.terminalPersisted = true;
      host.persistRecord({ type: "checkpoint_snapshot", checkpoint: ctx.checkpoint });
      await collectSessionArtifacts(host, session, {
        role,
        visitIndex,
        terminal: "session_failed",
      });
      return { finalCheckpoint: ctx.checkpoint, exitReason: "session_failed" };
    };

    const turnResult = await runSessionTurn(
      ctx,
      {
        sessionId,
        sessionFile,
        sessionParentId,
        settleDelegationBeforeLifecycle,
        finishUserAbort,
        finishEndGuardFailure,
      },
      state,
    );
    if (turnResult.kind === "terminal") return { kind: "terminal", result: turnResult.result };
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
    if (!state.delegationSettled && state.delegationSettlementError === null) {
      try {
        await host.settleDelegation?.(
          session,
          state.sessionHostReason ??
            (state.inner.kind === "failed" ? "parent session failed" : "parent session settled"),
        );
      } catch (cause) {
        state.delegationSettlementError = cause;
      }
    }
    let retainedBoundary: ContextBoundaryReference | null = null;
    let retentionError: unknown = null;
    const terminalPersisted = state.terminalPersisted;
    if (
      session.retainedContext !== undefined &&
      terminalPersisted &&
      state.delegationSettlementError === null
    ) {
      try {
        retainedBoundary = await session.retainedContext.captureBoundary();
      } catch (cause) {
        retentionError = cause;
      }
    }

    opts.runControl?.releaseActiveSession(session);
    let disposalSucceeded = false;
    await session.dispose().then(
      () => {
        disposalSucceeded = true;
      },
      (disposeError) => {
        if (session.retainedContext !== undefined && retentionError === null) {
          retentionError = disposeError;
        }
      },
    );
    if (opts.runControl === undefined) await opts.abortControl?.setActiveSession(null);
    if (
      retainedBoundary !== null &&
      disposalSucceeded &&
      state.delegationSettlementError === null &&
      session.retainedContext !== undefined
    ) {
      try {
        await session.retainedContext.commitBoundary(retainedBoundary);
      } catch (cause) {
        retentionError = cause;
      }
    }
    if (state.delegationSettlementError !== null)
      await Promise.reject(state.delegationSettlementError);
    if (retentionError !== null) await Promise.reject(retentionError);
  }

  return {
    kind: "settled",
    inner: state.inner,
    sessionHostReason: state.sessionHostReason,
    capturedUsage: state.capturedUsage,
    checkpoint: ctx.checkpoint,
    nextSeed: ctx.nextSeed,
    pendingArtifactRoute: ctx.pendingArtifactRoute,
    pendingForcedEnd: ctx.pendingForcedEnd,
    parentSessionId: ctx.parentSessionId,
    handoffContextRef: ctx.handoffContextRef,
    pendingTrajectorySession: ctx.pendingTrajectorySession,
    artifactSeedForVisit: ctx.artifactSeedForVisit,
  };
}
