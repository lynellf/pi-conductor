/** Delegation-lite boundaries — spec §4, §5, §7. */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { rollup } from "../../src/cost/rollup.js";
import { reconcileLostChildren } from "../../src/host/api.js";
import { runBoundedPool } from "../../src/host/delegation/pool.js";
import { buildChildTools } from "../../src/host/delegation/run-tool.js";
import { validateBatch } from "../../src/host/delegation/validate-batch.js";
import {
  createWorktree,
  determineChildStatus,
  verifyWorktree,
} from "../../src/host/delegation/worktree.js";
import { makeStubModel } from "../../src/host/stub-provider.js";
import type { DelegationPolicy, SubagentProfile } from "../../src/manifest/types.js";
import { InMemoryRecordLog } from "../../src/persistence/log.js";

const execFileAsync = promisify(execFile);
const profile: SubagentProfile = {
  name: "implementer",
  models: [{ model: "stub:model", effort: "medium" }],
  max_session_cost_usd: 1,
  system_prompt: "child.md",
};
const policy: DelegationPolicy = {
  allowed_subagents: ["implementer"],
  max_children_per_session: 3,
  max_parallel: 2,
};
const usage = { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 };

describe("delegation batch gate (§4)", () => {
  it("rejects a dirty primary checkout before a child can be admitted", () => {
    const result = validateBatch(
      {
        tasks: [{ id: "task-1", subagent: "implementer", objective: "x", expected_output: "y" }],
      },
      policy,
      [profile],
      3,
      { isGit: true, isClean: false, headCommit: "base" },
    );
    expect(result).toMatchObject({ valid: false, errors: [{ code: "primary-dirty" }] });
  });

  it("rejects duplicate task ids as one all-or-nothing batch", () => {
    const result = validateBatch(
      {
        tasks: [
          { id: "same", subagent: "implementer", objective: "x", expected_output: "y" },
          { id: "same", subagent: "implementer", objective: "x", expected_output: "y" },
        ],
      },
      policy,
      [profile],
      3,
      { isGit: true, isClean: true, headCommit: "base" },
    );
    expect(result).toMatchObject({ valid: false, errors: [{ code: "duplicate-task-id" }] });
  });
});

describe("bounded child pool (§4)", () => {
  it("never exceeds maxParallel and preserves task input order", async () => {
    const tasks = ["first", "second", "third"].map((taskId) => ({
      taskId,
      subagent: profile.name,
      profile,
      objective: taskId,
      expectedOutput: taskId,
    }));
    let active = 0;
    let peak = 0;
    const result = await runBoundedPool(
      tasks,
      {
        maxParallel: 2,
        baseCommit: "base",
        runStateDir: "/tmp/run",
        runId: "run",
        parentRole: "parent",
        primaryCheckout: "/tmp/repo",
      },
      async (options) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) =>
          setTimeout(resolve, options.task.taskId === "first" ? 30 : 5),
        );
        active -= 1;
        options.callbacks.onChildCompleted({
          childId: options.task.taskId as never,
          taskId: options.task.taskId,
          subagent: options.task.subagent,
          model: "stub:model",
          status: "no_changes",
          summary: options.task.taskId,
          worktreePath: "/tmp/worktree",
          branch: "branch",
          baseCommit: "base",
          headCommit: "base",
          sessionFile: "session.jsonl",
          usage,
        });
      },
    );
    expect(peak).toBe(2);
    expect(result.results.map((item) => item.taskId)).toEqual(["first", "second", "third"]);
  });
});

describe("confined run tool (§6)", () => {
  it("rejects an absolute path hidden in an option value", async () => {
    const run = buildChildTools({
      worktreePath: "/tmp/worktree",
      runId: "run",
      childId: "child",
      parentRole: "parent",
      taskId: "task",
    }).find((tool) => tool.name === "run");
    if (run === undefined) throw new Error("missing constrained run tool");
    const result = await run.execute(
      "tool-call",
      { argv: ["node", "--require=/tmp/outside.js"] },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("outside path") }),
    ]);
  });
});

