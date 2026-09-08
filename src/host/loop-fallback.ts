/** One role visit: spawn, run the session, and apply model retry/fallback policy. */

import type {
  Checkpoint,
  HandoffContextRef,
  MachineDefinition,
  Role,
  UsageRecord,
} from "../core/types.js";
import { NoMoreModelsError } from "./errors.js";
import type { Host, RoleSession, SessionTerminalReason } from "./host.js";
import { waitForRetry } from "./loop-format.js";
import { runSession } from "./loop-session.js";
import type {
  InnerOutcome,
  PendingArtifactRoute,
  RoleOutcome,
  RunLoopOptions,
} from "./loop-types.js";
import { ZERO_USAGE } from "./loop-types.js";

const SYNTHESIZED_FALLBACK_FAILURE_SESSION_FILE = "<synthesized:session-failed:fallback-start>";

/** Explicit state and dependencies for one role visit across model attempts. */
export interface RoleVisitContext {
  readonly opts: RunLoopOptions;
  readonly def: MachineDefinition;
  readonly host: Host;
  readonly role: Role;
  readonly visitIndex: number;
  readonly executionVisitIndex: number;
  readonly seed: string;
  readonly checkpoint: Checkpoint;
  readonly parentSessionId: string | null;
  readonly handoffContextRef: HandoffContextRef | null;
  readonly pendingArtifactRoute: PendingArtifactRoute | null;
  readonly pendingForcedEnd: boolean;
  readonly pendingTrajectorySession: RoleSession | null;
  readonly artifactSeedForVisit: string | null;
  readonly visitIndexByRole: Map<Role, number>;
  readonly executionVisitIndexByRole: Map<Role, number>;
}

/** Result of a role visit, including terminal or fallback-settled outcomes. */
export type RoleVisitResult =
  | {
      readonly kind: "terminal";
      readonly result: {
        readonly finalCheckpoint: Checkpoint;
        readonly exitReason: "done" | "session_failed" | "aborted";
      };
    }
  | {
      readonly kind: "settled";
      readonly checkpoint: Checkpoint;
      readonly parentSessionId: string | null;
      readonly handoffContextRef: HandoffContextRef | null;
      readonly pendingTrajectorySession: RoleSession | null;
      readonly pendingArtifactRoute: PendingArtifactRoute | null;
      readonly pendingForcedEnd: boolean;
      readonly artifactSeedForVisit: string | null;
      readonly inner: InnerOutcome;
      readonly sessionHostReason: SessionTerminalReason;
      readonly capturedUsage: UsageRecord;
      readonly roleOutcome: RoleOutcome;
    };

/** Executes one role's model attempts while preserving visit-level state. */
export async function runRoleVisit(ctx: RoleVisitContext): Promise<RoleVisitResult> {
  const {
    opts,
    def,
    host,
    role,
    visitIndex,
    executionVisitIndex,
    seed,
    checkpoint: initialCheckpoint,
    parentSessionId: initialParentSessionId,
    handoffContextRef: initialHandoffContextRef,
    pendingArtifactRoute: initialPendingArtifactRoute,
    pendingForcedEnd: initialPendingForcedEnd,
    pendingTrajectorySession: initialPendingTrajectorySession,
    artifactSeedForVisit: initialArtifactSeedForVisit,
    visitIndexByRole,
    executionVisitIndexByRole,
  } = ctx;
  let checkpoint = initialCheckpoint;
  let parentSessionId = initialParentSessionId;
  let handoffContextRef = initialHandoffContextRef;
  let pendingArtifactRoute = initialPendingArtifactRoute;
  let pendingForcedEnd = initialPendingForcedEnd;
  let pendingTrajectorySession = initialPendingTrajectorySession;
  let artifactSeedForVisit = initialArtifactSeedForVisit;
  let modelIndex = 0;
  let retryAttempt = 0;
  let roleOutcome: RoleOutcome = { kind: "advance", nextSeed: seed };
  let inner: InnerOutcome = { kind: "failed" };
  let sessionHostReason: SessionTerminalReason = null;
  let capturedUsage: UsageRecord = ZERO_USAGE;

  while (true) {
    let session: RoleSession;
    try {
      if (pendingTrajectorySession !== null) {
        session = pendingTrajectorySession;
        pendingTrajectorySession = null;
      } else {
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
      throw err;
    }

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
    if (sessionResult.kind === "terminal") return sessionResult;
    checkpoint = sessionResult.checkpoint;
    parentSessionId = sessionResult.parentSessionId;
    handoffContextRef = sessionResult.handoffContextRef;
    pendingTrajectorySession = sessionResult.pendingTrajectorySession;
    pendingArtifactRoute = sessionResult.pendingArtifactRoute;
    pendingForcedEnd = sessionResult.pendingForcedEnd;
    artifactSeedForVisit = sessionResult.artifactSeedForVisit;
    inner = sessionResult.inner;
    sessionHostReason = sessionResult.sessionHostReason;
    capturedUsage = sessionResult.capturedUsage;

    if (
      inner.kind === "failed" &&
      sessionHostReason === "model_error" &&
      session.isTrajectory !== true
    ) {
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
      continue;
    }

    roleOutcome =
      inner.kind === "done"
        ? { kind: "done" }
        : inner.kind === "failed"
          ? { kind: "failed" }
          : { kind: "advance", nextSeed: inner.nextSeed };
    break;
  }

  return {
    kind: "settled",
    checkpoint,
    parentSessionId,
    handoffContextRef,
    pendingTrajectorySession,
    pendingArtifactRoute,
    pendingForcedEnd,
    artifactSeedForVisit,
    inner,
    sessionHostReason,
    capturedUsage,
    roleOutcome,
  };
}
