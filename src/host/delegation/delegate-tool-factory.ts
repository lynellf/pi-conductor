/**
 * Parent-owned delegate tool and standalone child-session adapter — delegation
 * lite §§4, 6–7 / Issue #57 §§6–8. Child settlement, record append, and
 * cancellation share one lifecycle boundary; no child calls the reducer.
 */

import type { AgentSession, ModelRegistry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";

import type { Role } from "../../core/types.js";
import type { DelegationPolicy, RoleConfig, SubagentProfile } from "../../manifest/types.js";
import type {
  PersistedRecord,
  SubagentCompletedRecord,
  SubagentFailedRecord,
  SubagentStartedRecord,
} from "../../persistence/log.js";
import { delegateArgsSchema, reportResultArgsSchema } from "../../seam/schema.js";
import { SessionState } from "../cost.js";
import type { DisplaySink } from "../display-sink.js";
import { attachSessionEventHandler } from "../session-event-handler.js";
import {
  createReportCapture,
  observeChildTerminal,
  type ReportCapture,
} from "./child-observation.js";
import { capChildText } from "./child-result.js";
import type { ChildTerminal, SpawnChildConfig } from "./delegate-tool.js";
import { DelegateToolError, executeDelegate } from "./delegate-tool.js";
import type { DelegationManager } from "./manager.js";
import type { PoolCompletedResult, PoolFailedResult } from "./pool.js";
import { buildChildTools, childToolNames } from "./run-tool.js";

/** Dependencies for a parent role's delegate tool. */
export interface DelegateToolFactoryOptions {
  readonly role: RoleConfig;
  readonly subagents: readonly SubagentProfile[];
  readonly remainingChildren: number;
  readonly runId: string;
  readonly parentRole: Role;
  readonly parentVisitIndex: number;
  readonly primaryCheckout: string;
  readonly runStateDir: string;
  readonly persistRecord: (record: PersistedRecord) => void;
  readonly agentDir: string;
  readonly systemPromptRoot: string;
  readonly modelRegistry: ModelRegistry;
  readonly resolveChildModel?: (model: string) => ReturnType<ModelRegistry["find"]>;
  readonly displaySink?: DisplaySink;
  readonly sessionDir: string;
  readonly manager: DelegationManager;
}

/** Create a parent-only delegate tool; it never creates an FSM event. */
export function createDelegateTool(opts: DelegateToolFactoryOptions): ToolDefinition {
  const policy = delegationPolicy(opts.role);
  let remaining = Math.min(opts.remainingChildren, policy.max_children_per_session);
  let executionTail = Promise.resolve();

  return defineTool({
    name: "delegate",
    label: "delegate",
    description:
      "Run independent coding tasks in isolated Git worktrees and return ordered results.",
    parameters: delegateArgsSchema,
    async execute(_toolCallId, args: Static<typeof delegateArgsSchema>, signal) {
      const abortChildren = (): void => {
        void opts.manager.abortAll();
      };
      signal?.addEventListener("abort", abortChildren, { once: true });
      const previousExecution = executionTail;
      let finishExecution: () => void = () => {};
      executionTail = new Promise<void>((resolve) => {
        finishExecution = resolve;
      });
      try {
        await previousExecution;
        const result = await executeDelegate({
          args,
          policy,
          profiles: opts.subagents,
          remainingChildren: remaining,
          runStateDir: opts.runStateDir,
          runId: opts.runId,
          parentRole: opts.parentRole,
          primaryCheckout: opts.primaryCheckout,
          systemPromptRoot: opts.systemPromptRoot,
          spawnAndRunChild: buildSpawnCallback(opts),
          isAdmissionClosed: () => opts.manager.isClosed(),
          onChildStarted: () => {},
          onChildCompleted: (child) => appendCompleted(opts.persistRecord, opts.runId, child),
          onChildFailed: (child) => appendFailed(opts.persistRecord, opts.runId, child),
        });
        remaining -= args.tasks.length;
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: { remainingChildren: remaining },
          terminate: false,
        };
      } catch (cause) {
        const error = cause instanceof DelegateToolError ? cause : undefined;
        const code = error?.code ?? "delegate_execution_failed";
        if (error?.code === "batch_validation_failed") {
          opts.persistRecord({
            type: "delegation_validation_rejected",
            run_id: opts.runId,
            parent_role: opts.parentRole,
            parent_visit_index: opts.parentVisitIndex,
            task_ids: Object.freeze(args.tasks.map((task) => task.id)),
            code,
            errors: Object.freeze(error.errors.map((item) => Object.freeze({ ...item }))),
            ts: Date.now(),
          });
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "delegate_failed",
                code,
                message: errorMessage(cause),
              }),
            },
          ],
          details: {
            remainingChildren: remaining,
            code,
            ...(error === undefined ? {} : { errors: error.errors }),
          },
          isError: true,
          terminate: false,
        };
      } finally {
        signal?.removeEventListener("abort", abortChildren);
        finishExecution();
      }
    },
  });
}

function delegationPolicy(role: RoleConfig): DelegationPolicy {
  if (role.delegation === undefined) {
    throw new Error(`role '${role.name}' cannot receive delegate without delegation policy`);
  }
  return role.delegation;
}

