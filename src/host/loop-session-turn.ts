/** One role-session retry boundary keeps prompt, cleanup, cost-cap, and end-guard precedence together. */
import { reduce } from "../core/reduce.js";
import { reduceLifecycle } from "../core/reduce-lifecycle.js";
import type { HandoffContextRef, UsageRecord } from "../core/types.js";
import { sha256Canonical } from "../persistence/trajectory-records.js";
import { summarizePayload } from "../seam/payload-summary.js";
import { validateEmission } from "../seam/validate-emission.js";
import { createAcceptedControlV2 } from "./accepted-control-v2.js";
import { persistHandoffValidationFailures } from "./accepted-handoff-rejection.js";
import { prepareAcceptedHandoffAtLoopBoundary } from "./accepted-handoff-validation.js";
import { formatControllerFailure } from "./controller/failure-diagnostic.js";
import { runEndGuardAttempt } from "./end-guard-loop.js";
import { formatNoEmissionRecovery } from "./handoff-contract.js";
import type { SessionTerminalReason } from "./host.js";
import {
  collectSessionArtifacts,
  formatDeferredEndPrompt,
  formatDelegationSettlementPrompt,
  formatRejectionMessage,
  MAX_NO_EMISSION_RECOVERY_PROMPTS,
  notifyControllerOfFinishRejection,
  withRoleSessionIdentity,
} from "./loop-format.js";
import { finishHostRunCostCap, forceRunCostCapEnd } from "./loop-run-cost-cap.js";
import type { SessionLoopContext } from "./loop-session.js";
import { persistAcceptedTransition } from "./loop-session-accepted.js";
import type { InnerOutcome, RunLoopResult } from "./loop-types.js";
import { RpcChildExitError } from "./rpc/protocol.js";
import { formatGuidedPrompt } from "./run-control.js";

const SYNTHESIZED_SESSION_FILE = "<synthesized:end:run-cost-cap>";
/** Mutable state accumulated while one role session is active. */
export interface SessionTurnState {
  inner: InnerOutcome;
  sessionHostReason: SessionTerminalReason;
  capturedUsage: UsageRecord;
  noEmissionRecoveryPrompts: number;
  trajectorySeedDeliveryRecorded: boolean;
  delegationSettled: boolean;
  delegationSettlementError: unknown;
  terminalPersisted: boolean;
}

/** Host and lifecycle callbacks required by the turn processor. */
export interface SessionTurnDeps {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly sessionParentId: string | null;
  readonly settleDelegationBeforeLifecycle: (reason: string) => Promise<void>;
  readonly finishUserAbort: (usage: UsageRecord) => Promise<RunLoopResult>;
  readonly finishEndGuardFailure: (
    failureReason: "end_guard_exhausted" | "end_guard_cleanup_unconfirmed",
  ) => Promise<RunLoopResult>;
}

/** Result indicating whether the session settled or the run terminated. */
export type SessionTurnResult =
  | { readonly kind: "settled"; readonly state: SessionTurnState }
  | { readonly kind: "terminal"; readonly result: RunLoopResult };

