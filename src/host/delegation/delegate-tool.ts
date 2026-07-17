/** Delegate tool execution — delegation lite §4–§5. */

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { DelegationPolicy, SubagentProfile } from "../../manifest/types.js";
import type { SubagentUsage } from "../../persistence/log.js";
import type { DelegateArgs } from "../../seam/schema.js";
import { buildChildPrompt, type ChildPrompt } from "./child-prompt.js";
import { buildBranchName, buildWorktreePath, generateChildId } from "./ids.js";
import type {
  PoolChildResult,
  PoolChildStartedInfo,
  PoolCompletedResult,
  PoolFailedResult,
} from "./pool.js";
import { runBoundedPool } from "./pool.js";
import { formatBatchErrors, validateBatch } from "./validate-batch.js";
import {
  checkPrimaryGitStatus,
  createWorktree,
  determineChildStatus,
  verifyWorktree,
} from "./worktree.js";

/** Child status exposed by the parent tool. */
export type DelegateResultStatus = "completed" | "failed" | "no_changes" | "cancelled";

/** One ordered delegate result. */
export interface DelegateTaskResult {
  readonly task_id: string;
  readonly subagent: string;
  readonly child_id: string;
  readonly status: DelegateResultStatus;
  readonly summary: string;
  readonly verification?: readonly string[];
  readonly branch: string;
  readonly worktree_path: string;
  readonly base_commit: string;
  readonly head_commit: string | null;
  readonly session_file: string;
  readonly usage: SubagentUsage;
  readonly failure_reason?: string;
}

/** Parent-facing delegate response. */
export interface DelegateResult {
  readonly results: readonly DelegateTaskResult[];
}

/** Dependencies for one delegate tool invocation. */
export interface DelegateToolOptions {
  readonly args: DelegateArgs;
  readonly policy: DelegationPolicy;
  readonly profiles: readonly SubagentProfile[];
  readonly remainingChildren: number;
  readonly runStateDir: string;
  readonly runId: string;
  readonly parentRole: string;
  readonly primaryCheckout: string;
  /** Resolution root for the profile's system prompt. */
  readonly systemPromptRoot: string;
  readonly spawnAndRunChild: (opts: SpawnChildConfig) => Promise<ChildTerminal>;
  /** True after a run abort; queued tasks must not create new worktrees. */
  readonly isAdmissionClosed?: () => boolean;
  readonly onChildStarted?: (info: PoolChildStartedInfo) => void;
  readonly onChildCompleted?: (result: PoolCompletedResult) => void;
  readonly onChildFailed?: (result: PoolFailedResult) => void;
}

/** Immutable inputs for a single child SDK session. */
export interface SpawnChildConfig {
  readonly childId: string;
  readonly taskId: string;
  readonly profile: SubagentProfile;
  readonly objective: string;
  readonly expectedOutput: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly systemPrompt: string;
}

/** Terminal data reported by the child host adapter before Git verification. */
export interface ChildTerminal {
  readonly started: boolean;
  readonly model: string;
  readonly status: "completed" | "failed" | "no_changes" | "cancelled";
  readonly summary: string;
  readonly verification?: readonly string[];
  readonly headCommit: string | null;
  readonly sessionFile: string | null;
  readonly usage: SubagentUsage;
  readonly failureReason?: string;
}

/** Validate, create worktrees, run bounded children, and preserve input order. */
export async function executeDelegate(options: DelegateToolOptions): Promise<DelegateResult> {
  const gitCheck = await checkPrimaryGitStatus(options.primaryCheckout);
  const validation = validateBatch(
    options.args,
    options.policy,
    options.profiles,
    options.remainingChildren,
    gitCheck,
  );
  if (!validation.valid) {
    throw new DelegateToolError(
      "batch_validation_failed",
      formatBatchErrors(validation.errors),
      validation.errors.map((error) => ({ code: error.code, message: error.message })),
    );
  }
  if (gitCheck.headCommit === null) {
    throw new DelegateToolError("batch_validation_failed", "primary HEAD is unavailable", []);
  }

  await Promise.all([
    mkdir(`${options.runStateDir}/worktrees`, { recursive: true }),
    mkdir(`${options.runStateDir}/sessions`, { recursive: true }),
  ]);
  const baseCommit = gitCheck.headCommit;
  const pool = await runBoundedPool(
    validation.tasks,
    {
      maxParallel: options.policy.max_parallel,
      baseCommit,
      runStateDir: options.runStateDir,
      runId: options.runId,
      parentRole: options.parentRole,
      primaryCheckout: options.primaryCheckout,
      callbacks: {
        onChildStarted: (info) => options.onChildStarted?.(info),
        onChildCompleted: (result) => options.onChildCompleted?.(result),
        onChildFailed: (result) => options.onChildFailed?.(result),
      },
    },
    async (poolOptions) => {
      const childId = generateChildId();
      const worktreePath = buildWorktreePath(options.runStateDir, childId);
      const branch = buildBranchName(options.runId, childId);
      const result = await runSingleChild({
        childId,
        task: poolOptions.task,
        worktreePath,
        branch,
        baseCommit,
        runId: options.runId,
        parentRole: options.parentRole,
        primaryCheckout: options.primaryCheckout,
        systemPromptRoot: options.systemPromptRoot,
        spawnAndRunChild: options.spawnAndRunChild,
        onChildStarted: poolOptions.callbacks.onChildStarted,
        isAdmissionClosed: options.isAdmissionClosed,
      });
      if (result.status === "completed" || result.status === "no_changes") {
        poolOptions.callbacks.onChildCompleted(result);
      } else {
        poolOptions.callbacks.onChildFailed(result as PoolFailedResult);
      }
    },
  );
  return { results: pool.results.map(mapPoolResult) };
}

