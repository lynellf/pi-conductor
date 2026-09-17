/** SDK child-session lifecycle adapter — delegation lite §§6–7. */
// This stays in one module (under 500 LOC) because SDK creation, registration,
// sandbox ownership, and disposal form one failure-atomic lifecycle boundary.

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { resolveToolExecutionPolicy } from "../../manifest/execution-policy.js";
import type { SubagentStartedRecord } from "../../persistence/log.js";
import { SessionState } from "../cost.js";
import { SandboxBackendUnavailableError } from "../execution/sandbox/enablement.js";
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
import type { DelegateChildFactoryOptions } from "./delegate-tool-factory.js";
import { failedTerminal, zeroUsage } from "./factory-records.js";
import { buildChildTools, childToolNames } from "./run-tool.js";
import { createSandboxChildContext, type SandboxChildContext } from "./sandbox-child-context.js";

/** Created SDK child and its host-owned accounting state. */
export interface CreatedChild {
  readonly session: AgentSession;
  readonly state: SessionState;
  readonly model: string;
  readonly reportCapture: ReportCapture;
  readonly sandboxContext?: SandboxChildContext;
}

/** Build the standalone child callback used by the delegate scheduler. */
export function buildSpawnCallback(opts: DelegateChildFactoryOptions) {
  return async (config: SpawnChildConfig): Promise<ChildTerminal> => {
    if (cancelled(opts, config.childId))
      return withSandboxInspection(
        config,
        failedTerminal(
          false,
          config.profile.models[0]?.model ?? "",
          null,
          zeroUsage(),
          "child cancelled before creation",
        ),
      );

    let child: CreatedChild;
    try {
      child = await createChildSession(opts, config);
    } catch (cause) {
      if (cause instanceof DelegationOwnershipError) throw cause;
      return withSandboxInspection(
        config,
        failedTerminal(
          false,
          config.profile.models[0]?.model ?? "",
          null,
          zeroUsage(),
          `failed to create child session: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      );
    }
    const sessionFile = child.session.sessionFile;
    if (sessionFile === undefined) {
      await cleanupCreatedChild(child);
      throw new DelegationOwnershipError(
        "child SDK session has no persistent session file",
        new Error("missing session file"),
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
    // Registration precedes the durable start so cancellation cannot miss the
    // host-owned sandbox. Observe an early rejection if that append then fails.
    void terminal.promise.catch(() => undefined);
    opts.manager.register(
      config.childId,
      child.session,
      (cause) => {
        terminal.reject(new DelegationOwnershipError("child SDK abort is ambiguous", cause));
      },
      child.sandboxContext?.cancel,
    );
    let sandboxToolsClosed = false;
    let lifecycleCause: unknown;
    try {
      try {
        persistStarted(opts, config, child, sessionFile);
      } catch (cause) {
        await opts.manager.abort(config.childId);
        throw new DelegationOwnershipError("delegated child start persistence is ambiguous", cause);
      }
      if (cancelled(opts, config.childId)) {
        await opts.manager.abort(config.childId);
        return withSandboxInspection(
          config,
          failedTerminal(
            true,
            child.model,
            sessionFile,
            child.state.usage(),
            "child cancelled before prompt",
          ),
        );
      }
      void child.session.prompt(childTaskSeed(config)).catch((cause: unknown) => {
        terminal.fail(
          `child prompt failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      });
      const observed = await terminal.promise;
      if (child.sandboxContext === undefined) return observed;
      try {
        await child.sandboxContext.closeToolAdmission();
        sandboxToolsClosed = true;
      } catch (cause) {
        sandboxToolsClosed = true;
        try {
          await child.sandboxContext.cancel();
        } catch (cancelCause) {
          throw new DelegationOwnershipError(
            "sandbox tool admission cleanup is ambiguous",
            new AggregateError([cause, cancelCause]),
          );
        }
        throw new DelegationOwnershipError("sandbox tool admission cleanup failed", cause);
      }
      if (cancelled(opts, config.childId) || observed.cancelled === true) {
        await child.sandboxContext.cancel();
        return { ...observed, worktreeInspection: invalidWorktreeInspection() };
      }
      try {
        const worktreeInspection = await child.sandboxContext.ingestAndInspect();
        if (cancelled(opts, config.childId)) {
          return {
            ...observed,
            cancelled: true,
            sessionError: "child cancelled during sandbox integration",
            worktreeInspection,
          };
        }
        return {
          ...observed,
          worktreeInspection,
        };
      } catch (cause) {
        if (cancelled(opts, config.childId)) {
          try {
            await child.sandboxContext.cancel();
          } catch (cleanupCause) {
            throw new DelegationOwnershipError(
              "cancelled sandbox integration cleanup is ambiguous",
              new AggregateError([cause, cleanupCause]),
            );
          }
          return {
            ...observed,
            cancelled: true,
            sessionError: "child cancelled during sandbox integration",
            worktreeInspection: invalidWorktreeInspection(),
          };
        }
        throw new DelegationOwnershipError("sandbox child integration is incomplete", cause);
      }
    } catch (cause) {
      lifecycleCause = cause;
      throw cause;
    } finally {
      await finalizeRegisteredChild(
        opts,
        config.childId,
        child,
        sandboxToolsClosed,
        lifecycleCause,
      );
    }
  };
}

