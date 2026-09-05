/** Composite guide→executor role-session driver (Prewalk spec §R1, §R3, §R12). */

import { createHash } from "node:crypto";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ModelEffort, Role, UsageRecord } from "../core/types.js";
import { selectTransferMode } from "../manifest/prewalk-transfer.js";
import type {
  PrewalkAdmission,
  PrewalkFailureCode,
  PrewalkRecord,
  PrewalkSwitchSelectedRecord,
} from "../persistence/prewalk-records.js";
import type { RoleSession } from "./host.js";
import type { PrewalkGitBase, PrewalkGitCheckpoint } from "./prewalk-git-checkpoint.js";
import {
  buildPrewalkSwitchRecord,
  hashPrewalkExecutorEnvironment,
  type PrewalkProjectionResult,
} from "./prewalk-role-session-records.js";
import type { PrewalkSeam } from "./prewalk-tool.js";

export { hashPrewalkExecutorEnvironment } from "./prewalk-role-session-records.js";

/** Exact executor environment persisted before it is applied. */
export interface PrewalkExecutorEnvironment {
  readonly model: string;
  readonly effort: ModelEffort;
  readonly provider: string;
  readonly api: string;
  readonly systemPrompt: string;
  readonly activeToolNames: readonly string[];
  readonly continuationSeed: string;
}

/** Observable physical session operations required by the composite driver. */
export interface PrewalkPhaseSession {
  readonly conversationId: string;
  readonly sessionFile: string;
  prompt(text: string): Promise<void>;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  dispose(): Promise<void>;
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
  steer?(text: string): Promise<void>;
  clearQueue?(): { steering: string[]; followUp: string[] };
  isSealed?(): boolean;
  subscribeSealed?(listener: () => void): () => void;
}

export interface PrewalkPreflightResult {
  readonly summary: Omit<PrewalkSwitchSelectedRecord["preflight"], "requested_mode">;
}

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
    readonly exemplarSha: string;
    readonly environment: PrewalkExecutorEnvironment;
  }) => PrewalkProjectionResult;
  readonly openProjectionSession: (
    environment: PrewalkExecutorEnvironment,
  ) => Promise<PrewalkPhaseSession>;
  readonly guideUsage: () => UsageRecord;
  readonly guideTurns: () => number;
  readonly admission?: (
    environment: PrewalkExecutorEnvironment,
    preflight: PrewalkPreflightResult,
    mode: "native" | "projection",
    projection?: PrewalkProjectionResult,
  ) => PrewalkAdmission;
  readonly persist: (record: PrewalkRecord) => void;
  readonly now?: () => number;
}

/** Typed switch failure surfaced to the existing role-session failure path. */
export class PrewalkRoleSessionError extends Error {
  constructor(
    readonly code: PrewalkFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PrewalkRoleSessionError";
  }
}

/** Build one outer role session whose first prompt owns both physical phases. */
export function createPrewalkRoleSession(options: CreatePrewalkRoleSessionOptions): RoleSession {
  let active = options.guide;
  let started = false;
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const subscriptions = new Map<PrewalkPhaseSession, () => void>();
  const subscribePhysical = (session: PrewalkPhaseSession) => {
    if (subscriptions.has(session)) return;
    subscriptions.set(
      session,
      session.subscribe((event) => {
        for (const listener of listeners) listener(event);
      }),
    );
  };

  const roleSession: RoleSession = {
    role: options.role,
    sessionId: options.roleSessionId,
    get conversationId() {
      return active.conversationId;
    },
    get sessionFile() {
      return active.sessionFile;
    },
    get model() {
      return active.snapshot().model;
    },
    get effort() {
      return active.snapshot().effort;
    },
    retries: 0,
    retryDelayMs: 0,
    readCaptureBuffer: () => active.readCaptureBuffer(),
    resetCaptureBuffer: () => active.resetCaptureBuffer(),
    subscribe: (listener) => {
      listeners.add(listener);
      subscribePhysical(active);
      return () => listeners.delete(listener);
    },
    steer: (text) => active.steer?.(text) ?? Promise.resolve(),
    clearQueue: () => active.clearQueue?.() ?? { steering: [], followUp: [] },
    isSealed: () => active.isSealed?.() ?? false,
    subscribeSealed: (listener) => active.subscribeSealed?.(listener) ?? (() => undefined),
    prompt: async (seed) => {
      if (started) return active.prompt(seed);
      started = true;
      active = await runFirstPrompt(options, seed, active, (next) => {
        active = next;
        subscribePhysical(next);
      });
    },
    dispose: async () => {
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
      const sessions = new Set([options.guide, active]);
      await Promise.all([...sessions].map((session) => session.dispose()));
    },
  };
  return roleSession;
}

