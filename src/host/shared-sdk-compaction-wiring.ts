import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PersistedRecord } from "../persistence/log.js";
import type { SessionState } from "./cost.js";
import { createOrchestratorCompactionController } from "./orchestrator-context-compaction.js";

/** Identity used to stamp compaction records and usage charges. */
export interface SharedCompactionIdentity {
  readonly roleSessionId: string;
  readonly conversationId: string;
  readonly sessionFile: string;
  readonly epoch: number;
}

/** Build the public SDK compaction meter and bind it to a live retained invocation. */
export function createSharedCompactionWiring(options: {
  readonly runId: string;
  readonly role: string;
  readonly persistRecord: (record: PersistedRecord) => void;
  readonly getState: () => SessionState | null;
  readonly getSession: () => AgentSession | null;
}): {
  readonly controller: ReturnType<typeof createOrchestratorCompactionController>;
  setIdentity(identity: SharedCompactionIdentity): void;
} {
  let identity: SharedCompactionIdentity | null = null;
  let ordinal = 0;
  const controller = createOrchestratorCompactionController({
    requestId: () => `${identity?.roleSessionId ?? "unbound"}:compaction:${++ordinal}`,
    onStart: (start) => {
      if (identity === null) throw new Error("compaction started before context binding");
      options.persistRecord({
        schema_version: 1,
        type: "context_compaction_started",
        run_id: options.runId,
        role: options.role,
        epoch: identity.epoch,
        role_session_id: identity.roleSessionId,
        request_id: start.requestId,
        before_leaf_id: start.beforeTip,
        ts: Date.now(),
      });
    },
    onUsage: (chargeId, usage) => {
      const state = options.getState();
      if (usage !== null) {
        state?.addMessageUsage(chargeId, usage);
      }
      if (state?.isSessionCapExceeded() === true) {
        state.markAborted();
        state.setTerminalReason("session_cost_cap_exceeded");
        void options.getSession()?.abort();
      }
    },
    onObservation: (observation) => {
      if (identity === null) throw new Error("compaction observed before context binding");
      options.persistRecord({
        schema_version: 1,
        type: "context_compaction",
        run_id: options.runId,
        role: options.role,
        epoch: identity.epoch,
        role_session_id: identity.roleSessionId,
        request_id: observation.requestId,
        outcome: observation.error === undefined ? "completed" : "failed",
        usage: observation.usage,
        diagnostic: observation.error ?? null,
        before_leaf_id: observation.beforeTip,
        after_leaf_id: observation.afterTip ?? null,
        ts: Date.now(),
      });
    },
  });
  return {
    controller,
    setIdentity: (next) => (identity = next),
  };
}