/** Processes prompts and captured emissions until this session settles. */
export async function runSessionTurn(
  ctx: SessionLoopContext,
  deps: SessionTurnDeps,
  state: SessionTurnState,
): Promise<SessionTurnResult> {
  const { opts, def, host, role, visitIndex, session } = ctx;
  const {
    sessionId,
    sessionFile,
    sessionParentId,
    settleDelegationBeforeLifecycle,
    finishUserAbort,
    finishEndGuardFailure,
  } = deps;
  while (true) {
    if (opts.runControl !== undefined) {
      await opts.runControl.setActiveSession(session);
    } else {
      await opts.abortControl?.setActiveSession(session);
    }
    const prePromptHostReason = host.sessionTerminalReason(session);
    if (prePromptHostReason === "user_aborted") {
      state.capturedUsage = host.captureUsage(session);
      state.inner = { kind: "failed" };
      return { kind: "terminal", result: await finishUserAbort(state.capturedUsage) };
    }

    let promptError: unknown = null;
    try {
      const promptSeed = formatGuidedPrompt(
        ctx.nextSeed,
        opts.runControl?.takePendingGuidance() ?? [],
      );
      await session.prompt(promptSeed);
      if (session.isTrajectory === true && !state.trajectorySeedDeliveryRecorded) {
        host.persistRecord({
          type: "trajectory_target_seed_delivered",
          schema_version: 1,
          run_id: ctx.checkpoint.run_id,
          role_session_id: sessionId,
          conversation_id: session.conversationId ?? sessionId,
          seed_sha256: sha256Canonical(ctx.nextSeed),
          ts: Date.now(),
        });
        state.trajectorySeedDeliveryRecorded = true;
      }
    } catch (err) {
      promptError = err;
    }
    state.capturedUsage = host.captureUsage(session);

    const hostReasonOnPrompt = host.sessionTerminalReason(session);
    if (hostReasonOnPrompt === "user_aborted") {
      state.sessionHostReason = hostReasonOnPrompt;
      state.inner = { kind: "failed" };
      return { kind: "terminal", result: await finishUserAbort(state.capturedUsage) };
    }
    const hostTermination = session.getHostTermination?.() ?? null;
    if (hostTermination?.kind === "run_cost_cap") {
      const closed = await finishHostRunCostCap({
        checkpoint: ctx.checkpoint,
        def,
        host,
        session,
        visitIndex,
        parentSessionId: sessionParentId,
        usage: state.capturedUsage,
        settle: () => settleDelegationBeforeLifecycle("run cost cap forced close"),
        collect: () =>
          collectSessionArtifacts(host, session, { role, visitIndex, terminal: "session_ended" }),
      });
      if (closed !== null) {
        ctx.checkpoint = closed;
        state.terminalPersisted = true;
        return {
          kind: "terminal",
          result: { finalCheckpoint: ctx.checkpoint, exitReason: "done" },
        };
      }
    }
    // An isolated RPC child exiting before turn settlement is a contract
    // breach. Keep the failure reason stable and loop-owned rather than
    // exposing the child stderr/code or throwing past lifecycle cleanup.
    const promptFailureReason =
      promptError instanceof RpcChildExitError
        ? "rpc_child_exit"
        : promptError !== null && session.sessionOrigin?.kind === "controller"
          ? "controller_failed"
          : null;
    if (promptError !== null && hostReasonOnPrompt === null && promptFailureReason === null) {
      throw promptError;
    }

    persistHandoffValidationFailures({
      failures: session.takeHandoffValidationFailures?.() ?? [],
      host,
      runId: ctx.checkpoint.run_id,
      role,
      sessionId,
      sessionFile,
    });

    const captures = session.readCaptureBuffer();
    const validated = validateEmission(
      captures,
      host.controlProtocol === "v2"
        ? {
            protocol: role === def.orchestrator ? "v2-orchestrator" : "v2-worker",
            ...(role === def.orchestrator
              ? {}
              : {
                  workerTargetRole: def.orchestrator,
                  workerRequestEndAuthorized: def.end_request_roles?.includes(role) === true,
                }),
          }
        : {},
    );

    if (validated.kind === "breach") {
      // The host may also have terminated the session (e.g., the
      // per-session cap fired on `turn_end` and called `abort()`,
      // Task 17). The host's reason, when set, takes precedence
      // over the buffer-derived reason: a cap-terminated session
      // still has an empty buffer, but the host knows WHY it
      // terminated. For model errors (Task 18) the same path
      // applies — the host's reason reflects the upstream cause.
      const hostReason = host.sessionTerminalReason(session);
      state.sessionHostReason = hostReason;
      if (
        hostReason === null &&
        promptFailureReason === null &&
        validated.reason === "no_emission" &&
        state.noEmissionRecoveryPrompts < MAX_NO_EMISSION_RECOVERY_PROMPTS
      ) {
        state.noEmissionRecoveryPrompts += 1;
        ctx.nextSeed = formatNoEmissionRecovery(role, def, host.controlProtocol ?? "v1");
        continue;
      }
      const failureReason: string = hostReason ?? promptFailureReason ?? validated.reason;
      const failureDetail =
        hostReason !== null
          ? (host.sessionFailureDetail?.(session) ?? null)
          : promptFailureReason === "controller_failed"
            ? formatControllerFailure(promptError)
            : hostReason === null &&
                promptFailureReason === null &&
                validated.reason === "no_emission"
              ? `${state.noEmissionRecoveryPrompts} recovery prompts attempted`
              : null;
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
        ...(failureDetail !== null && { failureDetail }),
        model: session.model,
        model_effort: session.effort,
      });
      ctx.checkpoint = failed.checkpoint;
      host.persistRecord(withRoleSessionIdentity(failed.record, session));
      state.terminalPersisted = true;
      // §11.1: each transition produces a new full ctx.checkpoint
      // snapshot. session_failed clears active_role_session;
      // persist a fresh snapshot so latestCheckpoint reflects
      // the post-terminal state (active=null).
      host.persistRecord({ type: "checkpoint_snapshot", checkpoint: ctx.checkpoint });
      await collectSessionArtifacts(host, session, {
        role,
        visitIndex,
        terminal: "session_failed",
      });
      state.inner = { kind: "failed" };
      break;
    }
    // Evaluate the persisted rollup plus this terminal before the captured event (§11.7).
    const runCap = opts.getRunCostCap?.() ?? opts.runCostCap ?? null;
    const runCapBreached =
      runCap !== null && host.runCostSoFar() + state.capturedUsage.cost >= runCap;
    const capturedIsHandoff = validated.event.type === "handoff";

    if (
      runCapBreached &&
      role === def.orchestrator &&
      (capturedIsHandoff || validated.event.type === "end")
    ) {
      // ── Orchestrator current: synthesize end, reduce it.
      // The captured handoff is SUPERSEDED; no worker is
      // spawned. session_ended for the orchestrator is
      // recorded normally first (it carries the captured
      // usage — both terminals cost, §11.4), then the
      // synthesized transition_accepted ends the run.
      await settleDelegationBeforeLifecycle("run cost cap forced close");
      // Known-settled delegation safety failures use the common
      // session_failed path below; never synthesize an accepted end.
      if (host.sessionTerminalReason(session) !== "delegation_failed") {
        ctx.checkpoint = forceRunCostCapEnd({
          checkpoint: ctx.checkpoint,
          def,
          host,
          active: {
            session,
            visitIndex,
            parentSessionId: sessionParentId,
            usage: state.capturedUsage,
          },
        });
        state.terminalPersisted = true;
        await collectSessionArtifacts(host, session, {
          role,
          visitIndex,
          terminal: "session_ended",
        });
        return {
          kind: "terminal",
          result: { finalCheckpoint: ctx.checkpoint, exitReason: "done" },
        };
      }
    }
    if (runCapBreached && role !== def.orchestrator && capturedIsHandoff) {
      // ── Worker current: defer the synthesized end.
      // `end` from a worker is rejected (§7.2/§12.1). Let the
      // worker's natural handoff to the orchestrator reduce
      // normally (worker → orch is the only legal target,
      // §6); on the next outer iteration, the deferred-end
      // branch above synthesizes the end. The cap is still a
      // hard stop — no further dispatch, no orchestrator
      // session in between.
      await settleDelegationBeforeLifecycle("run cost cap forced close");
      if (host.sessionTerminalReason(session) !== "delegation_failed") ctx.pendingForcedEnd = true;
    }

    // A host terminal reason supersedes even a non-empty capture.
    const hostReasonOnOk = host.sessionTerminalReason(session);
    const terminalReasonOnOk = hostReasonOnOk ?? promptFailureReason;
    if (terminalReasonOnOk !== null) {
      state.sessionHostReason = hostReasonOnOk;
      const failureDetail =
        hostReasonOnOk !== null ? (host.sessionFailureDetail?.(session) ?? null) : null;
      await settleDelegationBeforeLifecycle(terminalReasonOnOk);
      const failed = reduceLifecycle(ctx.checkpoint, "session_failed", def, {
        role,
        sessionId,
        sessionFile,
        ts: Date.now(),
        visit_index: visitIndex,
        parent_session: sessionParentId,
        usage: state.capturedUsage,
        failureReason: terminalReasonOnOk,
        ...(failureDetail !== null && { failureDetail }),
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
      state.inner = { kind: "failed" };
      break;
    }

    // A parent cannot commit a machine transition while one of its
    // accepted delegated children is still queued or running. Keep the
    // same role session open so the model can wait for or cancel the
    // listed children; reducing first would make the parent terminal
    // durable before child cleanup (§7.2, §12.1).
    if (validated.event.type === "handoff" || validated.event.type === "end") {
      const pendingChildren = host.pendingDelegationTasks?.(session) ?? [];
      if (pendingChildren.length > 0) {
        session.resetCaptureBuffer();
        opts.runControl?.reopenActiveSession(session);
        ctx.nextSeed = formatDelegationSettlementPrompt(pendingChildren);
        continue;
      }
    }

    // Operator guidance that arrives after a valid `end` capture but
    // before reduction wins this boundary. The end has not been
    // committed, so discard the capture, reopen the same orchestrator
    // session, and deliver the guidance through the next prompt.
    if (validated.event.type === "end" && opts.runControl?.hasPendingGuidance() === true) {
      session.resetCaptureBuffer();
      opts.runControl.reopenActiveSession(session);
      ctx.nextSeed = formatDeferredEndPrompt();
      continue;
    }

    const useV2Control = host.controlProtocol === "v2";
    const acceptedEnvelope =
      !useV2Control && validated.event.type === "handoff"
        ? await prepareAcceptedHandoffAtLoopBoundary({
            event: validated.event,
            host,
            runId: ctx.checkpoint.run_id,
            role,
            sessionId,
            sessionFile,
            policy: readContinuityPolicyFromOpts(opts),
            authority: readContinuityAuthorityFromOpts(opts, ctx),
            knownItemIds: readKnownContinuityItemIdsFromOpts(opts),
            resetCapture: () => session.resetCaptureBuffer(),
            reopen: () => opts.runControl?.reopenActiveSession(session),
            setCorrection: (correction) => {
              ctx.nextSeed = correction;
            },
          })
        : null;
    if (!useV2Control && validated.event.type === "handoff" && acceptedEnvelope === null) continue;

    // ── Single valid emission — call reduce (§12) ──────────────
    let reduceResult = reduce(ctx.checkpoint, validated.event, def, {
      role,
      sessionFile,
      ts: Date.now(),
    });
    const acceptedContextRef: HandoffContextRef | null =
      reduceResult.kind === "accepted" && validated.event.type === "handoff"
        ? {
            run_id: ctx.checkpoint.run_id,
            source_role: role,
            source_session_file: sessionFile,
          }
        : null;
    const acceptedControl =
      useV2Control && reduceResult.kind === "accepted" && validated.event.type === "handoff"
        ? createAcceptedControlV2({
            sourceRole: role,
            orchestratorRole: def.orchestrator,
            recipientRole: reduceResult.state,
            reportedArguments: validated.event.payload,
          })
        : undefined;
    let enrichedRecord: typeof reduceResult.record =
      reduceResult.kind === "accepted"
        ? {
            ...reduceResult.record,
            payload_summary: useV2Control
              ? { field_names: [] }
              : summarizePayload(validated.event.payload),
            context_ref: acceptedContextRef,
            ...(reduceResult.record.event === "handoff" &&
              acceptedEnvelope !== null && { accepted_handoff: acceptedEnvelope }),
            ...(acceptedControl === undefined ? {} : { accepted_control: acceptedControl }),
          }
        : reduceResult.record;
    if (reduceResult.kind === "rejected") {
      const rejectedRecord = reduceResult.record;
      host.persistRecord(rejectedRecord);
      await notifyControllerOfFinishRejection(session, {
        kind: "machine_rejected",
        source: rejectedRecord,
      });
      // A rejected event keeps the live session open, so its next
      // capture must become the sole seam candidate.
      session.resetCaptureBuffer();
      ctx.nextSeed = formatRejectionMessage(reduceResult);
      continue;
    }

    if (
      opts.endGuard !== undefined &&
      role === def.orchestrator &&
      validated.event.type === "end" &&
      validated.event.authority === "role"
    ) {
      const capBeforeGuard = opts.getRunCostCap?.() ?? opts.runCostCap ?? null;
      const forcedCloseBeforeGuard =
        capBeforeGuard !== null && host.runCostSoFar() + state.capturedUsage.cost >= capBeforeGuard;
      const guardOutcome = forcedCloseBeforeGuard
        ? { kind: "passed" as const, diagnostic: "run cost cap forced close" }
        : await runEndGuardAttempt({
            host,
            session,
            runId: ctx.checkpoint.run_id,
            role,
            requestId: opts.endGuard.requestId(ctx.checkpoint),
            config: opts.endGuard.config,
            records: opts.endGuard.records,
            persist: (record) => host.persistRecord(record),
          });
      const capAfterGuard = opts.getRunCostCap?.() ?? opts.runCostCap ?? null;
      const forcedCloseAfterGuard =
        capAfterGuard !== null && host.runCostSoFar() + state.capturedUsage.cost >= capAfterGuard;
      if (guardOutcome.kind === "fatal") {
        return {
          kind: "terminal",
          result: await finishEndGuardFailure("end_guard_cleanup_unconfirmed"),
        };
      }
      if (guardOutcome.kind === "aborted" || opts.runControl?.isAbortRequested() === true) {
        return { kind: "terminal", result: await finishUserAbort(state.capturedUsage) };
      }
      if (forcedCloseAfterGuard) {
        reduceResult = reduce(
          ctx.checkpoint,
          {
            type: "end",
            authority: "run_cost_cap",
            payload: { reason: "run_cost_cap_exceeded" },
          },
          def,
          {
            role: def.orchestrator,
            sessionFile: SYNTHESIZED_SESSION_FILE,
            ts: Date.now(),
          },
        );
        enrichedRecord =
          reduceResult.kind === "accepted"
            ? {
                ...reduceResult.record,
                payload_summary: summarizePayload({ reason: "run_cost_cap_exceeded" }),
                context_ref: null,
              }
            : reduceResult.record;
      }
      if (guardOutcome.kind === "exhausted" && !forcedCloseAfterGuard) {
        return { kind: "terminal", result: await finishEndGuardFailure("end_guard_exhausted") };
      }
      if (guardOutcome.kind === "retry" && !forcedCloseAfterGuard) {
        await notifyControllerOfFinishRejection(session, {
          kind: "end_guard_retry",
          source: guardOutcome.source,
        });
        session.resetCaptureBuffer();
        opts.runControl?.reopenActiveSession(session);
        ctx.nextSeed = `The end guard did not pass. Repair the workspace and emit a valid end request again. Guard diagnostics: ${guardOutcome.diagnostic}`;
        continue;
      }
      if (!forcedCloseAfterGuard && opts.runControl?.hasPendingGuidance() === true) {
        session.resetCaptureBuffer();
        opts.runControl.reopenActiveSession(session);
        ctx.nextSeed = formatDeferredEndPrompt();
        continue;
      }
    }

    const accepted = await persistAcceptedTransition({
      ctx,
      role,
      visitIndex,
      session,
      sessionId,
      sessionFile,
      sessionParentId,
      state,
      reduceResult,
      enrichedRecord,
      event: validated.event,
      acceptedContextRef,
      settleDelegationBeforeLifecycle,
    });
    state.inner = accepted.inner;
    break;
  }
  return { kind: "settled", state };
}

