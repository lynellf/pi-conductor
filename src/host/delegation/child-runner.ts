/**
 * Runs one admitted child attempt from worktree/session creation to terminal.
 *
 * ## Terminal writing
 *
 * `AttemptRegistry.writeTerminal` is the sole terminal writer for every attempt.
 * When the attempt completes (success, failure, or error), this function calls
 * `onAttemptTerminal(...)` with the captured usage, report, and failure reason.
 * The callback is responsible for calling `attemptRegistry.writeTerminal()`.
 * This separation keeps `runChild` as a single-attempt runner and lets the
 * manager implement retry logic in its loop.
 */

import type { Usage } from "@earendil-works/pi-ai";
import { normalizeUsage } from "../cost.js";
import type { AttemptRegistry } from "./attempt-registry.js";
import { buildChildSystemPrompt } from "./child-prompt.js";
import { buildChildToolsAllowlist } from "./child-tool-policy.js";
import type { ChildSpawnHandle, PoolItem, SpawnChildContext } from "./manager.js";

interface MutableReport {
  status: "completed" | "failed" | "no_changes";
  summary: string;
  verification: readonly string[] | undefined;
  /** Number of times onReport has been called (for extra_emission detection). */
  reportCount: number;
}

interface MutableUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  tokens: number;
  cost: number;
}

/**
 * Callback fired when an attempt reaches a terminal state.
 * The callback is responsible for calling `attemptRegistry.writeTerminal()`.
 */
export type AttemptTerminalCallback = (args: {
  readonly item: PoolItem;
  readonly report: {
    status: "completed" | "failed" | "no_changes";
    summary: string;
    verification: readonly string[] | undefined;
  } | null;
  readonly usage: MutableUsage;
  readonly failureReason: string | null;
  readonly sessionMeta: { sessionFile: string; model: string | null };
}) => void;

