/** Runs one admitted child attempt from worktree/session creation to cleanup. */

import type { Usage } from "@earendil-works/pi-ai";
import { normalizeUsage } from "../cost.js";
import { buildChildSystemPrompt } from "./child-prompt.js";
import { buildChildToolsAllowlist } from "./child-tool-policy.js";
import type { ChildSpawnHandle, PoolItem, SpawnChildContext } from "./manager.js";

interface MutableReport {
  status: "completed" | "failed" | "no_changes";
  summary: string;
  verification: readonly string[] | undefined;
}

interface MutableUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  tokens: number;
  cost: number;
}

/** Run one child; `results.ts` is the sole terminal-record writer. */
export async function runChild(item: PoolItem, ctx: SpawnChildContext): Promise<void> {
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
    reports,
    childUsages,
    sessionMetas,
    childHandles,
  } = ctx;

  const report: MutableReport = { status: "failed", summary: "", verification: undefined };
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
      reports.set(childId, {
        childId,
        attempt,
        status: "failed",
        summary: String(cause),
        verification: undefined,
        reportCount: 0,
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
        const previous = reports.get(childId);
        reports.set(childId, {
          ...capture,
          reportCount: (previous?.reportCount ?? 0) + 1,
        });
      },
      onComplete: (captured) => {
        Object.assign(usage, captured);
        childUsages.set(childId, { ...usage });
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
    reports.set(childId, {
      childId,
      attempt,
      status: "failed",
      summary: String(cause),
      verification: undefined,
      reportCount: 0,
    });
    return;
  }

  childHandles.set(childId, handle);
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
    const raw = candidate.message.usage;
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
    reports.set(childId, {
      childId,
      attempt,
      status: "failed",
      summary: report.summary,
      verification: undefined,
      reportCount: 0,
    });
  }

  unsubscribe();
  childUsages.set(childId, { ...usage });
  await handle.dispose().catch(() => undefined);
  childHandles.delete(childId);
}