async function finalizeRegisteredChild(
  opts: DelegateChildFactoryOptions,
  childId: string,
  child: CreatedChild,
  sandboxToolsClosed: boolean,
  lifecycleCause: unknown,
): Promise<void> {
  const cleanupCauses: unknown[] = [];
  if (!sandboxToolsClosed && child.sandboxContext !== undefined) {
    try {
      await child.sandboxContext.closeToolAdmission();
    } catch (cause) {
      cleanupCauses.push(cause);
      try {
        await child.sandboxContext.cancel();
      } catch (cancelCause) {
        cleanupCauses.push(cancelCause);
      }
    }
  }
  try {
    await disposeOwnedChild(child.session);
  } catch (cause) {
    cleanupCauses.push(cause);
  } finally {
    opts.manager.unregister(childId);
  }
  if (cleanupCauses.length === 0) return;
  throw new DelegationOwnershipError(
    "delegated child final cleanup is ambiguous",
    new AggregateError(
      lifecycleCause === undefined ? cleanupCauses : [lifecycleCause, ...cleanupCauses],
    ),
  );
}

/** Create a child SDK session after admission and cancellation checks. */
export async function createChildSession(
  opts: DelegateChildFactoryOptions,
  config: SpawnChildConfig,
): Promise<CreatedChild> {
  if (cancelled(opts, config.childId)) throw new Error("child cancelled before creation");
  const sandboxEnabled =
    config.profile.execution !== undefined &&
    config.sandbox !== undefined &&
    opts.sandboxHostApproval !== undefined;
  if (!sandboxEnabled && (config.profile.execution !== undefined || config.sandbox !== undefined)) {
    throw new SandboxBackendUnavailableError();
  }
  const entry = config.profile.models[0];
  if (entry === undefined) throw new Error(`subagent '${config.profile.name}' has no model`);
  const [provider, modelId] = splitModel(entry.model);
  const model = opts.resolveChildModel?.(entry.model) ?? opts.modelRegistry.find(provider, modelId);
  if (model === undefined) throw new Error(`model '${entry.model}' is not registered`);
  let controller: ToolExecutionController | null = null;
  const sandboxContext = sandboxEnabled
    ? await createSandboxChildContext({
        config,
        runId: opts.runId,
        primaryCheckout: opts.primaryCheckout,
        runStateDir: opts.runStateDir,
        hostApproval: opts.sandboxHostApproval,
        getController: () => controller,
      })
    : undefined;
  try {
    return await initializeSdkChild(
      opts,
      config,
      entry.model,
      entry.effort,
      model,
      sandboxContext,
      () => controller,
      (value) => {
        controller = value;
      },
    );
  } catch (cause) {
    if (cause instanceof DelegationOwnershipError) throw cause;
    try {
      await sandboxContext?.cancel();
    } catch (cleanupCause) {
      throw new DelegationOwnershipError(
        "sandbox child cleanup after SDK setup failure is ambiguous",
        new AggregateError([cause, cleanupCause]),
      );
    }
    throw cause;
  }
}

