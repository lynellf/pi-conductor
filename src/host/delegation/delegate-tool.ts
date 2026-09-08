/** Delegate tool execution — delegation lite §4–§5 / Issue #57 §7. */

import { mkdir } from "node:fs/promises";

import type { DelegationPolicy, SubagentProfile } from "../../manifest/types.js";
import type {
  ChildCompletionEvidence,
  ChildProjectionFingerprint,
  DelegateResultStatus,
} from "../../persistence/child-completion.js";
import type { SubagentUsage } from "../../persistence/log.js";
import type { PreparedDelegateChild } from "./admission.js";
import { capChildText, type LegacyChildReport, normalizeChildTerminal } from "./child-result.js";
import {
  completionEvidence,
  isPoolCompleted,
  mapPoolResult,
  preStartFailure,
  selectedFailureReason,
  selectedSummary,
} from "./child-result-mapping.js";
import type { PreparedTask } from "./context-artifact-admission.js";
import type {
  ResolveContextArtifactBatchOptions,
  ResolvedContextArtifact,
} from "./context-artifacts.js";
import { DelegationOwnershipError } from "./delegate-error.js";

export type { DelegateValidationErrorItem } from "./delegate-error.js";
export { DelegateToolError } from "./delegate-error.js";

import { prepareDelegateSubmission } from "./admission.js";
import { projectionFingerprint, taskFingerprint } from "./fingerprints.js";
import type { ChildId } from "./ids.js";
import type {
  PoolChildResult,
  PoolChildStartedInfo,
  PoolCompletedResult,
  PoolFailedResult,
} from "./pool.js";
import { runBoundedPool } from "./pool.js";
import { configureExactSparseWorktree, createWorktree, inspectChildWorktree } from "./worktree.js";

/** Child status exposed by the parent tool. */
export type { DelegateResultStatus } from "../../persistence/child-completion.js";

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
  /** Additive Issue #57 terminal evidence; absent only from legacy callers. */
  readonly completion_evidence?: ChildCompletionEvidence;
}

/** Parent-facing delegate response. */
export interface DelegateResult {
  readonly results: readonly DelegateTaskResult[];
}

/** Dependencies for one delegate tool invocation. */
export interface DelegateToolOptions {
  readonly args: import("../../seam/schema.js").DelegateSubmissionArgs;
  readonly policy: DelegationPolicy;
  readonly profiles: readonly SubagentProfile[];
  readonly remainingChildren: number;
  readonly runStateDir: string;
  readonly runId: string;
  readonly parentRole: string;
  readonly primaryCheckout: string;
  readonly systemPromptRoot: string;
  readonly spawnAndRunChild: (opts: SpawnChildConfig) => Promise<ChildTerminal>;
  /** Deterministic resolver race injection for tests; never exposed by the delegate tool schema. */
  readonly contextArtifactTestHook?: ResolveContextArtifactBatchOptions["testHook"];
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
  readonly projectionPaths?: readonly string[];
  /** Frozen host-resolved prompt-only snapshots; raw descriptors never reach a child. */
  readonly contextArtifacts: readonly ResolvedContextArtifact[];
  readonly taskFingerprint: string;
  readonly projectionFingerprint: ChildProjectionFingerprint;
  readonly systemPrompt: string;
}

/** Settled child-session observations before host Git inspection (§7.1). */
export interface ChildTerminal {
  readonly started: boolean;
  readonly model: string;
  readonly report?: LegacyChildReport | null;
  readonly finalResponse?: string | null;
  readonly summaryTruncated?: boolean;
  readonly cancelled?: boolean;
  readonly sessionError?: string | null;
  readonly fileToolCalls?: ChildCompletionEvidence["file_tool_calls"];
  readonly duplicateReadCalls?: number;
  readonly sessionFile: string | null;
  readonly usage: SubagentUsage;
  /** Compatibility input for existing direct host adapters; never written by new SDK sessions. */
  readonly status?: "completed" | "failed" | "no_changes" | "cancelled";
  readonly summary?: string;
  readonly verification?: readonly string[];
  readonly failureReason?: string;
}

