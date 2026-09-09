import type { Role } from "../core/types.js";
import type { ToolExecutionPolicy } from "../manifest/execution-policy.js";
import type { PersistedRecord } from "../persistence/log.js";
import type { ToolExecutionRecord } from "../persistence/tool-execution.js";
import type { SessionState } from "./cost.js";
import type { DisplaySink } from "./display-sink.js";
import { bindLiveRoleToolExecution } from "./execution/role-tool-execution-binding.js";
import type {
  ToolExecutionController,
  ToolExecutionError,
} from "./execution/tool-execution-controller.js";
import { toToolExecutionModelError } from "./execution/tool-execution-model-error.js";
import type { RoleTurnProducer } from "./role-turn-producer.js";
import type { CaptureRejector, SessionEventSource } from "./session-event-handler.js";

/** Inputs needed to bind the first live shared SDK role invocation. */
export interface SharedSdkStartupBindingOptions {
  readonly runId: string;
  readonly role: Role;
  readonly visitIndex: number;
  readonly roleSessionId: string;
  readonly policy: Readonly<Required<ToolExecutionPolicy>>;
  readonly priorRecords?: readonly ToolExecutionRecord[];
  readonly persist: (record: PersistedRecord) => void;
  readonly session: SessionEventSource;
  readonly state: SessionState;
  readonly sessionFile: string;
  readonly sessionStates: Map<string, SessionState>;
  readonly agentsBySessionId: Map<string, SessionEventSource>;
  readonly rejector: CaptureRejector;
  readonly roleTurnProducer: RoleTurnProducer;
  readonly conversationId: string;
  readonly displaySink?: DisplaySink;
  readonly getActiveState: () => SessionState | null;
  readonly abort: () => Promise<void>;
}

/** Bind startup accounting and event handling for one shared SDK session. */
export function bindSharedSdkStartupRole(options: SharedSdkStartupBindingOptions): {
  readonly controller: ToolExecutionController;
  readonly unsubscribe: () => void;
} {
  return bindLiveRoleToolExecution({
    runId: options.runId,
    role: options.role,
    visitIndex: options.visitIndex,
    roleSessionId: options.roleSessionId,
    policy: options.policy,
    ...(options.priorRecords === undefined ? {} : { priorRecords: options.priorRecords }),
    persist: options.persist,
    session: options.session,
    state: options.state,
    sessionFile: options.sessionFile,
    sessionStates: options.sessionStates,
    agentsBySessionId: options.agentsBySessionId,
    rejector: options.rejector,
    roleTurn: {
      producer: options.roleTurnProducer,
      context: {
        runId: options.runId,
        role: options.role,
        roleSessionId: options.roleSessionId,
        conversationId: options.conversationId,
        sessionFile: options.sessionFile,
        persist: options.persist,
      },
    },
    ...(options.displaySink === undefined ? {} : { displaySink: options.displaySink }),
    onFatal: (error: ToolExecutionError) => {
      options
        .getActiveState()
        ?.setTerminalReason(
          error.code === "tool_timeout_exhausted"
            ? "tool_timeout_exhausted"
            : "tool_cleanup_unconfirmed",
          toToolExecutionModelError(error).message,
        );
      void options.abort();
    },
  });
}