function buildSpawnCallback(opts: DelegateToolFactoryOptions) {
  return async (config: SpawnChildConfig): Promise<ChildTerminal> => {
    let child: CreatedChild;
    try {
      child = await createChildSession(opts, config);
    } catch (cause) {
      return failedTerminal(
        false,
        config.profile.models[0]?.model ?? "",
        null,
        zeroUsage(),
        `failed to create child session: ${errorMessage(cause)}`,
      );
    }

    const sessionFile = child.session.sessionFile;
    if (sessionFile === undefined) {
      child.session.dispose();
      return failedTerminal(
        false,
        child.model,
        null,
        child.state.usage(),
        "child session file disappeared",
      );
    }
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
      model: child.model,
      session_file: sessionFile,
      worktree_path: config.worktreePath,
      branch: config.branch,
      base_commit: config.baseCommit,
      ts: Date.now(),
    } satisfies SubagentStartedRecord);
    opts.manager.register(config.childId, child.session);

    const terminal = observeChildTerminal({
      session: child.session,
      state: child.state,
      model: child.model,
      config,
      manager: opts.manager,
      reportCapture: child.reportCapture,
    });
    void child.session.prompt(childTaskSeed(config)).catch((cause: unknown) => {
      terminal.fail(`child prompt failed: ${errorMessage(cause)}`);
    });
    try {
      return await terminal.promise;
    } finally {
      opts.manager.unregister(config.childId);
      child.session.dispose();
    }
  };
}

interface CreatedChild {
  readonly session: AgentSession;
  readonly state: SessionState;
  readonly model: string;
  readonly reportCapture: ReportCapture;
}

async function createChildSession(
  opts: DelegateToolFactoryOptions,
  config: SpawnChildConfig,
): Promise<CreatedChild> {
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
    customTools: [...buildChildTools({ worktreePath: config.worktreePath }), ...reportTool],
    tools: childToolNames(config.profile.completion_protocol),
    thinkingLevel: entry.effort as never,
  });
  if (session.sessionFile === undefined) {
    session.dispose();
    throw new Error("child SDK session has no persistent session file");
  }
  const state = new SessionState({ cap: config.profile.max_session_cost_usd, model: entry.model });
  attachSessionEventHandler({
    session,
    state,
    role: opts.parentRole,
    ...(opts.displaySink === undefined ? {} : { onDisplay: opts.displaySink }),
    origin: { child_id: config.childId, task_id: config.taskId, subagent: config.profile.name },
  });
  return { session, state, model: entry.model, reportCapture };
}

function splitModel(model: string): readonly [string, string] {
  const delimiter = model.indexOf(":");
  if (delimiter <= 0 || delimiter === model.length - 1) {
    throw new Error(`model '${model}' must use provider:id syntax`);
  }
  return [model.slice(0, delimiter), model.slice(delimiter + 1)];
}

function buildReportResultTool(capture: ReportCapture): ToolDefinition {
  return defineTool({
    name: "report_result",
    label: "report_result",
    description: "Report the child result and terminate this child session.",
    parameters: reportResultArgsSchema,
    async execute(_toolCallId, args: Static<typeof reportResultArgsSchema>) {
      const capped = capChildText(args.summary);
      capture.capture(
        {
          status: args.status,
          summary: capped.text,
          ...(args.verification === undefined
            ? {}
            : { verification: args.verification.slice(0, 16).map((line) => line.slice(0, 256)) }),
        },
        capped.truncated,
      );
      return { content: [{ type: "text", text: "result recorded" }], details: {}, terminate: true };
    },
  });
}

function childTaskSeed(config: SpawnChildConfig): string {
  if (config.profile.completion_protocol === "minimal") {
    return "Begin the assigned task using only the available file tools.";
  }
  return [
    `Task ID: ${config.taskId}`,
    `Worktree: ${config.worktreePath}`,
    "Begin the assigned task. Modify files in this worktree, then call report_result.",
  ].join("\n");
}

function appendCompleted(
  persistRecord: (record: PersistedRecord) => void,
  runId: string,
  child: PoolCompletedResult,
): void {
  persistRecord({
    type: "subagent_completed",
    run_id: runId,
    child_id: child.childId,
    task_id: child.taskId,
    subagent: child.subagent,
    model: child.model,
    status: child.status,
    summary: child.summary,
    ...(child.verification === undefined ? {} : { verification: child.verification }),
    branch: child.branch,
    worktree_path: child.worktreePath,
    base_commit: child.baseCommit,
    head_commit: child.headCommit,
    session_file: child.sessionFile,
    usage: child.usage,
    ...(child.completionEvidence === undefined
      ? {}
      : { completion_evidence: child.completionEvidence }),
    ts: Date.now(),
  } satisfies SubagentCompletedRecord);
}

function appendFailed(
  persistRecord: (record: PersistedRecord) => void,
  runId: string,
  child: PoolFailedResult,
): void {
  if (!child.lifecycleStarted) return;
  persistRecord({
    type: "subagent_failed",
    run_id: runId,
    child_id: child.childId,
    task_id: child.taskId,
    subagent: child.subagent,
    model: child.model,
    status: child.status,
    ...(child.completionEvidence?.completion_protocol !== "minimal"
      ? {}
      : { summary: child.summary }),
    failure_reason: child.failureReason,
    branch: child.branch,
    worktree_path: child.worktreePath,
    base_commit: child.baseCommit,
    head_commit: child.headCommit,
    session_file: child.sessionFile,
    usage: child.usage,
    ...(child.completionEvidence === undefined
      ? {}
      : { completion_evidence: child.completionEvidence }),
    ts: Date.now(),
  } satisfies SubagentFailedRecord);
}

function failedTerminal(
  started: boolean,
  model: string,
  sessionFile: string | null,
  usage: ReturnType<SessionState["usage"]>,
  reason: string,
): ChildTerminal {
  return {
    started,
    model,
    sessionFile,
    usage,
    sessionError: reason,
  };
}

function zeroUsage(): ReturnType<SessionState["usage"]> {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
