import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  type ExtensionUIContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ModelEffort } from "../core/types.js";
import { admitOrchestratorPrompt } from "./orchestrator-context-admission.js";
import type { OrchestratorCompactionController } from "./orchestrator-context-compaction.js";
import type { RetainedContextAttachment } from "./orchestrator-context-coordinator.js";
import type { CompactionSettingsSnapshot } from "./orchestrator-context-settings.js";
import { assertExactResumedTrajectoryEnvironment } from "./shared-sdk-role-assertions.js";

type SharedSdkCreateOptions = NonNullable<Parameters<typeof createAgentSession>[0]> & {
  modelRuntime?: unknown;
};

/** Inputs for the shared SDK retained-context prompt wrapper. */
export interface SharedSdkContextSessionOptions {
  readonly session: AgentSession;
  readonly attachment: RetainedContextAttachment;
  readonly settings: CompactionSettingsSnapshot;
  readonly compactionController: OrchestratorCompactionController;
}

/**
 * Build the prompt boundary for a pinned retained context session.
 * Admission, seed delivery, compaction settlement, and sticky failure checks
 * stay ordered around every prompt (§87 lifecycle design).
 */
export function createSharedSdkRetainedPrompt(
  options: SharedSdkContextSessionOptions,
): (text: string) => Promise<void> {
  return async (text: string): Promise<void> => {
    options.compactionController.assertHealthy();
    let admissionError: unknown;
    try {
      await admitOrchestratorPrompt(options.session, text, options.settings);
    } catch (error) {
      admissionError = error;
    } finally {
      await options.compactionController.settle();
      options.compactionController.assertHealthy();
    }
    if (admissionError !== undefined) throw admissionError;
    await options.attachment.prompt(text, async (promptText) => {
      let promptError: unknown;
      try {
        await options.session.prompt(promptText);
      } catch (error) {
        promptError = error;
      }
      let compactionError: unknown;
      try {
        await options.compactionController.settle();
        options.compactionController.assertHealthy();
      } catch (error) {
        compactionError = error;
      }
      if (promptError !== undefined) throw promptError;
      if (compactionError !== undefined) throw compactionError;
    });
  };
}

/** Inputs for creating and validating one shared SDK session. */
export interface SharedSdkSessionStartupOptions {
  readonly createOptions: SharedSdkCreateOptions;
  readonly model: Model<never> | undefined;
  readonly effort: ModelEffort;
  readonly retainedContext: boolean;
  readonly restoredActiveToolNames: readonly string[];
  readonly isTrajectory?: boolean;
  readonly expectedTrajectoryConversation?: { readonly id: string; readonly file: string };
  readonly activeToolNames?: readonly string[];
  readonly uiContext?: ExtensionUIContext;
  readonly isUiContextCurrent?: () => boolean;
  readonly cwd: string;
}

/** Create the shared SDK session, including retained model and tool authority checks. */
export async function createSharedSdkSession(
  options: SharedSdkSessionStartupOptions,
): Promise<{ readonly session: AgentSession; readonly effectiveModel: Model<never> | undefined }> {
  let effectiveModel = options.model;
  if (options.retainedContext && effectiveModel === undefined) {
    const probe = await createAgentSession({
      ...options.createOptions,
      sessionManager: SessionManager.inMemory(options.cwd),
    });
    effectiveModel = probe.session.model as Model<never> | undefined;
    probe.session.dispose();
  }
  if (effectiveModel !== undefined) {
    (options.createOptions as { model?: Model<never> }).model = effectiveModel;
  }
  (options.createOptions as { thinkingLevel?: ModelEffort }).thinkingLevel = options.effort;
  const { session } = await createAgentSession(options.createOptions);
  try {
    if (options.retainedContext) {
      if (effectiveModel !== undefined) await session.setModel(effectiveModel);
      session.setThinkingLevel(options.effort);
      const effectiveEffort = effectiveModel?.reasoning === true ? options.effort : "off";
      if (effectiveModel !== undefined && session.model?.id !== effectiveModel.id) {
        throw new Error("retained context current model was not applied exactly");
      }
      if (session.thinkingLevel !== effectiveEffort) {
        throw new Error("retained context current effort was not applied exactly");
      }
    }
    session.setActiveToolsByName([...options.restoredActiveToolNames]);
    assertExactResumedTrajectoryEnvironment(session, options);
    if (options.activeToolNames !== undefined) {
      const activeNames = session.getActiveToolNames();
      if (
        activeNames.length !== options.activeToolNames.length ||
        activeNames.some((name, index) => name !== options.activeToolNames?.[index])
      ) {
        throw new Error("trajectory target active tool allowlist was not applied exactly");
      }
    }
    if (
      options.uiContext !== undefined &&
      (options.isUiContextCurrent === undefined || options.isUiContextCurrent())
    ) {
      await session.bindExtensions({ uiContext: options.uiContext });
    }
  } catch (error) {
    try {
      session.dispose();
    } catch {
      // Preserve the startup error; disposal is best effort.
    }
    throw error;
  }
  return { session, effectiveModel };
}
