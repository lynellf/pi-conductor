/** SDK child-session lifecycle adapter — delegation lite §§6–7. */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { resolveToolExecutionPolicy } from "../../manifest/execution-policy.js";
import type { SubagentStartedRecord } from "../../persistence/log.js";
import { SessionState } from "../cost.js";
import { ToolExecutionController } from "../execution/tool-execution-controller.js";
import { toToolExecutionModelError } from "../execution/tool-execution-model-error.js";
import { attachSessionEventHandler } from "../session-event-handler.js";
import {
  createReportCapture,
  observeChildTerminal,
  type ReportCapture,
} from "./child-observation.js";
import { buildReportResultTool, childTaskSeed } from "./child-sdk-tools.js";
import { contextArtifactsAudit } from "./context-artifact-audit.js";
import { DelegationOwnershipError } from "./delegate-error.js";
import type { ChildTerminal, SpawnChildConfig } from "./delegate-tool.js";
import type { DelegateToolFactoryOptions } from "./delegate-tool-factory.js";
import { failedTerminal, zeroUsage } from "./factory-records.js";
import { buildChildTools, childToolNames } from "./run-tool.js";

/** Created SDK child and its host-owned accounting state. */
export interface CreatedChild {
  readonly session: AgentSession;
  readonly state: SessionState;
  readonly model: string;
  readonly reportCapture: ReportCapture;
}

/** Build the standalone child callback used by the delegate scheduler. */
export function buildSpawnCallback(opts: DelegateToolFactoryOptions) {
  return async (config: SpawnChildConfig): Promise<ChildTerminal> => {
    if (cancelled(opts, config.childId))
      return failedTerminal(
        false,
        config.profile.models[0]?.model ?? "",
        null,
        zeroUsage(),
        "child cancelled before creation",
      );

    let child: CreatedChild;
    try {
      child = await createChildSession(opts, config);
    } catch (cause) {
      if (cause instanceof DelegationOwnershipError) throw cause;
      return failedTerminal(
        false,
        config.profile.models[0]?.model ?? "",
        null,
        zeroUsage(),
        `failed to create child session: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    const sessionFile = child.session.sessionFile;
    if (sessionFile === undefined) {
      await cleanupOwnedChild(child.session);
      throw new DelegationOwnershipError(
        "child SDK session has no persistent session file",
        new Error("missing session file"),
      );
    }
    try {
      persistStarted(opts, config, child, sessionFile);
    } catch (cause) {
      await cleanupOwnedChild(child.session);
      throw new DelegationOwnershipError("delegated child start persistence is ambiguous", cause);
    }
    if (cancelled(opts, config.childId)) {
      await cleanupOwnedChild(child.session);
      return failedTerminal(
        true,
        child.model,
        sessionFile,
        child.state.usage(),
        "child cancelled before registration",
      );
    }
    const terminal = observeChildTerminal({
      session: child.session,
      state: child.state,
      model: child.model,
      config,
      manager: opts.manager,
      reportCapture: child.reportCapture,
    });
    opts.manager.register(config.childId, child.session, (cause) => {
      terminal.reject(new DelegationOwnershipError("child SDK abort is ambiguous", cause));
    });
    try {
      if (cancelled(opts, config.childId)) {
        await child.session.abort();
        return failedTerminal(
          true,
          child.model,
          sessionFile,
          child.state.usage(),
          "child cancelled before prompt",
        );
      }
      void child.session.prompt(childTaskSeed(config)).catch((cause: unknown) => {
        terminal.fail(
          `child prompt failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      });
      return await terminal.promise;
    } finally {
      opts.manager.unregister(config.childId);
      await disposeOwnedChild(child.session);
    }
  };
}

