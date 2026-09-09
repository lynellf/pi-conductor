import type { Role } from "../../core/types.js";
import type { ToolExecutionPolicy } from "../../manifest/execution-policy.js";
import type { PersistedRecord } from "../../persistence/log.js";
import type { ToolExecutionRecord } from "../../persistence/tool-execution.js";
import type { SessionState } from "../cost.js";
import type { DisplaySink } from "../display-sink.js";
import type { RoleTurnTelemetryAttachment } from "../role-turn-producer.js";
import type {
  CaptureRejector,
  SessionCostCapDeferral,
  SessionEventSource,
} from "../session-event-handler.js";
import { attachSessionEventHandler } from "../session-event-handler.js";
import { ToolExecutionController, type ToolExecutionError } from "./tool-execution-controller.js";

/** Inputs shared by fresh and trajectory role controller bindings. */
export interface RoleToolExecutionBindingOptions {
  readonly runId: string;
  readonly role: Role;
  readonly visitIndex: number;
  readonly roleSessionId: string;
  readonly policy: Readonly<Required<ToolExecutionPolicy>>;
  readonly persist: (record: PersistedRecord) => void;
  readonly priorRecords?: readonly ToolExecutionRecord[];
  readonly onFatal?: (error: ToolExecutionError) => void;
}

/** Full live-session binding shared by fresh and trajectory role sessions. */
export interface LiveRoleToolExecutionBindingOptions extends RoleToolExecutionBindingOptions {
  readonly session: SessionEventSource;
  readonly state: SessionState;
  readonly sessionFile: string;
  readonly sessionStates: Map<string, SessionState>;
  readonly agentsBySessionId: Map<string, SessionEventSource>;
  readonly rejector: CaptureRejector;
  readonly roleTurn: RoleTurnTelemetryAttachment;
  readonly deferSessionCostCapAbort?: SessionCostCapDeferral;
  readonly displaySink?: DisplaySink;
}

/** Bind execution, state registration, and event accounting for one live role. */
export function bindLiveRoleToolExecution(options: LiveRoleToolExecutionBindingOptions): {
  readonly controller: ToolExecutionController;
  readonly unsubscribe: () => void;
} {
  const controller = createRoleToolExecutionController(options);
  options.sessionStates.set(options.roleSessionId, options.state);
  options.agentsBySessionId.set(options.roleSessionId, options.session);
  options.rejector.bindState(options.state);
  let unsubscribe: () => void;
  try {
    unsubscribe = attachSessionEventHandler({
      session: options.session,
      state: options.state,
      role: options.role,
      fileMutation: {
        runId: options.runId,
        sessionId: options.roleSessionId,
        sessionFile: options.sessionFile,
        persist: options.persist,
      },
      roleTurn: options.roleTurn,
      ...(options.deferSessionCostCapAbort === undefined
        ? {}
        : { deferSessionCostCapAbort: options.deferSessionCostCapAbort }),
      ...(options.displaySink === undefined ? {} : { onDisplay: options.displaySink }),
    });
  } catch (error) {
    options.sessionStates.delete(options.roleSessionId);
    options.agentsBySessionId.delete(options.roleSessionId);
    throw error;
  }
  return { controller, unsubscribe };
}

/** Create the controller bound to one logical role invocation. */
export function createRoleToolExecutionController(
  options: RoleToolExecutionBindingOptions,
): ToolExecutionController {
  return new ToolExecutionController({
    runId: options.runId,
    logicalSessionId: JSON.stringify([options.runId, options.role, options.visitIndex]),
    roleSessionId: options.roleSessionId,
    policy: options.policy,
    ...(options.priorRecords === undefined ? {} : { priorRecords: options.priorRecords }),
    persist: options.persist,
    ...(options.onFatal === undefined ? {} : { onFatal: options.onFatal }),
  });
}