describe("child file tools (§6, issue #24)", () => {
  let sandbox: string | undefined;

  afterEach(async () => {
    if (sandbox !== undefined) await rm(sandbox, { recursive: true, force: true });
  });

  it("replaces the SDK file tools in the actual child session and rejects outside paths", async () => {
    sandbox = await mkdtemp(join(tmpdir(), "pi-conductor-child-tools-"));
    const worktree = join(sandbox, "worktree");
    const outside = join(sandbox, "outside");
    await mkdir(worktree);
    await mkdir(outside);
    await writeFile(join(worktree, "inside.txt"), "inside\n");
    await writeFile(join(outside, "outside.txt"), "outside\n");
    await symlink(outside, join(worktree, "outside-link"));

    const { session } = await createAgentSession({
      cwd: worktree,
      model: makeStubModel(),
      sessionManager: SessionManager.inMemory(worktree),
      customTools: buildChildTools({
        worktreePath: worktree,
        runId: "run",
        childId: "child",
        parentRole: "parent",
        taskId: "task",
      }),
      tools: ["read", "grep", "find", "ls", "edit", "write", "run"],
    });

    try {
      const read = requiredTool(session, "read");
      const grep = requiredTool(session, "grep");
      const find = requiredTool(session, "find");
      const ls = requiredTool(session, "ls");
      const edit = requiredTool(session, "edit");
      const write = requiredTool(session, "write");

      await expectBlocked(read, { path: join(outside, "outside.txt") });
      await expectBlocked(grep, { pattern: "outside", path: "../outside" });
      await expectBlocked(find, { pattern: "*", path: "outside-link" });
      await expectBlocked(ls, { path: join(outside, "outside.txt") });
      await expectBlocked(edit, {
        path: join(outside, "outside.txt"),
        edits: [{ oldText: "outside", newText: "changed" }],
      });
      await expectBlocked(write, { path: "outside-link/created.txt", content: "blocked" });

      const readInside = await read.execute(
        "tool-call",
        { path: "inside.txt" },
        undefined,
        undefined,
        {} as never,
      );
      expect(readInside.content).toEqual([
        expect.objectContaining({ text: expect.stringContaining("inside") }),
      ]);

      const writeInside = await write.execute(
        "tool-call",
        { path: "created.txt", content: "created" },
        undefined,
        undefined,
        {} as never,
      );
      expect(writeInside.content).toEqual([
        expect.objectContaining({ text: expect.stringContaining("Successfully wrote") }),
      ]);
    } finally {
      session.dispose();
    }
  });
});

describe("worktree verification (§5)", () => {
  let repository: string;

  afterEach(async () => {
    if (repository !== undefined) await rm(repository, { recursive: true, force: true });
  });

  it("requires the generated branch, a clean worktree, and a changed commit for completed", async () => {
    repository = await mkdtemp(join(tmpdir(), "pi-conductor-delegation-"));
    await git(repository, "init");
    await git(repository, "config", "user.email", "test@example.com");
    await git(repository, "config", "user.name", "Test User");
    await writeFile(join(repository, "README.md"), "base\n");
    await git(repository, "add", "README.md");
    await git(repository, "commit", "-m", "base");
    const base = (await git(repository, "rev-parse", "HEAD")).trim();
    const worktree = join(repository, "child");
    await createWorktree(worktree, "conductor/run/child", base, repository);

    const unchanged = await verifyWorktree(worktree, "conductor/run/child");
    expect(determineChildStatus(unchanged.headCommit, base, unchanged.isClean)).toBe("no_changes");

    await writeFile(join(worktree, "README.md"), "changed\n");
    await git(worktree, "add", "README.md");
    await git(worktree, "commit", "-m", "child change");
    const changed = await verifyWorktree(worktree, "conductor/run/child");
    expect(determineChildStatus(changed.headCommit, base, changed.isClean)).toBe("completed");
  });
});

describe("child accounting (§7)", () => {
  it("adds child terminal usage to run, model, and subagent totals but not perRole", () => {
    const result = rollup(
      [
        {
          type: "subagent_completed",
          run_id: "run",
          child_id: "child",
          task_id: "task",
          subagent: "implementer",
          model: "stub:model",
          status: "completed",
          summary: "done",
          branch: "conductor/run/child",
          worktree_path: "/tmp/worktree",
          base_commit: "base",
          head_commit: "head",
          session_file: "child.jsonl",
          usage: { ...usage, input: 7, tokens: 7, cost: 0.25 },
          ts: 1,
        },
      ],
      "run",
      "orchestrator",
    );
    expect(result.perRun.cost).toBe(0.25);
    expect(result.perModel["stub:model"]?.cost).toBe(0.25);
    expect(result.perSubagent.implementer?.cost).toBe(0.25);
    expect(result.perRole).toEqual({});
  });
});

describe("resume child reconciliation (§7)", () => {
  it("terminalizes each unmatched child start once as recovered_child_lost", () => {
    const log = new InMemoryRecordLog();
    log.append({
      type: "subagent_started",
      run_id: "run",
      child_id: "child",
      task_id: "task",
      subagent: "implementer",
      model: "stub:model",
      session_file: "child.jsonl",
      worktree_path: "/tmp/worktree",
      branch: "conductor/run/child",
      base_commit: "base",
      ts: 1,
    });
    reconcileLostChildren("run", log);
    reconcileLostChildren("run", log);
    const failures = log.records("run").filter((record) => record.type === "subagent_failed");
    expect(failures).toEqual([
      expect.objectContaining({ status: "cancelled", failure_reason: "recovered_child_lost" }),
    ]);
  });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

function requiredTool(
  session: Awaited<ReturnType<typeof createAgentSession>>["session"],
  name: string,
) {
  const tool = session.getToolDefinition(name);
  if (tool === undefined) throw new Error(`missing child tool '${name}'`);
  return tool;
}

async function expectBlocked(
  tool: ReturnType<typeof requiredTool>,
  params: Record<string, unknown>,
): Promise<void> {
  const result = await tool.execute("tool-call", params, undefined, undefined, {} as never);
  expect(result.content).toEqual([
    expect.objectContaining({ text: expect.stringContaining("child worktree") }),
  ]);
}