async function runFirstPrompt(
  options: CreatePrewalkRoleSessionOptions,
  seed: string,
  active: PrewalkPhaseSession,
  selectActive: (session: PrewalkPhaseSession) => void,
): Promise<PrewalkPhaseSession> {
  const now = options.now ?? Date.now;
  const base = await options.inspectGitBase();
  if (!base.clean) {
    throw new PrewalkRoleSessionError(
      "prewalk_git_checkpoint_failed",
      "Prewalk requires a clean workspace before the guide starts",
    );
  }
  const initial = active.snapshot();
  if (initial.autoCompactionEnabled) {
    throw new PrewalkRoleSessionError(
      "prewalk_environment_unsupported",
      "Prewalk requires automatic compaction to be disabled before the guide prompt",
    );
  }

  await active.prompt(seed);
  const checkpoint = options.seam.read();
  if (checkpoint === null) {
    return fail(options, base, null, "prewalk_checkpoint_missing", "guide produced no checkpoint");
  }
  const boundary = active.snapshot();
  if (
    !boundary.isIdle ||
    !boundary.checkpointResultDurable ||
    boundary.sideEffectAfterCheckpoint
  ) {
    return fail(
      options,
      base,
      null,
      "prewalk_checkpoint_invalid",
      "checkpoint was not sealed as a sole, durable post-tool-result turn boundary",
    );
  }

  if (checkpoint.outcome !== "handoff_to_executor") {
    const machineTools = distinct([
      ...boundary.activeToolNames.filter((name) => name !== "execution_checkpoint"),
      "handoff",
      "end",
      "ask_user",
    ]);
    await active.enableGuideMachineTools(machineTools);
    await active.prompt(
      checkpoint.outcome === "blocked"
        ? "The switch is skipped. Emit the one appropriate machine handoff/end event with the recorded blocking reason."
        : "The switch is skipped. Emit the one appropriate machine handoff/end event for the completed task.",
    );
    return active;
  }

  let gitCheckpoint: PrewalkGitCheckpoint | null = null;
  try {
    const configuredEnvironment = detachEnvironment(await options.executorEnvironment());
    const preflight = await options.preflight(configuredEnvironment);
    const mode = selectTransferMode(
      {
        transfer: options.config.transfer,
        on_preflight_failure: options.config.onPreflightFailure,
      },
      preflight.summary,
      { transcript_fits: options.transcriptFits(preflight) },
    );
    gitCheckpoint = await options.createGitCheckpoint(base);
    let projection: PrewalkProjectionResult | undefined;
    let deliveredSeed = configuredEnvironment.continuationSeed;
    let executor = active;
    if (mode === "projection") {
      projection = options.buildProjection({
        exemplarSha: gitCheckpoint.exemplar_sha,
        environment: configuredEnvironment,
      });
      deliveredSeed = projection.prompt;
    }
    const environment = detachEnvironment({
      ...configuredEnvironment,
      continuationSeed: deliveredSeed,
    });
    const environmentHash = hashPrewalkExecutorEnvironment(environment);
    const selected = buildPrewalkSwitchRecord({
      runId: options.runId,
      role: options.role,
      roleSessionId: options.roleSessionId,
      requestedMode: options.config.transfer,
      checkpoint,
      preflight,
      mode,
      environment,
      environmentHash,
      gitCheckpoint,
      ...(projection !== undefined ? { projection } : {}),
      guide: boundary,
      guideConversation: { id: options.guide.conversationId, file: options.guide.sessionFile },
      guideTurns: options.guideTurns(),
      guideUsage: options.guideUsage(),
      ...(options.admission !== undefined
        ? { admission: options.admission(environment, preflight, mode, projection) }
        : {}),
      ts: now(),
    });
    options.persist(selected);

    if (mode === "native") {
      await active.applyEnvironment(environment);
    } else {
      executor = await options.openProjectionSession(environment);
      selectActive(executor);
    }
    assertEnvironment(executor.snapshot(), environment, environmentHash);
    await executor.prompt(deliveredSeed);
    options.persist({
      type: "prewalk_executor_seed_delivered",
      schema_version: 1,
      run_id: options.runId,
      role_session_id: options.roleSessionId,
      conversation_id: executor.conversationId,
      continuation_seed_sha256: createHash("sha256").update(deliveredSeed).digest("hex"),
      ts: now(),
    });
    return executor;
  } catch (error) {
    const typed = normalizeFailure(error);
    return fail(options, base, gitCheckpoint?.exemplar_sha ?? null, typed.code, typed.message, typed);
  }
}

