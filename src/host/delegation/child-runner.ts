/**
 * Child session runner — extracted from `manager.ts` to keep it below
 * the ~400-LOC signal (AGENTS.md module-size ceiling).
 *
 * Contains:
 * - `runChild` — runs one child session end-to-end
 *
 * Phase 2: no budget ledger, no cancellation propagation. Phase 3 adds those.
 *
 * Module dependency: imports `SpawnChildContext`, `PoolItem`, and other
 * types from `manager.ts`. The manager imports this module lazily (dynamic
 * `import()`) to avoid circular type references.
 */

import { buildChildSystemPrompt } from "./child-prompt.js";
import { buildChildToolsAllowlist } from "./child-tool-policy.js";
import type { ChildSpawnHandle, ChildUsage, PoolItem, SpawnChildContext } from "./manager.js";

// ─── Internal mutable types ───────────────────────────────────────────

interface MutableReportCapture {
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

/**
 * runChild — runs a single child session from admission to terminal record.
 *
 * Execution order (spec §8 steps 1–4):
 *   1. spawnChild (calls createAgentSession, fires onSessionCreated)
 *   2. Persist subagent_started with real session_file + model
 *   3. For worktree tasks: create the worktree
 *   4. Start child work via handle.prompt()
 *   5. Persist terminal record (subagent_completed or subagent_failed)
 *
 * The key invariant: `subagent_started` is written AFTER
 * createAgentSession resolves, so the record carries the real session_file.
 */
export async function runChild(item: PoolItem, ctx: SpawnChildContext): Promise<void> {
  const { task, childId, attempt, workspace, worktreePath, branch, baseCommit } = item;
  const {
    parentRole,
    parentSession,
    runId,
    spawnChild,
    worktreeManager,
    primaryCwd,
    onRecord,
    reports,
    childUsages,
    childHandles,
  } = ctx;

  // Pre-populate with the parent's model; the onSessionCreated callback
  // will overwrite with the actual resolved model from createAgentSession.
  const sessionMeta: { sessionFile: string; model: string | null } = {
    sessionFile: item.sessionFile,
    model: item.model,
  };
  const modelEffort = item.modelEffort;

  // Mutable local state for this child.
  const report: MutableReportCapture = {
    status: "failed",
    summary: "",
    verification: undefined,
  };
  const usage: MutableUsage = {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    tokens: 0,
    cost: 0,
  };
  let worktreeCreatedPath: string | null = worktreePath;
  let worktreeCreatedBranch: string | null = branch;

  // ── Step 1: Spawn the child session. ─────────────────────────────────
  // onSessionCreated fires synchronously after createAgentSession resolves,
  // populating sessionMeta with the real session_file and model.
  let handle: ChildSpawnHandle;
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
      worktreePath: worktreeCreatedPath ?? undefined,
      baseCommit,
      attempt,
      model: item.model, // Inherited from parent's resolved model (spec §5 decision 3)
      onReport: (capture) => {
        Object.assign(report, capture);
        reports.set(childId, capture);
      },
      onComplete: (u) => {
        Object.assign(usage, u);
        childUsages.set(childId, { ...usage });
      },
      onError: () => {
        report.status = "failed";
      },
      onAbort: () => {
        report.status = "failed";
        report.summary = "Cancelled by parent";
      },
      onSessionCreated: (info) => {
        sessionMeta.sessionFile = info.sessionFile;
        sessionMeta.model = info.model;
      },
    });
  } catch (err: unknown) {
    // Spawn failed — persist a failed terminal record with empty session_file.
    onRecord({
      type: "subagent_failed",
      run_id: runId,
      child_id: childId,
      task_id: task.id,
      parent_role: parentRole,
      parent_session: parentSession,
      session_file: "",
      attempt,
      model: item.model,
      model_effort: modelEffort,
      workspace,
      worktree_path: worktreeCreatedPath,
      branch: worktreeCreatedBranch,
      base_commit: baseCommit,
      ts: Date.now(),
      usage: { ...usage },
      status: "failed",
      summary: "",
      failure_reason: String(err),
    });
    return;
  }

  childHandles.set(childId, handle);

  // ── Step 2: Persist subagent_started AFTER spawn (real session_file now known). ──
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
    model_effort: modelEffort,
    workspace,
    worktree_path: worktreeCreatedPath,
    branch,
    base_commit: baseCommit,
    ts: Date.now(),
  });

  // ── Step 3: Create worktree (worktree tasks only). ───────────────────
  if (
    workspace === "worktree" &&
    worktreeManager &&
    worktreePath &&
    branch &&
    baseCommit !== null
  ) {
    try {
      const wt = await worktreeManager.create({ childId, baseCommit });
      worktreeCreatedPath = wt.path;
      worktreeCreatedBranch = wt.branch;
    } catch (err) {
      // Worktree creation failed — persist failed terminal and return.
      onRecord({
        type: "subagent_failed",
        run_id: runId,
        child_id: childId,
        task_id: task.id,
        parent_role: parentRole,
        parent_session: parentSession,
        session_file: sessionMeta.sessionFile,
        attempt,
        model: sessionMeta.model,
        model_effort: modelEffort,
        workspace,
        worktree_path: worktreePath,
        branch,
        base_commit: baseCommit,
        ts: Date.now(),
        usage: { ...usage },
        status: "failed",
        summary: "",
        failure_reason: String(err),
      });
      return;
    }
  }

  // ── Step 4: Start child work. ────────────────────────────────────────
  const tools = buildChildToolsAllowlist({ workspace, role: parentRole });
  const systemPrompt = buildChildSystemPrompt({
    role: parentRole,
    runId,
    taskId: task.id,
    parentRole,
    workspace,
    objective: task.objective,
    expectedOutput: task.expected_output,
    tools,
    cwd: worktreeCreatedPath ?? primaryCwd ?? "/tmp",
    baseCommit,
  });

  // Subscribe to session events to accumulate usage.
  // Usage is on event.message.usage per SDK protocol (MessageEndEvent has message: AgentMessage).
  const unsub = handle.subscribe((event: unknown) => {
    const ev = event as { type?: string; message?: { usage?: ChildUsage; role?: string } };
    if (ev.type === "message_end" && ev.message?.usage && ev.message.role === "assistant") {
      usage.input += ev.message.usage.input;
      usage.output += ev.message.usage.output;
      usage.cache_read += ev.message.usage.cache_read;
      usage.cache_write += ev.message.usage.cache_write;
      usage.tokens += ev.message.usage.tokens;
      usage.cost += ev.message.usage.cost;
    }
  });

  try {
    await handle.prompt(systemPrompt);
  } catch (err: unknown) {
    // prompt() failed — persist failed terminal.
    unsub();
    await handle.dispose().catch(() => {});
    childHandles.delete(childId);
    onRecord({
      type: "subagent_failed",
      run_id: runId,
      child_id: childId,
      task_id: task.id,
      parent_role: parentRole,
      parent_session: parentSession,
      session_file: sessionMeta.sessionFile,
      attempt,
      model: sessionMeta.model,
      model_effort: modelEffort,
      workspace,
      worktree_path: worktreeCreatedPath,
      branch: worktreeCreatedBranch,
      base_commit: baseCommit,
      ts: Date.now(),
      usage: { ...usage },
      status: "failed",
      summary: "",
      failure_reason: String(err),
    });
    return;
  }

  unsub();
  childUsages.set(childId, { ...usage });
  await handle.dispose();
  childHandles.delete(childId);
}
