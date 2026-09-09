/** Single-session usage and abort operations owned by ProductionHost (spec §11.4). */
import type { UsageRecord } from "../core/types.js";
import type { SessionState } from "./cost.js";
import type { RoleSession, SessionTerminalReason } from "./host.js";
import type { SessionEventSource } from "./session-event-handler.js";

/** Keeps ordinary role-session state available to the extracted host helpers. */
export class ProductionSessionState {
  constructor(
    private readonly sessionStates: Map<string, SessionState>,
    private readonly agentsBySessionId: Map<string, SessionEventSource>,
  ) {}

  captureUsage(session: RoleSession): UsageRecord {
    return (
      this.sessionStates.get(session.sessionId)?.usage() ?? {
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        tokens: 0,
        cost: 0,
      }
    );
  }

  sessionTerminalReason(session: RoleSession): SessionTerminalReason {
    return this.sessionStates.get(session.sessionId)?.terminalReason ?? null;
  }

  sessionFailureDetail(session: RoleSession): string | null {
    return this.sessionStates.get(session.sessionId)?.failureDetail ?? null;
  }

  async abort(session: RoleSession): Promise<void> {
    const state = this.sessionStates.get(session.sessionId);
    const agent = this.agentsBySessionId.get(session.sessionId);
    if (state === undefined || agent === undefined) return;
    if (state.terminalReason === null) {
      state.markAborted();
      state.setTerminalReason("user_aborted");
    }
    await session.abortOwnedWork?.();
    await agent.abort();
  }
}