async function initializeSdkChild(
  opts: DelegateChildFactoryOptions,
  config: SpawnChildConfig,
  modelName: string,
  effort: string,
  model: NonNullable<ReturnType<DelegateChildFactoryOptions["modelRegistry"]["find"]>>,
  sandboxContext: SandboxChildContext | undefined,
  getController: () => ToolExecutionController | null,
  setController: (controller: ToolExecutionController) => void,
): Promise<CreatedChild> {
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
  const reportTool =
    config.profile.completion_protocol === "report_result"
      ? [buildReportResultTool(reportCapture)]
      : [];
  // Global Pi runtimes >=0.84 resolve providers through `modelRuntime` and
  // ignore `modelRegistry`; older SDKs accept the registry directly. Forward
  // the registry's own runtime by identity when available, matching the
  // shared role-session compatibility path.
  const runtime = Object.getOwnPropertyDescriptor(opts.modelRegistry, "runtime")?.value;
  const childTools =
    sandboxContext?.tools ??
    buildChildTools({
      worktreePath: config.worktreePath,
      getController,
      getPolicy: () => policy,
    });
  const createOpts: NonNullable<Parameters<typeof createAgentSession>[0]> & {
    modelRuntime?: unknown;
  } = {
    cwd: config.worktreePath,
    model,
    modelRegistry: opts.modelRegistry,
    ...(runtime !== undefined && { modelRuntime: runtime }),
    resourceLoader: loader,
    sessionManager: SessionManager.create(config.worktreePath, opts.sessionDir),
    customTools: [...childTools, ...reportTool],
    tools:
      sandboxContext === undefined
        ? childToolNames(config.profile.completion_protocol)
        : [...childTools.map((tool) => tool.name), ...reportTool.map((tool) => tool.name)],
    thinkingLevel: effort as never,
  };
  const { session } = await createAgentSession(createOpts);
  try {
    const state = new SessionState({
      cap: config.profile.max_session_cost_usd,
      model: modelName,
    });
    attachSessionEventHandler({
      session,
      state,
      role: opts.parentRole,
      ...(opts.displaySink === undefined ? {} : { onDisplay: opts.displaySink }),
      origin: { child_id: config.childId, task_id: config.taskId, subagent: config.profile.name },
    });
    setController(
      new ToolExecutionController({
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
      }),
    );
    return {
      session,
      state,
      model: modelName,
      reportCapture,
      ...(sandboxContext === undefined ? {} : { sandboxContext }),
    };
  } catch (cause) {
    await cleanupCreatedChild({
      session,
      ...(sandboxContext === undefined ? {} : { sandboxContext }),
    });
    throw new DelegationOwnershipError("child SDK initialization is ambiguous", cause);
  }
}

function withSandboxInspection(config: SpawnChildConfig, terminal: ChildTerminal): ChildTerminal {
  return config.sandbox === undefined
    ? terminal
    : { ...terminal, worktreeInspection: invalidWorktreeInspection() };
}

function invalidWorktreeInspection() {
  return { state: "invalid" as const, headCommit: null };
}

async function cleanupCreatedChild(
  child: Pick<CreatedChild, "session"> & { readonly sandboxContext?: SandboxChildContext },
): Promise<void> {
  let sandboxCause: unknown;
  try {
    await child.sandboxContext?.cancel();
  } catch (cause) {
    sandboxCause = cause;
  }
  try {
    await cleanupOwnedChild(child.session);
  } catch (cause) {
    throw new DelegationOwnershipError(
      "child SDK and sandbox cleanup is ambiguous",
      sandboxCause === undefined ? cause : new AggregateError([sandboxCause, cause]),
    );
  }
  if (sandboxCause !== undefined)
    throw new DelegationOwnershipError("sandbox child cleanup is ambiguous", sandboxCause);
}

function persistStarted(
  opts: DelegateChildFactoryOptions,
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
    ...(config.sandbox === undefined ? {} : { sandbox: config.sandbox }),
    ...(config.sourceWorkspace === undefined ? {} : { source_workspace: config.sourceWorkspace }),
    context_artifacts: contextArtifactsAudit(config.contextArtifacts),
    model: child.model,
    session_file: sessionFile,
    worktree_path: config.worktreePath,
    branch: config.branch,
    base_commit: config.baseCommit,
    ts: Date.now(),
  } satisfies SubagentStartedRecord);
}

function cancelled(opts: DelegateChildFactoryOptions, childId: string): boolean {
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
