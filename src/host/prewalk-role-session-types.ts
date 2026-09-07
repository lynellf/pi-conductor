/** Physical-phase and composite driver contracts (Prewalk §R1, §R12). */
import type { Message, Model } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ModelEffort, Role, UsageRecord } from "../core/types.js";
import type {
  PrewalkAdmission,
  PrewalkFailureCode,
  PrewalkRecord,
  PrewalkSwitchSelectedRecord,
} from "../persistence/prewalk-records.js";
import type { RoleSession } from "./host.js";
import type { PrewalkGitBase, PrewalkGitCheckpoint } from "./prewalk-git-checkpoint.js";
import type { PrewalkGuideControl } from "./prewalk-guide-lifecycle.js";
import type { PrewalkProjectionResult } from "./prewalk-role-session-records.js";
import type { PrewalkDeliveryEntry } from "./prewalk-seed-delivery.js";
import type { PrewalkSeam } from "./prewalk-tool.js";
import type { PrewalkValidationGate, PrewalkValidationRun } from "./prewalk-validation.js";

/** Exact executor environment persisted before it is applied. */
export interface PrewalkExecutorEnvironment {
  readonly model: string;
  readonly effort: ModelEffort;
  readonly provider: string;
  readonly api: string;
  readonly systemPrompt: string;
  readonly activeToolNames: readonly string[];
  readonly continuationSeed: string;
  /** Runtime-only resolved SDK model; excluded from persistence and hashing. */
  readonly resolvedModel?: Model<never>;
}

/** Observable physical session operations required by the composite driver. */
export interface PrewalkPhaseSession extends RoleSession {
  readonly conversationId: string;
  readonly sessionFile: string;
  /** Re-read persisted active-branch entries; never infer durability from in-memory messages. */
  deliveryHistory(): readonly PrewalkDeliveryEntry[];
  prompt(text: string): Promise<void>;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  dispose(): Promise<void>;
  abort(): Promise<void>;
  readCaptureBuffer(): ReturnType<RoleSession["readCaptureBuffer"]>;
  resetCaptureBuffer(): void;
  snapshot(): {
    readonly isIdle: boolean;
    readonly autoCompactionEnabled: boolean;
    readonly checkpointResultDurable: boolean;
    readonly sideEffectAfterCheckpoint: boolean;
    readonly model: string;
    readonly effort: ModelEffort;
    readonly provider: string;
    readonly api: string;
    readonly systemPrompt: string;
    readonly activeToolNames: readonly string[];
  };
  applyEnvironment(environment: PrewalkExecutorEnvironment): Promise<void>;
  enableGuideMachineTools(activeToolNames: readonly string[]): Promise<void>;
  preflightContext?(): {
    readonly messages: readonly Message[];
    readonly registeredTools: readonly { readonly name: string }[];
    readonly contextTokens: number | null | undefined;
    readonly hasCompaction: boolean;
  };
  steer?(text: string): Promise<void>;
  clearQueue?(): { steering: string[]; followUp: string[] };
  isSealed?(): boolean;
  subscribeSealed?(listener: () => void): () => void;
}

/** Persistable summary of executor-targeted transform checks. */
export interface PrewalkPreflightResult {
  readonly summary: Omit<PrewalkSwitchSelectedRecord["preflight"], "requested_mode">;
}

/** Injectable production operations owned by one logical Prewalk visit. */
export interface CreatePrewalkRoleSessionOptions {
  readonly runId: string;
  readonly role: Role;
  readonly roleSessionId: string;
  readonly guide: PrewalkPhaseSession;
  readonly seam: PrewalkSeam;
  readonly config: {
    readonly transfer: "native" | "projection";
    readonly onPreflightFailure: "project" | "fail";
  };
  readonly executorEnvironment: () => Promise<PrewalkExecutorEnvironment>;
  readonly preflight: (environment: PrewalkExecutorEnvironment) => Promise<PrewalkPreflightResult>;
  readonly transcriptFits: (preflight: PrewalkPreflightResult) => boolean;
  readonly inspectGitBase: () => Promise<PrewalkGitBase>;
  readonly createGitCheckpoint: (base: PrewalkGitBase) => Promise<PrewalkGitCheckpoint>;
  readonly buildProjection: (args: {
    readonly seed: string;
    readonly exemplarSha: string;
    readonly environment: PrewalkExecutorEnvironment;
  }) => PrewalkProjectionResult;
  readonly openProjectionSession: (
    environment: PrewalkExecutorEnvironment,
  ) => Promise<PrewalkPhaseSession>;
  readonly guideUsage: () => UsageRecord;
  readonly guideTurns: () => number;
  readonly guideControl?: PrewalkGuideControl;
  readonly prepareValidation?: (args: {
    readonly checkpoint: NonNullable<ReturnType<PrewalkSeam["read"]>>;
    readonly blockOnFailure: boolean;
    readonly onUnsatisfied: (run: PrewalkValidationRun) => void;
  }) => PrewalkValidationGate;
  readonly executorLimits?: { readonly maxTurns: number; readonly maxWallClockMs: number };
  readonly sessionUsage?: (sessionId: string) => UsageRecord;
  readonly markTerminalFailure?: (
    sessionId: string,
    code: PrewalkFailureCode,
    message: string,
  ) => void;
  readonly admission?: (
    environment: PrewalkExecutorEnvironment,
    preflight: PrewalkPreflightResult,
    mode: "native" | "projection",
    projection?: PrewalkProjectionResult,
  ) => PrewalkAdmission;
  readonly persist: (record: PrewalkRecord) => void;
  readonly now?: () => number;
}