/** Run one child attempt; `AttemptRegistry` is the sole terminal writer. */
export async function runChild(
  item: PoolItem,
  ctx: SpawnChildContext,
  attemptRegistry: AttemptRegistry,
  onAttemptTerminal: AttemptTerminalCallback,
): Promise<void> {
  const { task, childId, attempt, workspace, baseCommit } = item;
  const {
    parentRole,
    parentSession,
    runId,
    spawnChild,
    parentModelDefinition,
    worktreeManager,
    primaryCwd,
    onRecord,
    sessionMetas,
    childHandles,
  } = ctx;

  const report: MutableReport = {
    status: "failed",
    summary: "",
    verification: undefined,
    reportCount: 0,
  };
  const usage: MutableUsage = {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    tokens: 0,
    cost: 0,
  };
  let childPath = item.worktreePath;
  let childBranch = item.branch;

  // A session cannot be created with a worktree cwd before that directory exists.
  if (workspace === "worktree" && worktreeManager && childPath && baseCommit !== null) {
    try {
      const created = await worktreeManager.create({ childId, baseCommit });
      childPath = created.path;
      childBranch = created.branch;
    } catch (cause: unknown) {
      report.status = "failed";
      report.summary = String(cause);
      // Emit terminal via the callback — AttemptRegistry.writeTerminal persists the record.
      onAttemptTerminal({
        item: { ...item, worktreePath: childPath, branch: childBranch },
        report,
        usage,
        failureReason: "worktree_creation_failed",
        sessionMeta: { sessionFile: item.sessionFile, model: item.model },
      });
      return;
    }
  }

  let handle: ChildSpawnHandle;
  const sessionMeta = { sessionFile: item.sessionFile, model: item.model };
  try {
    handle = await spawnChild({
      childId,
      taskId: task.id,
      parentRole,
      runId,
      role: parentRole,
      workspace,
      objective: task.objective,
      expectedOutput: task.expected_output,
      worktreePath: childPath ?? undefined,
      baseCommit,
      attempt,
      model: item.model,
      ...(parentModelDefinition === undefined ? {} : { modelDefinition: parentModelDefinition }),
      modelEffort: item.modelEffort,
      primaryCwd: primaryCwd ?? null,
      parentSession,
      onReport: (capture) => {
        Object.assign(report, capture);
        report.reportCount += 1;
      },
      onComplete: (captured) => {
        Object.assign(usage, captured);
      },
      onError: (reason) => {
        report.status = "failed";
        report.summary = reason;
      },
      onAbort: () => {
        report.status = "failed";
        report.summary = "Cancelled by parent";
      },
      onSessionCreated: (info) => {
        sessionMeta.sessionFile = info.sessionFile;
        sessionMeta.model = info.model;
        sessionMetas.set(childId, { ...info });
      },
    });
  } catch (cause: unknown) {
    report.status = "failed";
    report.summary = String(cause);
    onAttemptTerminal({
      item,
      report,
      usage,
      failureReason: "child_session_error",
      sessionMeta,
    });
    return;
  }

  childHandles.set(childId, handle);

  // Register the attempt with AttemptRegistry BEFORE appending subagent_started.
  // This ensures the registry has the state when writeTerminal is called.
  // Also sync any report data already accumulated (e.g., from synchronous onReport
  // calls during spawnChild, before the child session has run).
  attemptRegistry.registerAttempt({
    childId,
    taskId: task.id,
    attempt,
    workspace,
    worktreePath: childPath,
    branch: childBranch,
    baseCommit,
    sessionFile: sessionMeta.sessionFile,
    model: sessionMeta.model,
    modelEffort: item.modelEffort,
    handle,
  });

  // Sync any reportCount already accumulated in the mutable report (e.g., from
  // synchronous onReport calls during spawnChild, before the child session has run).
  if (report.reportCount > 0) {
    attemptRegistry.recordReport(childId, attempt, {
      status: report.status as "completed" | "failed" | "no_changes",
      summary: report.summary,
      verification: report.verification,
      reportCount: report.reportCount,
    });
  }

  // Durable start append — only after registration succeeds.
  onRecord({
    type: "subagent_started",
    run_id: runId,
    child_id: childId,
    task_id: task.id,
    parent_role: parentRole,
    parent_session: parentSession,
    session_file: sessionMeta.sessionFile,
    attempt,
    model: sessionMeta.model,
    model_effort: item.modelEffort,
    workspace,
    worktree_path: childPath,
    branch: childBranch,
    base_commit: baseCommit,
    ts: Date.now(),
  });

  const systemPrompt = buildChildSystemPrompt({
    role: parentRole,
    runId,
    taskId: task.id,
    parentRole,
    workspace,
    objective: task.objective,
    expectedOutput: task.expected_output,
    tools: buildChildToolsAllowlist({ workspace, role: parentRole }),
    cwd: childPath ?? primaryCwd ?? "/tmp",
    baseCommit,
  });

  const unsubscribe = handle.subscribe((event: unknown) => {
    const candidate = event as { type?: string; message?: { usage?: Usage; role?: string } };
    if (candidate.type !== "message_end" || candidate.message?.role !== "assistant") return;
    const raw = candidate.message?.usage;
    if (raw === undefined) return;
    const normalized = normalizeUsage(raw);
    usage.input += normalized.input;
    usage.output += normalized.output;
    usage.cache_read += normalized.cache_read;
    usage.cache_write += normalized.cache_write;
    usage.tokens += normalized.tokens;
    usage.cost += normalized.cost;
  });

  try {
    await handle.prompt(systemPrompt);
  } catch (cause: unknown) {
    report.status = "failed";
    report.summary = String(cause);
  }

  unsubscribe();
  await handle.dispose().catch(() => undefined);
  childHandles.delete(childId);

  // Emit terminal via the callback — AttemptRegistry.writeTerminal persists the record.
  // `failureReason` derivation rules:
  // 1. Extra emissions (reportCount > 1) → always fail with "extra_emission" regardless of status.
  //    This must be checked first; extra emissions override any status.
  // 2. report.status === "failed" → derive reason from summary, or "child_session_error" as fallback.
  //    Retryable errors (rate_limit / timeout) get "retryable_model_error".
  // 3. Otherwise (completed / no_changes) → null. The child succeeded; any summary is the task result,
  //    not a failure reason. Passing a non-null failureReason here would incorrectly cause
  //    writeTerminal to write subagent_failed even when the child reported success (Critical:
  //    child reports "completed" but terminal says "failed" with failure_reason = summary text).
  const isRetryable =
    report.status === "failed" &&
    (report.summary.includes("rate_limit") || report.summary.includes("timeout"));
  const failureReason: string | null =
    report.reportCount > 1
      ? "extra_emission"
      : report.status === "failed"
        ? isRetryable
          ? "retryable_model_error"
          : report.summary || "child_session_error"
        : null;
  onAttemptTerminal({
    item: { ...item, worktreePath: childPath, branch: childBranch },
    report,
    usage,
    failureReason,
    sessionMeta,
  });
}
