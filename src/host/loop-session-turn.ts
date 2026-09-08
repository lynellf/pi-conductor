/** Prompt, admission, failure, cost-cap, and end-guard handling for one role session. */
// This module stays under 500 lines because the prompt/admission/end-guard state machine is one
// coherent retry boundary; splitting individual branches would obscure its ordering contract.

import { reduce } from "../core/reduce.js";
import { reduceLifecycle } from "../core/reduce-lifecycle.js";
import type { HandoffContextRef, MachineEvent, UsageRecord } from "../core/types.js";
import { sha256Canonical } from "../persistence/trajectory-records.js";
import { summarizePayload } from "../seam/payload-summary.js";
import { validateEmission } from "../seam/validate-emission.js";
import { runEndGuardAttempt } from "./end-guard-loop.js";
import { formatNoEmissionRecovery } from "./handoff-contract.js";
import type { SessionTerminalReason } from "./host.js";
import {
  collectSessionArtifacts,
  formatDeferredEndPrompt,
  formatDelegationSettlementPrompt,
  formatRejectionMessage,
  MAX_NO_EMISSION_RECOVERY_PROMPTS,
  withRoleSessionIdentity,
} from "./loop-format.js";
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
  // ── Inner loop: prompt → validate → reduce (with retry on rejection) ──
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
    // An isolated RPC child exiting before turn settlement is a contract
    // breach. Keep the failure reason stable and loop-owned rather than
    // exposing the child stderr/code or throwing past lifecycle cleanup.
    const promptFailureReason = promptError instanceof RpcChildExitError ? "rpc_child_exit" : null;
    if (promptError !== null && hostReasonOnPrompt === null && promptFailureReason === null) {
      throw promptError;
    }

    for (const failure of session.takeHandoffValidationFailures?.() ?? []) {
      host.persistRecord({
        type: "handoff_validation_rejected",
        run_id: ctx.checkpoint.run_id,
        role,
        session_id: sessionId,
        session_file: sessionFile,
        missing_fields: failure.missingFields,
        invalid_fields: failure.invalidFields,
        ts: Date.now(),
      });
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
      state.sessionHostReason = hostReason;
      if (
        hostReason === null &&
        promptFailureReason === null &&
        validated.reason === "no_emission" &&
        state.noEmissionRecoveryPrompts < MAX_NO_EMISSION_RECOVERY_PROMPTS
      ) {
        state.noEmissionRecoveryPrompts += 1;
        ctx.nextSeed = formatNoEmissionRecovery(role, def);
        continue;
      }
      const failureReason: string = hostReason ?? promptFailureReason ?? validated.reason;
      const failureDetail =
        hostReason === "model_error" || hostReason === "delegation_failed"
          ? (host.sessionFailureDetail?.(session) ?? null)
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
      const ended = reduceLifecycle(ctx.checkpoint, "session_ended", def, {
        role,
        sessionId,
        sessionFile,
        ts: Date.now(),
        visit_index: visitIndex,
        parent_session: sessionParentId,
        usage: state.capturedUsage,
      });
      ctx.checkpoint = ended.checkpoint;
      host.persistRecord(withRoleSessionIdentity(ended.record, session));
      state.terminalPersisted = true;
      host.persistRecord({ type: "checkpoint_snapshot", checkpoint: ctx.checkpoint });
      await collectSessionArtifacts(host, session, {
        role,
        visitIndex,
        terminal: "session_ended",
      });

      const synthesized: MachineEvent = {
        type: "end",
        authority: "run_cost_cap",
        payload: { reason: "run_cost_cap_exceeded" },
      };
      const result = reduce(ctx.checkpoint, synthesized, def, {
        role: def.orchestrator,
        sessionFile: SYNTHESIZED_SESSION_FILE,
        ts: Date.now(),
      });
      host.persistRecord(result.record);
      ctx.checkpoint = result.checkpoint;
      host.persistRecord({ type: "checkpoint_snapshot", checkpoint: ctx.checkpoint });
      return { kind: "terminal", result: { finalCheckpoint: ctx.checkpoint, exitReason: "done" } };
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
      ctx.pendingForcedEnd = true;
      await settleDelegationBeforeLifecycle("run cost cap forced close");
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
    const terminalReasonOnOk = hostReasonOnOk ?? promptFailureReason;
    if (terminalReasonOnOk !== null) {
      state.sessionHostReason = hostReasonOnOk;
      const failureDetail =
        hostReasonOnOk === "model_error" || hostReasonOnOk === "delegation_failed"
          ? (host.sessionFailureDetail?.(session) ?? null)
          : null;
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

    // ── Single valid emission — call reduce (§12) ──────────────
    let reduceResult = reduce(ctx.checkpoint, validated.event, def, {
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
            run_id: ctx.checkpoint.run_id,
            source_role: role,
            source_session_file: sessionFile,
          }
        : null;
    let enrichedRecord: typeof reduceResult.record =
      reduceResult.kind === "accepted"
        ? {
            ...reduceResult.record,
            payload_summary: summarizePayload(validated.event.payload),
            context_ref: acceptedContextRef,
          }
        : reduceResult.record;
    if (reduceResult.kind === "rejected") {
      host.persistRecord(enrichedRecord);
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