/** Validate, create worktrees, run bounded children, and preserve input order. */
export async function executeDelegate(options: DelegateToolOptions): Promise<DelegateResult> {
  const prepared = await prepareDelegateSubmission(options);
  const tasks = prepared.tasks.map((child) => ({
    taskId: child.taskId,
    subagent: child.profile.name,
    profile: child.profile,
    objective: child.objective,
    expectedOutput: child.expectedOutput,
    ...(child.projectionPaths === undefined ? {} : { projectionPaths: child.projectionPaths }),
    resolvedContextArtifacts: child.contextArtifacts,
  }));
  const preparedByTask = new Map(prepared.tasks.map((child) => [child.taskId, child] as const));

  await Promise.all([
    mkdir(`${options.runStateDir}/worktrees`, { recursive: true }),
    mkdir(`${options.runStateDir}/sessions`, { recursive: true }),
  ]);
  const pool = await runBoundedPool(
    tasks,
    {
      maxParallel: options.policy.max_parallel,
      baseCommit: prepared.baseCommit,
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
      const child = preparedByTask.get(poolOptions.task.taskId);
      if (child === undefined)
        throw new Error(`prepared child '${poolOptions.task.taskId}' is missing`);
      const result = await runPreparedChild({
        prepared: child,
        runId: options.runId,
        parentRole: options.parentRole,
        primaryCheckout: options.primaryCheckout,
        parentMaterializedPaths: prepared.materializedParentPaths,
        systemPromptRoot: options.systemPromptRoot,
        spawnAndRunChild: options.spawnAndRunChild,
        ...(options.isAdmissionClosed === undefined
          ? {}
          : { isAdmissionClosed: options.isAdmissionClosed }),
      });
      if (isPoolCompleted(result)) {
        poolOptions.callbacks.onChildCompleted(result);
      } else {
        poolOptions.callbacks.onChildFailed(result);
      }
    },
  );
  return { results: pool.results.map(mapPoolResult) };
}

interface RunSingleChildOptions {
  readonly childId: ChildId;
  readonly task: PreparedTask;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly runId: string;
  readonly parentRole: string;
  readonly primaryCheckout: string;
  readonly parentMaterializedPaths: readonly string[];
  readonly systemPromptRoot: string;
  readonly spawnAndRunChild: (opts: SpawnChildConfig) => Promise<ChildTerminal>;
  readonly isAdmissionClosed?: () => boolean;
  readonly prepared: PreparedDelegateChild;
}