/**
 * Read the optional continuity policy from `opts`. The host wires the
 * pinned policy at run-start; tests inject a policy through this hook.
 * Returns `null` when the manifest omits continuity (legacy preservation).
 */
function readContinuityPolicyFromOpts(
  opts: SessionLoopContext["opts"],
): { readonly require_handoff: boolean } | null {
  return opts.continuityPolicy ?? null;
}

/**
 * Read the optional host-supplied `ContinuityEvidenceAuthority` from
 * `opts`. Returns a default permissive authority when absent so callers
 * don't need to wire one in for legacy runs; production wiring lives in
 * the host (Phase 3 integration).
 */
function readContinuityAuthorityFromOpts(
  opts: SessionLoopContext["opts"],
  ctx: SessionLoopContext,
): import("./continuity-evidence.js").ContinuityEvidenceAuthority {
  const candidate = opts.continuityAuthority?.({ role: ctx.role, visit: ctx.visitIndex });
  if (candidate !== undefined) return candidate;
  return {
    audience: { run_id: ctx.checkpoint.run_id, role: ctx.role, visit_index: ctx.visitIndex },
    toolExecutions: { belongsToRun: () => false },
    contextArtifacts: { canRead: () => false },
    repository: { resolveCommit: async () => ({ status: "missing" }) },
  };
}

/**
 * Read the optional set of continuity item IDs already present in the
 * current ledger. The host materializer tracks these at run time;
 * tests can supply a static set.
 */
function readKnownContinuityItemIdsFromOpts(opts: SessionLoopContext["opts"]): ReadonlySet<string> {
  return opts.knownContinuityItemIds?.() ?? new Set<string>();
}
