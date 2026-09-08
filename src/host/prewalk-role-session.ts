/** Composite guide→executor role-session driver (Prewalk spec §R1, §R3, §R12). */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { selectTransferMode } from "../manifest/prewalk-transfer.js";
import type { RoleSession } from "./host.js";
import {
  persistPrewalkExecutorUsage,
  startPrewalkExecutorCaps,
} from "./prewalk-executor-lifecycle.js";
import type { PrewalkGitCheckpoint } from "./prewalk-git-checkpoint.js";
import { runPrewalkGuide } from "./prewalk-guide-lifecycle.js";
import {
  normalizePrewalkRoleSessionFailure,
  PrewalkRoleSessionError,
} from "./prewalk-role-session-errors.js";
import { failPrewalkRoleSession, persistPrewalkFailure } from "./prewalk-role-session-failure.js";
import {
  assertPrewalkExecutorEnvironment,
  buildPrewalkSwitchRecord,
  detachPrewalkEnvironment,
  hashPrewalkExecutorEnvironment,
  type PrewalkProjectionResult,
} from "./prewalk-role-session-records.js";
import type {
  CreatePrewalkRoleSessionOptions,
  PrewalkPhaseSession,
} from "./prewalk-role-session-types.js";
import { preparePrewalkSeedDelivery, recordPrewalkSeedDelivered } from "./prewalk-seed-delivery.js";
import type { PrewalkValidationGate } from "./prewalk-validation.js";

export { PrewalkRoleSessionError } from "./prewalk-role-session-errors.js";
export { hashPrewalkExecutorEnvironment } from "./prewalk-role-session-records.js";
export type {
  CreatePrewalkRoleSessionOptions,
  PrewalkExecutorEnvironment,
  PrewalkPhaseSession,
  PrewalkPreflightResult,
} from "./prewalk-role-session-types.js";