async function runSingleChild(options: RunSingleChildOptions): Promise<PoolChildResult> {
  const { childId, task, worktreePath, branch, baseCommit } = options;
  if (options.isAdmissionClosed?.() === true) {
    return preStartFailure(options, "cancelled", "child admission closed by run abort");
  }
  try {
    await createWorktree(worktreePath, branch, baseCommit, options.primaryCheckout);
    if (task.projectionPaths !== undefined) {
      await configureExactSparseWorktree(worktreePath, branch, baseCommit, task.projectionPaths);
    }
  } catch (cause) {
    return preStartFailure(options, "failed", `failed to create worktree: ${message(cause)}`);
  }

  const prompt = { systemPrompt: options.prepared.systemPrompt };

  const authorityPaths = task.projectionPaths ?? options.parentMaterializedPaths;
  const childTaskFingerprint = taskFingerprint(
    task.objective,
    task.expectedOutput,
    baseCommit,
    authorityPaths,
  );
  const childProjectionFingerprint = projectionFingerprint(
    task.projectionPaths === undefined ? "full_materialized" : "exact",
    authorityPaths,
  );

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
      ...(task.projectionPaths === undefined ? {} : { projectionPaths: task.projectionPaths }),
      contextArtifacts: task.resolvedContextArtifacts,
      taskFingerprint: childTaskFingerprint,
      projectionFingerprint: childProjectionFingerprint,
      systemPrompt: prompt.systemPrompt,
    });
  } catch (cause) {
    if (cause instanceof DelegationOwnershipError) throw cause;
    terminal = {
      started: false,
      model: task.profile.models[0]?.model ?? "",
      sessionFile: null,
      usage: zeroUsage(),
      sessionError: `child session error: ${message(cause)}`,
    };
  }

  const report = terminal.report ?? legacyReportFromCompatibilityTerminal(terminal, task.profile);
  const raw = {
    protocol: task.profile.completion_protocol,
    cancelled: terminal.cancelled === true || terminal.status === "cancelled",
    sessionError: terminal.sessionError ?? terminal.failureReason ?? null,
    report,
    finalResponse: terminal.finalResponse ?? null,
    worktree: await inspectChildWorktree(worktreePath, branch, baseCommit),
    ...(terminal.fileToolCalls === undefined ? {} : { fileToolCalls: terminal.fileToolCalls }),
    ...(terminal.duplicateReadCalls === undefined
      ? {}
      : { duplicateReadCalls: terminal.duplicateReadCalls }),
  } as const;
  const normalized = normalizeChildTerminal(raw);
  const evidence = completionEvidence(raw, normalized, terminal.summaryTruncated ?? false);
  const summary = selectedSummary(raw, normalized.normalizationReason);
  const failureReason = selectedFailureReason(raw, normalized.normalizationReason);

  if (normalized.status === "completed" || normalized.status === "no_changes") {
    return {
      childId,
      taskId: task.taskId,
      subagent: task.subagent,
      model: terminal.model,
      status: normalized.status,
      summary,
      ...(report?.verification === undefined ? {} : { verification: report.verification }),
      worktreePath,
      branch,
      baseCommit,
      headCommit: raw.worktree.headCommit ?? baseCommit,
      sessionFile: terminal.sessionFile ?? "",
      usage: terminal.usage,
      completionEvidence: evidence,
    };
  }
  return {
    childId,
    taskId: task.taskId,
    subagent: task.subagent,
    model: terminal.model,
    status: normalized.status,
    summary,
    failureReason,
    worktreePath,
    branch,
    baseCommit,
    headCommit: raw.worktree.headCommit,
    sessionFile: terminal.sessionFile,
    usage: terminal.usage,
    lifecycleStarted: terminal.started,
    completionEvidence: evidence,
  };
}

/** Execute one already-prepared child without rereading parent checkout state. */
export async function runPreparedChild(options: {
  readonly prepared: PreparedDelegateChild;
  readonly runId: string;
  readonly parentRole: string;
  readonly primaryCheckout: string;
  readonly parentMaterializedPaths: readonly string[];
  readonly systemPromptRoot: string;
  readonly spawnAndRunChild: (opts: SpawnChildConfig) => Promise<ChildTerminal>;
  readonly isAdmissionClosed?: () => boolean;
}): Promise<PoolChildResult> {
  const prepared = options.prepared;
  return runSingleChild({
    childId: prepared.childId,
    task: {
      taskId: prepared.taskId,
      subagent: prepared.profile.name,
      profile: prepared.profile,
      objective: prepared.objective,
      expectedOutput: prepared.expectedOutput,
      ...(prepared.projectionPaths === undefined
        ? {}
        : { projectionPaths: prepared.projectionPaths }),
      resolvedContextArtifacts: prepared.contextArtifacts,
    },
    worktreePath: prepared.worktreePath,
    branch: prepared.branch,
    baseCommit: prepared.baseCommit,
    runId: options.runId,
    parentRole: options.parentRole,
    primaryCheckout: options.primaryCheckout,
    parentMaterializedPaths: options.parentMaterializedPaths,
    systemPromptRoot: options.systemPromptRoot,
    spawnAndRunChild: options.spawnAndRunChild,
    ...(options.isAdmissionClosed === undefined
      ? {}
      : { isAdmissionClosed: options.isAdmissionClosed }),
    prepared,
  });
}

function legacyReportFromCompatibilityTerminal(
  terminal: ChildTerminal,
  profile: SubagentProfile,
): LegacyChildReport | null {
  if (profile.completion_protocol !== "report_result" || terminal.status === undefined) return null;
  if (terminal.status === "cancelled" || terminal.failureReason !== undefined) return null;
  return {
    status: terminal.status,
    summary: capChildText(terminal.summary ?? "").text,
    ...(terminal.verification === undefined ? {} : { verification: terminal.verification }),
  };
}

function zeroUsage(): SubagentUsage {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