function fail(
  options: CreatePrewalkRoleSessionOptions,
  base: PrewalkGitBase,
  exemplarSha: string | null,
  code: PrewalkFailureCode,
  message: string,
  cause?: unknown,
): never {
  options.persist({
    type: "prewalk_switch_failed",
    schema_version: 1,
    run_id: options.runId,
    role_session_id: options.roleSessionId,
    code,
    message,
    guide_usage: options.guideUsage(),
    git_checkpoint: { base_sha: base.base_sha, exemplar_sha: exemplarSha },
    ts: (options.now ?? Date.now)(),
  });
  throw new PrewalkRoleSessionError(code, message, cause === undefined ? undefined : { cause });
}

function assertEnvironment(
  actual: ReturnType<PrewalkPhaseSession["snapshot"]>,
  expected: PrewalkExecutorEnvironment,
  expectedHash: string,
): void {
  const actualHash = hashPrewalkExecutorEnvironment({
    ...expected,
    model: actual.model,
    effort: actual.effort,
    systemPrompt: actual.systemPrompt,
    activeToolNames: actual.activeToolNames,
  });
  if (!actual.isIdle || actualHash !== expectedHash) {
    throw new PrewalkRoleSessionError(
      "prewalk_environment_apply_failed",
      "executor environment does not match the persisted environment hash",
    );
  }
}

function normalizeFailure(error: unknown): PrewalkRoleSessionError {
  if (error instanceof PrewalkRoleSessionError) return error;
  if (isErrorCode(error, "prewalk_transform_unsupported")) {
    return new PrewalkRoleSessionError("prewalk_transform_unsupported", error.message, { cause: error });
  }
  if (isErrorCode(error, "prewalk_projection_too_large")) {
    return new PrewalkRoleSessionError("prewalk_projection_too_large", error.message, { cause: error });
  }
  if (isErrorCode(error, "prewalk_git_checkpoint_failed")) {
    return new PrewalkRoleSessionError("prewalk_git_checkpoint_failed", error.message, { cause: error });
  }
  return new PrewalkRoleSessionError(
    "prewalk_environment_apply_failed",
    error instanceof Error ? error.message : "Prewalk switch failed",
    { cause: error },
  );
}

function detachEnvironment(value: PrewalkExecutorEnvironment): PrewalkExecutorEnvironment {
  return Object.freeze({ ...value, activeToolNames: Object.freeze([...value.activeToolNames]) });
}

function distinct(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function isErrorCode(error: unknown, code: string): error is Error & { readonly code: string } {
  return error instanceof Error && "code" in error && error.code === code;
}