/** Create a child SDK session after admission and cancellation checks. */
export async function createChildSession(
  opts: DelegateToolFactoryOptions,
  config: SpawnChildConfig,
): Promise<CreatedChild> {
  if (cancelled(opts, config.childId)) throw new Error("child cancelled before creation");
  const entry = config.profile.models[0];
  if (entry === undefined) throw new Error(`subagent '${config.profile.name}' has no model`);
  const [provider, modelId] = splitModel(entry.model);
  const model = opts.resolveChildModel?.(entry.model) ?? opts.modelRegistry.find(provider, modelId);
  if (model === undefined) throw new Error(`model '${entry.model}' is not registered`);
  const loader = new DefaultResourceLoader({
    cwd: config.worktreePath,
    agentDir: opts.agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => config.systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  const reportCapture = createReportCapture();
  const policy = resolveToolExecutionPolicy(config.profile.tool_execution);
  let controller: ToolExecutionController | null = null;
  const reportTool =
    config.profile.completion_protocol === "report_result"
      ? [buildReportResultTool(reportCapture)]
      : [];
  const { session } = await createAgentSession({
    cwd: config.worktreePath,
    model,
    modelRegistry: opts.modelRegistry,
    resourceLoader: loader,
    sessionManager: SessionManager.create(config.worktreePath, opts.sessionDir),
    customTools: [
      ...buildChildTools({
        worktreePath: config.worktreePath,
        getController: () => controller,
        getPolicy: () => policy,
      }),
      ...reportTool,
    ],
    tools: childToolNames(config.profile.completion_protocol),
    thinkingLevel: entry.effort as never,
  });
  try {
    const state = new SessionState({
      cap: config.profile.max_session_cost_usd,
      model: entry.model,
    });
    attachSessionEventHandler({
      session,
      state,
      role: opts.parentRole,
      ...(opts.displaySink === undefined ? {} : { onDisplay: opts.displaySink }),
      origin: { child_id: config.childId, task_id: config.taskId, subagent: config.profile.name },
    });
    controller = new ToolExecutionController({
      runId: opts.runId,
      logicalSessionId: `${opts.runId}:${config.childId}`,
      roleSessionId: config.childId,
      policy,
      persist: opts.persistRecord,
      onFatal: (error) => {
        reportCapture.close();
        state.setTerminalReason(
          error.code === "tool_timeout_exhausted"
            ? "tool_timeout_exhausted"
            : "tool_cleanup_unconfirmed",
          toToolExecutionModelError(error).message,
        );
        state.markAborted();
        void session.abort();
      },
    });
    return { session, state, model: entry.model, reportCapture };
  } catch (cause) {
    await cleanupOwnedChild(session);
    throw new DelegationOwnershipError("child SDK initialization is ambiguous", cause);
  }
}

function persistStarted(
  opts: DelegateToolFactoryOptions,
  config: SpawnChildConfig,
  child: CreatedChild,
  sessionFile: string,
): void {
  opts.persistRecord({
    type: "subagent_started",
    run_id: opts.runId,
    child_id: config.childId,
    task_id: config.taskId,
    subagent: config.profile.name,
    parent_role: opts.parentRole,
    parent_visit_index: opts.parentVisitIndex,
    ...(config.projectionPaths === undefined
      ? {}
      : { projection_paths: Object.freeze([...config.projectionPaths]) }),
    completion_protocol: config.profile.completion_protocol,
    task_fingerprint: config.taskFingerprint,
    projection_fingerprint: config.projectionFingerprint,
    context_artifacts: contextArtifactsAudit(config.contextArtifacts),
    model: child.model,
    session_file: sessionFile,
    worktree_path: config.worktreePath,
    branch: config.branch,
    base_commit: config.baseCommit,
    ts: Date.now(),
  } satisfies SubagentStartedRecord);
}

function cancelled(opts: DelegateToolFactoryOptions, childId: string): boolean {
  return opts.manager.isClosed() || opts.manager.wasCancelled(childId);
}

async function cleanupOwnedChild(session: AgentSession): Promise<void> {
  let abortCause: unknown;
  try {
    await session.abort();
  } catch (cause) {
    abortCause = cause;
  }
  try {
    await session.dispose();
  } catch (disposeCause) {
    throw new DelegationOwnershipError(
      "child SDK cleanup is ambiguous",
      abortCause === undefined ? disposeCause : new AggregateError([abortCause, disposeCause]),
    );
  }
  if (abortCause !== undefined)
    throw new DelegationOwnershipError("child SDK cleanup is ambiguous", abortCause);
}

async function disposeOwnedChild(session: AgentSession): Promise<void> {
  try {
    await session.dispose();
  } catch (cause) {
    throw new DelegationOwnershipError("child SDK disposal is ambiguous", cause);
  }
}

function splitModel(model: string): readonly [string, string] {
  const delimiter = model.indexOf(":");
  if (delimiter <= 0 || delimiter === model.length - 1)
    throw new Error(`model '${model}' must use provider:id syntax`);
  return [model.slice(0, delimiter), model.slice(delimiter + 1)];
}