interface RunSingleChildOptions {
  readonly childId: ReturnType<typeof generateChildId>;
  readonly task: {
    readonly taskId: string;
    readonly subagent: string;
    readonly profile: SubagentProfile;
    readonly objective: string;
    readonly expectedOutput: string;
  };
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly runId: string;
  readonly parentRole: string;
  readonly primaryCheckout: string;
  readonly systemPromptRoot: string;
  readonly spawnAndRunChild: (opts: SpawnChildConfig) => Promise<ChildTerminal>;
  readonly onChildStarted: (info: PoolChildStartedInfo) => void;
  readonly isAdmissionClosed: (() => boolean) | undefined;
}

async function runSingleChild(options: RunSingleChildOptions): Promise<PoolChildResult> {
  const { childId, task, worktreePath, branch, baseCommit } = options;
  if (options.isAdmissionClosed?.() === true) {
    return failedResult(
      options,
      false,
      null,
      zeroUsage(),
      "child admission closed by run abort",
      "cancelled",
    );
  }
  try {
    await createWorktree(worktreePath, branch, baseCommit, options.primaryCheckout);
  } catch (cause) {
    return failedResult(
      options,
      false,
      null,
      zeroUsage(),
      `failed to create worktree: ${message(cause)}`,
    );
  }

  let prompt: ChildPrompt;
  try {
    prompt = await buildChildPrompt(
      task.profile,
      resolve(options.systemPromptRoot, task.profile.system_prompt),
      task.taskId,
      task.objective,
      task.expectedOutput,
      options.runId,
      options.parentRole,
      worktreePath,
    );
  } catch (cause) {
    return failedResult(
      options,
      false,
      null,
      zeroUsage(),
      `failed to load child prompt: ${message(cause)}`,
    );
  }

  let terminal: ChildTerminal;
  try {
    terminal = await options.spawnAndRunChild({
      childId,
      taskId: task.taskId,
      profile: task.profile,
      objective: task.objective,
      expectedOutput: task.expectedOutput,
      worktreePath,
      branch,
      baseCommit,
      systemPrompt: prompt.systemPrompt,
    });
  } catch (cause) {
    return failedResult(
      options,
      false,
      null,
      zeroUsage(),
      `child session error: ${message(cause)}`,
    );
  }

  let headCommit = terminal.headCommit;
  let status = terminal.status;
  let failureReason = terminal.failureReason;
  try {
    const verified = await verifyWorktree(worktreePath, branch);
    headCommit = verified.headCommit;
    const verifiedStatus = determineChildStatus(verified.headCommit, baseCommit, verified.isClean);
    if (status === "completed" && verifiedStatus === "no_changes") {
      status = "no_changes";
    } else if (
      (status === "completed" && verifiedStatus !== "completed") ||
      (status === "no_changes" && verifiedStatus !== "no_changes")
    ) {
      status = "failed";
      failureReason = "child report conflicts with verified worktree state";
    }
  } catch (cause) {
    status = "failed";
    failureReason = `worktree verification failed: ${message(cause)}`;
  }

  const started = terminal.started;
  if (status === "completed" || status === "no_changes") {
    return {
      childId,
      taskId: task.taskId,
      subagent: task.subagent,
      model: terminal.model,
      status,
      summary: terminal.summary,
      ...(terminal.verification !== undefined && { verification: terminal.verification }),
      worktreePath,
      branch,
      baseCommit,
      headCommit: headCommit ?? baseCommit,
      sessionFile: terminal.sessionFile ?? "",
      usage: terminal.usage,
    };
  }
  return failedResult(
    options,
    started,
    terminal.sessionFile,
    terminal.usage,
    failureReason ?? "child session failed",
    status,
    headCommit,
  );
}

function failedResult(
  options: Pick<
    RunSingleChildOptions,
    "childId" | "task" | "worktreePath" | "branch" | "baseCommit"
  >,
  started: boolean,
  sessionFile: string | null,
  usage: SubagentUsage,
  failureReason: string,
  status: "failed" | "cancelled" = "failed",
  headCommit: string | null = null,
): PoolFailedResult {
  return {
    childId: options.childId,
    taskId: options.task.taskId,
    subagent: options.task.subagent,
    status,
    failureReason,
    worktreePath: options.worktreePath,
    branch: options.branch,
    baseCommit: options.baseCommit,
    headCommit,
    sessionFile,
    usage,
    model: options.task.profile.models[0]?.model ?? "",
    lifecycleStarted: started,
  };
}

function mapPoolResult(result: PoolChildResult): DelegateTaskResult {
  if (result.status === "completed" || result.status === "no_changes") {
    return {
      task_id: result.taskId,
      subagent: result.subagent,
      child_id: result.childId,
      status: result.status,
      summary: result.summary,
      ...(result.verification !== undefined && { verification: result.verification }),
      branch: result.branch,
      worktree_path: result.worktreePath,
      base_commit: result.baseCommit,
      head_commit: result.headCommit,
      session_file: result.sessionFile,
      usage: result.usage,
    };
  }
  const failed = result as PoolFailedResult;
  return {
    task_id: failed.taskId,
    subagent: failed.subagent,
    child_id: failed.childId,
    status: failed.status,
    summary: failed.failureReason,
    branch: failed.branch,
    worktree_path: failed.worktreePath,
    base_commit: failed.baseCommit,
    head_commit: failed.headCommit,
    session_file: failed.sessionFile ?? "",
    usage: failed.usage ?? zeroUsage(),
    failure_reason: failed.failureReason,
  };
}

function zeroUsage(): SubagentUsage {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Structured parent-tool validation error. */
export class DelegateToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly errors: readonly { code: string; message: string }[],
  ) {
    super(message);
    this.name = "DelegateToolError";
  }
}
