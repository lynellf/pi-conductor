/** SDK role inputs kept separate from the live lifecycle owner (§3). */
import type { Model } from "@earendil-works/pi-ai";
import type {
  ExtensionUIContext,
  ModelRegistry,
  SessionManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { HandoffContextRef, MachineDefinition, ModelEffort, Role } from "../core/types.js";
import type { RoleConfig } from "../manifest/types.js";
import type { PersistedRecord } from "../persistence/log.js";
import type { ToolExecutionRecord } from "../persistence/tool-execution.js";
import type { SessionState } from "./cost.js";
import type { AssignmentDelegationTools } from "./delegation/delegate-tool-factory.js";
import type { DisplaySink } from "./display-sink.js";
import type {
  OrchestratorContextCoordinator,
  PreparedOrchestratorContext,
} from "./orchestrator-context-coordinator.js";
import type { ReviewGateOptions } from "./review.js";
import type { RoleTurnProducer } from "./role-turn-producer.js";
import type { SessionEventSource } from "./session-event-handler.js";

/** Host-selected role inputs; the execution tier never comes from model arguments. */
export interface SharedSdkRoleOptions {
  readonly role: Role;
  readonly executionTier?: "enhanced" | "baseline";
  readonly roleConfig: RoleConfig | undefined;
  readonly model: Model<never> | undefined;
  readonly logicalModel: string | null;
  readonly effort: ModelEffort;
  readonly retries: number;
  readonly retryDelayMs: number;
  readonly systemPrompt: string | null;
  readonly modelRegistry: ModelRegistry;
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly runId: string;
  /** Used only by durable trajectory resume; fresh roles create a new manager. */
  readonly sessionManager?: SessionManager;
  /** Host-minted logical invocation identity for durable trajectory resume. */
  readonly roleSessionId?: string;
  readonly isTrajectory?: boolean;
  /** Persisted target allowlist, never inferred from current role defaults on resume. */
  readonly activeToolNames?: readonly string[];
  readonly disableAutoCompaction?: boolean;
  readonly expectedTrajectoryConversation?: { readonly id: string; readonly file: string };
  readonly machineDefinition: MachineDefinition;
  readonly controlProtocol?: "v1" | "v2";
  readonly handoffContextRef?: HandoffContextRef;
  readonly reviewGate?: ReviewGateOptions;
  readonly delegateTool: ToolDefinition | null;
  readonly assignmentDelegationTools?: AssignmentDelegationTools;
  readonly uiContext?: ExtensionUIContext;
  readonly isUiContextCurrent?: () => boolean;
  readonly displaySink?: DisplaySink;
  readonly persistRecord: (record: PersistedRecord) => void;
  readonly sessionStates: Map<string, SessionState>;
  readonly agentsBySessionId: Map<string, SessionEventSource>;
  readonly roleTurnProducer: RoleTurnProducer;
  readonly visitIndex?: number;
  readonly executionVisitIndex?: number;
  readonly priorToolExecutionRecords?: readonly ToolExecutionRecord[];
  readonly contextRetention?: {
    readonly coordinator: OrchestratorContextCoordinator;
    readonly prepared: PreparedOrchestratorContext;
  };
}