/** Build one outer role session whose first prompt owns both physical phases. */
export function createPrewalkRoleSession(options: CreatePrewalkRoleSessionOptions): RoleSession {
  let active = options.guide;
  let started = false;
  let abortRequested = false;
  let abortValidation: (() => Promise<void>) | undefined;
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
    abortOwnedWork: async () => {
      abortRequested = true;
      await abortValidation?.();
    },
    prompt: async (seed) => {
      if (abortRequested) throw new Error("Prewalk was aborted before prompt admission");
      if (started) return active.prompt(seed);
      started = true;
      active = await runFirstPrompt(
        options,
        seed,
        active,
        (next) => {
          active = next;
          subscribePhysical(next);
        },
        (gate) => {
          abortValidation = async () => {
            gate.close();
            await gate.settle();
          };
          if (abortRequested) void abortValidation();
        },
        () => abortRequested,
      );
    },
    dispose: async () => {
      await roleSession.abortOwnedWork?.();
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
  setValidationGate: (gate: PrewalkValidationGate) => void,
  isAbortRequested: () => boolean,
): Promise<PrewalkPhaseSession> {
  const assertNotAborted = (): void => {
    if (!isAbortRequested()) return;
    throw new Error("Prewalk was aborted before phase admission");
  };
  assertNotAborted();
  const now = options.now ?? Date.now;
  const base = await options.inspectGitBase();
  assertNotAborted();
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

  const guideResult = await runPrewalkGuide(options, seed, base);
  const checkpoint = options.seam.read();
  if (checkpoint === null) {
    return failPrewalkRoleSession(options, {
      baseSha: base.base_sha,
      exemplarSha: null,
      code: "prewalk_checkpoint_missing",
      message: "guide produced no checkpoint",
    });
  }
  const boundary = active.snapshot();
  if (!boundary.isIdle || !boundary.checkpointResultDurable || boundary.sideEffectAfterCheckpoint) {
    return failPrewalkRoleSession(options, {
      baseSha: base.base_sha,
      exemplarSha: null,
      code: "prewalk_checkpoint_invalid",
      message: "checkpoint was not sealed as a sole, durable post-tool-result turn boundary",
    });
  }

  const checkpointGuideUsage = options.guideUsage();
  let gitCheckpoint: PrewalkGitCheckpoint | null = null;
  const validationGate = options.prepareValidation?.({
    checkpoint,
    blockOnFailure: checkpoint.outcome !== "blocked",
    onUnsatisfied: () => {
      persistPrewalkFailure(options, {
        baseSha: base.base_sha,
        exemplarSha: gitCheckpoint?.exemplar_sha ?? null,
        code: "prewalk_validation_unsatisfied",
        message: "executor validation remained unsatisfied after corrective retries",
        guideUsage: checkpointGuideUsage,
      });
    },
  });
  if (validationGate !== undefined) setValidationGate(validationGate);

  if (checkpoint.outcome !== "handoff_to_executor") {
    const machineTools = Array.from(
      new Set([
        ...boundary.activeToolNames.filter((name) => name !== "execution_checkpoint"),
        "handoff",
        "end",
        "ask_user",
      ]),
    );
    await active.enableGuideMachineTools(machineTools);
    assertNotAborted();
    await runPrewalkGuide(
      options,
      checkpoint.outcome === "blocked"
        ? "The switch is skipped. Emit the one appropriate machine handoff/end event with the recorded blocking reason."
        : "The switch is skipped. Emit the one appropriate machine handoff/end event for the completed task.",
      base,
      guideResult,
    );
    await validationGate?.ensureRecorded();
    return active;
  }

  try {
    assertNotAborted();
    const configuredEnvironment = detachPrewalkEnvironment(await options.executorEnvironment());
    assertNotAborted();
    const preflight = await options.preflight(configuredEnvironment);
    assertNotAborted();
    const mode = selectTransferMode(
      {
        transfer: options.config.transfer,
        on_preflight_failure: options.config.onPreflightFailure,
      },
      preflight.summary,
      { transcript_fits: !guideResult.forceProjection && options.transcriptFits(preflight) },
    );
    const selectedGitCheckpoint = await options.createGitCheckpoint(base);
    assertNotAborted();
    gitCheckpoint = selectedGitCheckpoint;
    let projection: PrewalkProjectionResult | undefined;
    let deliveredSeed = configuredEnvironment.continuationSeed;
    let executor = active;
    if (mode === "projection") {
      projection = options.buildProjection({
        seed,
        exemplarSha: selectedGitCheckpoint.exemplar_sha,
        environment: configuredEnvironment,
      });
      deliveredSeed = projection.prompt;
    }
    assertNotAborted();
    const environment = detachPrewalkEnvironment({
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
      gitCheckpoint: selectedGitCheckpoint,
      ...(projection !== undefined ? { projection } : {}),
      guide: boundary,
      guideConversation: { id: options.guide.conversationId, file: options.guide.sessionFile },
      guideTurns: guideResult.turns,
      guideUsage: checkpointGuideUsage,
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
    if (isAbortRequested()) {
      await executor.dispose();
      assertNotAborted();
    }
    assertPrewalkExecutorEnvironment(executor.snapshot(), environment, environmentHash);
    const cap =
      options.executorLimits === undefined
        ? null
        : startPrewalkExecutorCaps({
            executor,
            limits: options.executorLimits,
            onExceeded: (code, message) => {
              persistPrewalkFailure(options, {
                baseSha: base.base_sha,
                exemplarSha: selectedGitCheckpoint.exemplar_sha,
                code,
                message,
                guideUsage: checkpointGuideUsage,
              });
              options.markTerminalFailure?.(executor.sessionId, code, message);
            },
          });
    let executorPromptError: unknown = null;
    try {
      const intent = preparePrewalkSeedDelivery({ ...options, executor, seed: deliveredSeed });
      assertNotAborted();
      await executor.prompt(deliveredSeed);
      recordPrewalkSeedDelivered({
        executor,
        seed: deliveredSeed,
        intent,
        persist: options.persist,
        now,
      });
    } catch (error) {
      executorPromptError = error;
    } finally {
      cap?.stop();
      if (executorPromptError !== null || (cap?.code ?? null) !== null) validationGate?.close();
      await validationGate?.ensureRecorded();
      persistPrewalkExecutorUsage({
        runId: options.runId,
        roleSessionId: options.roleSessionId,
        guideSessionId: options.guide.sessionId,
        executor,
        guideUsage: checkpointGuideUsage,
        turns: cap?.turns ?? 0,
        ts: now(),
        ...(options.sessionUsage !== undefined ? { sessionUsage: options.sessionUsage } : {}),
        persist: options.persist,
      });
    }
    if (executorPromptError !== null && (cap === null || cap.code === null)) {
      throw executorPromptError;
    }
    return executor;
  } catch (error) {
    const typed = normalizePrewalkRoleSessionFailure(error);
    return failPrewalkRoleSession(options, {
      baseSha: base.base_sha,
      exemplarSha: gitCheckpoint?.exemplar_sha ?? null,
      code: typed.code,
      message: typed.message,
      cause: typed,
    });
  }
}
