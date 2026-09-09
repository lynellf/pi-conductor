/** Accepted machine-event persistence and next-target routing. */

import { reduceLifecycle } from "../core/reduce-lifecycle.js";
import type { Checkpoint, HandoffContextRef, Role, UsageRecord } from "../core/types.js";
import { artifactDelivery, type PersistedRecord } from "../persistence/log.js";
import type { HandoffArgs } from "../seam/schema.js";
import {
  artifactCollectionFailureReason,
  collectSessionArtifacts,
  formatArtifactsUnavailableSeedSection,
  formatHandoffSeed,
  withRoleSessionIdentity,
} from "./loop-format.js";
import type { SessionLoopContext } from "./loop-session.js";
import type { InnerOutcome, PendingArtifactRoute } from "./loop-types.js";
import { formatRunMemorySeed } from "./run-memory.js";
import { TrajectoryHandoffError } from "./trajectory-admission.js";

/** Reducer output retained for accepted transition persistence. */
export interface AcceptedReduction {
  readonly checkpoint: Checkpoint;
  readonly state: Role | "done";
  readonly record: PersistedRecord;
}

/** Validated emission metadata used by accepted transition handling. */
export interface AcceptedEmission {
  readonly type: "handoff" | "end";
  readonly payload: unknown;
}

/** Inputs for persisting an accepted transition and routing its handoff. */
export interface AcceptedTransitionArgs {
  readonly ctx: SessionLoopContext;
  readonly role: Role;
  readonly visitIndex: number;
  readonly session: SessionLoopContext["session"];
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly sessionParentId: string | null;
  readonly state: {
    inner: InnerOutcome;
    capturedUsage: UsageRecord;
    terminalPersisted: boolean;
  };
  readonly reduceResult: AcceptedReduction;
  readonly enrichedRecord: PersistedRecord;
  readonly event: AcceptedEmission;
  readonly acceptedContextRef: HandoffContextRef | null;
  readonly settleDelegationBeforeLifecycle: (reason: string) => Promise<void>;
}

/** State changes produced after accepted transition persistence. */
export interface AcceptedTransitionResult {
  readonly acceptedArtifactRoute: PendingArtifactRoute | null;
  readonly inner: InnerOutcome;
}

