/** Retained-context finalization after lifecycle persistence (spec §11/§12, issue #113). */
import type { ContextBoundaryReference } from "../persistence/orchestrator-context.js";
import type { RunFinalizationFailedRecord } from "../persistence/run-finalization.js";
import { capErrorDiagnostic } from "./bounded-diagnostic.js";
import type { SessionLoopContext } from "./loop-session.js";
import type { SessionTurnState } from "./loop-session-turn.js";

/** Always dispose; commit only a captured, fully settled boundary and persist failures. */
export async function finalizeSession(
  ctx: SessionLoopContext,
  state: SessionTurnState,
): Promise<boolean> {
  const { host, session, opts } = ctx;
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
  let boundary: ContextBoundaryReference | null = null;
  let failure: RunFinalizationFailedRecord | null = null;
  const recordFailure = (phase: RunFinalizationFailedRecord["phase"], cause: unknown) => {
    const code =
      cause instanceof Error && "code" in cause && typeof cause.code === "string"
        ? cause.code
        : `${phase}_failed`;
    const message =
      cause instanceof Error ? cause.message : `${phase} failed without an Error diagnostic`;
    failure = {
      schema_version: 1,
      type: "run_finalization_failed",
      run_id: ctx.checkpoint.run_id,
      role: ctx.role,
      role_session_id: session.sessionId,
      session_file: session.sessionFile,
      phase,
      code: capErrorDiagnostic(code.replace(/\p{Cc}/gu, " "), 128).output || `${phase}_failed`,
      diagnostic: capErrorDiagnostic(message.replace(/\p{Cc}/gu, " ")).output || `${phase} failed`,
      recovery: phase === "session_dispose" ? "inspect_disposal" : "reset_orchestrator_context",
      ts: Date.now(),
    };
  };
  if (
    session.retainedContext &&
    state.terminalPersisted &&
    state.delegationSettlementError === null
  ) {
    try {
      boundary = await session.retainedContext.captureBoundary();
    } catch (cause) {
      recordFailure("context_capture", cause);
    }
  }
  opts.runControl?.releaseActiveSession(session);
  let disposed = false;
  try {
    await session.dispose();
    disposed = true;
  } catch (cause) {
    // Preserve the existing non-retained disposal policy; retained failures block reuse.
    if (session.retainedContext) recordFailure("session_dispose", cause);
  }
  if (opts.runControl === undefined) await opts.abortControl?.setActiveSession(null);
  if (boundary && disposed && state.delegationSettlementError === null && session.retainedContext) {
    try {
      await session.retainedContext.commitBoundary(boundary);
    } catch (cause) {
      recordFailure("context_commit", cause);
    }
  }
  if (failure !== null) host.persistRecord(failure);
  if (state.delegationSettlementError !== null) throw state.delegationSettlementError;
  return failure !== null;
}
