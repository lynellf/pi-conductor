/**
 * Delegate tool factory — delegation lite §4, §6, §7.
 *
 * This module intentionally keeps parent-tool construction, child-session setup,
 * terminal detection, and lifecycle-record emission together: those callbacks
 * share the same SDK session and cancellation/cleanup invariants. Splitting
 * them would separate the coupled adapter lifecycle without reducing its
 * responsibility, so this cohesive module is retained just above the ~400 LOC
 * guideline (and below the 500 LOC exception ceiling).
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
import type { ChildTerminal, SpawnChildConfig } from "./delegate-tool.js";
import { DelegateToolError, executeDelegate } from "./delegate-tool.js";
import type { DelegationManager } from "./manager.js";
import type { PoolCompletedResult, PoolFailedResult } from "./pool.js";
import { buildChildTools, CHILD_FILE_TOOL_NAMES } from "./run-tool.js";

/** Dependencies for a parent role's delegate tool. */
export interface DelegateToolFactoryOptions {
  readonly role: RoleConfig;
  readonly subagents: readonly SubagentProfile[];
  readonly remainingChildren: number;
  readonly runId: string;
  /** Parent role that requested this batch. */
  readonly parentRole: Role;
  /** Loop-owned visit identity of the parent session requesting this batch. */
  readonly parentVisitIndex: number;
  readonly primaryCheckout: string;
  readonly runStateDir: string;
  /** Host-owned append-and-notify seam for child lifecycle records. */
  readonly persistRecord: (record: PersistedRecord) => void;
  readonly agentDir: string;
  /** Resolution root for profile system_prompt paths. */
  readonly systemPromptRoot: string;
  readonly modelRegistry: ModelRegistry;
  /** Test hosts can supply their in-memory SDK model directly. */
  readonly resolveChildModel?: (model: string) => ReturnType<ModelRegistry["find"]>;
  /** Host-configured sink for forwarding delegated child activity to the TUI. */
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
        // executeDelegate only returns after whole-batch validation succeeded.
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
            errors: Object.freeze(
              error.errors.map((validation) => Object.freeze({ ...validation })),
            ),
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
                message: cause instanceof Error ? cause.message : String(cause),
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
    const started: SubagentStartedRecord = {
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
      model: child.model,
      session_file: sessionFile,
      worktree_path: config.worktreePath,
      branch: config.branch,
      base_commit: config.baseCommit,
      ts: Date.now(),
    };
    opts.persistRecord(started);
    opts.manager.register(config.childId, child.session);

    const terminal = waitForChildTerminal(child, config.childId, opts.manager);
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
  const { session } = await createAgentSession({
    cwd: config.worktreePath,
    model,
    modelRegistry: opts.modelRegistry,
    resourceLoader: loader,
    sessionManager: SessionManager.create(config.worktreePath, opts.sessionDir),
    customTools: [
      ...buildChildTools({
        worktreePath: config.worktreePath,
      }),
      buildReportResultTool(),
    ],
    tools: [...CHILD_FILE_TOOL_NAMES, "report_result"],
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
    ...(opts.displaySink !== undefined && { onDisplay: opts.displaySink }),
    origin: {
      child_id: config.childId,
      task_id: config.taskId,
      subagent: config.profile.name,
    },
  });
  return { session, state, model: entry.model };
}

function splitModel(model: string): readonly [string, string] {
  const delimiter = model.indexOf(":");
  if (delimiter <= 0 || delimiter === model.length - 1) {
    throw new Error(`model '${model}' must use provider:id syntax`);
  }
  return [model.slice(0, delimiter), model.slice(delimiter + 1)];
}

interface TerminalWait {
  readonly promise: Promise<ChildTerminal>;
  fail(reason: string): void;
}

function waitForChildTerminal(
  child: CreatedChild,
  childId: string,
  manager: DelegationManager,
): TerminalWait {
  let finish: ((terminal: ChildTerminal) => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let settled = false;
  const complete = (terminal: ChildTerminal): void => {
    if (settled) return;
    settled = true;
    unsubscribe?.();
    finish?.(terminal);
  };
  const promise = new Promise<ChildTerminal>((resolve) => {
    finish = resolve;
  });

  unsubscribe = child.session.subscribe((event) => {
    if (event.type === "tool_execution_start" && event.toolName === "report_result") {
      const args = event.args as Static<typeof reportResultArgsSchema>;
      complete({
        started: true,
        model: child.model,
        status: args.status,
        summary: args.summary.slice(0, 4096),
        ...(args.verification !== undefined && {
          verification: args.verification.slice(0, 16).map((line) => line.slice(0, 256)),
        }),
        headCommit: null,
        sessionFile: child.session.sessionFile ?? null,
        usage: child.state.usage(),
        ...(args.status === "failed" && { failureReason: args.summary.slice(0, 4096) }),
      });
      return;
    }
    if (event.type === "agent_end") {
      complete(
        failedTerminal(
          true,
          child.model,
          child.session.sessionFile ?? null,
          child.state.usage(),
          manager.wasCancelled(childId)
            ? "child cancelled by run abort"
            : "child ended without report_result",
          manager.wasCancelled(childId) ? "cancelled" : "failed",
        ),
      );
    }
  });
  return {
    promise,
    fail(reason) {
      complete(
        failedTerminal(
          true,
          child.model,
          child.session.sessionFile ?? null,
          child.state.usage(),
          reason,
        ),
      );
    },
  };
}

function buildReportResultTool(): ToolDefinition {
  return defineTool({
    name: "report_result",
    label: "report_result",
    description: "Report the child result and terminate this child session.",
    parameters: reportResultArgsSchema,
    async execute() {
      return {
        content: [{ type: "text", text: "result recorded" }],
        details: {},
        terminate: true,
      };
    },
  });
}

function childTaskSeed(config: SpawnChildConfig): string {
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
  const record: SubagentCompletedRecord = {
    type: "subagent_completed",
    run_id: runId,
    child_id: child.childId,
    task_id: child.taskId,
    subagent: child.subagent,
    model: child.model,
    status: child.status,
    summary: child.summary,
    ...(child.verification !== undefined && { verification: child.verification }),
    branch: child.branch,
    worktree_path: child.worktreePath,
    base_commit: child.baseCommit,
    head_commit: child.headCommit,
    session_file: child.sessionFile,
    usage: child.usage,
    ts: Date.now(),
  };
  persistRecord(record);
}

function appendFailed(
  persistRecord: (record: PersistedRecord) => void,
  runId: string,
  child: PoolFailedResult,
): void {
  if (!child.lifecycleStarted) return;
  const record: SubagentFailedRecord = {
    type: "subagent_failed",
    run_id: runId,
    child_id: child.childId,
    task_id: child.taskId,
    subagent: child.subagent,
    model: child.model,
    status: child.status,
    failure_reason: child.failureReason,
    branch: child.branch,
    worktree_path: child.worktreePath,
    base_commit: child.baseCommit,
    head_commit: child.headCommit,
    session_file: child.sessionFile,
    usage: child.usage,
    ts: Date.now(),
  };
  persistRecord(record);
}

function failedTerminal(
  started: boolean,
  model: string,
  sessionFile: string | null,
  usage: ReturnType<SessionState["usage"]>,
  failureReason: string,
  status: "failed" | "cancelled" = "failed",
): ChildTerminal {
  return {
    started,
    model,
    status,
    summary: "",
    headCommit: null,
    sessionFile,
    usage,
    failureReason,
  };
}

function zeroUsage(): ReturnType<SessionState["usage"]> {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