/** Persists an accepted transition before artifact and trajectory routing. */
export async function persistAcceptedTransition(
  args: AcceptedTransitionArgs,
): Promise<AcceptedTransitionResult> {
  const { ctx, role, visitIndex, session, sessionId, sessionFile, sessionParentId, state } = args;
  const { opts, def, host } = ctx;
  const validated = { event: args.event };
  const acceptedContextRef = args.acceptedContextRef;
  // A valid machine event remains accepted even if the host cannot
  // collect its optional artifacts. Persist the accepted transition
  // first; artifact failure is a semantic deficiency for the receiver
  // and must never become a session contract breach (§4, §7.3.2).
  // Child settlement is complete before this acceptance becomes
  // durable, while reducer-rejected retries keep their child scope.
  await args.settleDelegationBeforeLifecycle("accepted machine transition");
  host.persistRecord(args.enrichedRecord);
  let acceptedArtifactRoute: PendingArtifactRoute | null =
    validated.event.type === "handoff" &&
    args.reduceResult.state !== "done" &&
    session.artifactCollection !== undefined
      ? {
          role,
          visitIndex,
          sessionId,
          receiverRole: args.reduceResult.state,
          status: "pending",
          artifactSeed: null,
        }
      : null;
  if (acceptedArtifactRoute !== null) {
    host.persistRecord(
      artifactDelivery({
        run_id: ctx.checkpoint.run_id,
        role: acceptedArtifactRoute.role,
        visit_index: acceptedArtifactRoute.visitIndex,
        session_id: acceptedArtifactRoute.sessionId,
        receiver_role: acceptedArtifactRoute.receiverRole,
        status: "pending",
        artifact_seed: null,
      }),
    );
  }

  // The accepted ctx.checkpoint must become durable independently of
  // host-side artifact collection. If collection fails or the process
  // crashes while it runs, resume stays at the accepted receiver.
  ctx.checkpoint = args.reduceResult.checkpoint;
  host.persistRecord({ type: "checkpoint_snapshot", checkpoint: ctx.checkpoint });

  try {
    await collectSessionArtifacts(host, session, {
      role,
      visitIndex,
      terminal: "session_ended",
      ...(validated.event.type === "handoff" && {
        handoff: validated.event.payload as HandoffArgs,
      }),
    });
  } catch (error) {
    if (acceptedArtifactRoute !== null) {
      const failureReason = artifactCollectionFailureReason(error);
      const artifactSeed = formatArtifactsUnavailableSeedSection({
        emittingRole: acceptedArtifactRoute.role,
        emittingVisitIndex: acceptedArtifactRoute.visitIndex,
        phase: "collection",
        failureReason,
      });
      acceptedArtifactRoute = {
        ...acceptedArtifactRoute,
        status: "unavailable",
        artifactSeed,
        failureReason,
      };
      host.persistRecord(
        artifactDelivery({
          run_id: ctx.checkpoint.run_id,
          role: acceptedArtifactRoute.role,
          visit_index: acceptedArtifactRoute.visitIndex,
          session_id: acceptedArtifactRoute.sessionId,
          receiver_role: acceptedArtifactRoute.receiverRole,
          status: "unavailable",
          artifact_seed: artifactSeed,
          failure_reason: failureReason,
        }),
      );
    }
  }
  session.resetCaptureBuffer();

  // ── Accepted (§12.1) ─────────────────────────────────────────
  // 1. The accepted ctx.checkpoint was persisted before host artifact
  // collection so a semantic collection failure cannot erase it.
  // 2. §12.1 step 2: session_ended for the just-finished session.
  // active_role_session was set by session_started above; reduce
  // did NOT clear it (only lifecycle terminals do). session_ended
  // validates meta.sessionId/role against the live session and
  // clears active_role_session.
  await args.settleDelegationBeforeLifecycle("accepted machine transition");
  const ended = reduceLifecycle(ctx.checkpoint, "session_ended", def, {
    role,
    sessionId,
    sessionFile,
    ts: Date.now(),
    visit_index: visitIndex,
    parent_session: sessionParentId,
    usage: state.capturedUsage,
    model: session.model,
    model_effort: session.effort,
  });
  ctx.checkpoint = ended.checkpoint;
  host.persistRecord(withRoleSessionIdentity(ended.record, session));
  state.terminalPersisted = true;
  // §11.1: each transition produces a new full ctx.checkpoint
  // snapshot. session_ended clears active_role_session;
  // persist a fresh snapshot so latestCheckpoint reflects
  // the post-terminal state (active=null). This is what
  // resumeRun reads — a non-null active_role_session on
  // the latest snapshot is the crash signal.
  host.persistRecord({ type: "checkpoint_snapshot", checkpoint: ctx.checkpoint });

  if (args.reduceResult.state === "done") {
    state.inner = { kind: "done" };
    return { acceptedArtifactRoute: null, inner: state.inner };
  }

  // ── Accepted handoff to next role. Prepare the seed for the
  // outer loop's next iteration (§8.3: `suggests_next` is
  // advisory, surfaced as orchestrator context). The host's next
  // spawnRole + session_started (next outer iteration) wires
  // parent_session = sessionId automatically. ─────────────────
  const nextRole: Role = args.reduceResult.state;
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
  ctx.handoffContextRef = acceptedContextRef;
  ctx.nextSeed = formatHandoffSeed(payload, nextRole, suggestsNext, acceptedContextRef);
  ctx.pendingArtifactRoute = acceptedArtifactRoute;
  try {
    const trajectoryTargetSeed =
      nextRole === def.orchestrator
        ? formatRunMemorySeed(
            host.seedRunMemory({
              checkpoint: ctx.checkpoint,
              def,
              goal: opts.initialGoal,
              runCostCap: opts.getRunCostCap?.() ?? opts.runCostCap ?? null,
            }),
          )
        : ctx.nextSeed;
    const selected = await host.selectAcceptedHandoffTransport?.({
      from: role,
      to: nextRole,
      source: session,
      targetSeed: trajectoryTargetSeed,
      targetVisitIndex: ctx.visitIndexByRole.get(nextRole) ?? 1,
      targetExecutionVisitIndex: ctx.executionVisitIndexByRole.get(nextRole) ?? 1,
    });
    if (selected?.mode === "trajectory") ctx.pendingTrajectorySession = selected.session;
  } catch (error) {
    if (error instanceof TrajectoryHandoffError) {
      state.inner = { kind: "failed" };
      return { acceptedArtifactRoute, inner: state.inner };
    }
    throw error;
  }
  state.inner = { kind: "advance", nextSeed: ctx.nextSeed };
  return { acceptedArtifactRoute, inner: state.inner };
}
