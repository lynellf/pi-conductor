import { describe, expect, it } from "vitest";
import { createDelegateTool } from "../../src/host/delegation/delegate-tool-factory.js";
import { appendFailed } from "../../src/host/delegation/factory-records.js";
import { DelegationManager } from "../../src/host/delegation/manager.js";
import type { RoleConfig } from "../../src/manifest/types.js";
import { child, completed, deferred, fixture } from "./delegation-scheduler-review-fixture.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";

const role = {
  name: "orchestrator",
  is_orchestrator: true,
  models: [{ model: "stub:stub-model", effort: "medium" }],
  system_prompt: "orchestrator.md",
  tools: ["delegate", "end"],
  delegation: {
    allowed_subagents: ["worker"],
    max_children_per_session: 4,
    max_parallel: 2,
  },
} as const;
const worker = {
  name: "worker",
  models: [{ model: "stub:model", effort: "medium" }],
  max_session_cost_usd: 1,
  system_prompt: "worker.md",
  completion_protocol: "minimal",
} as const;

function invoke(tool: ReturnType<typeof createDelegateTool>, id: string, args: unknown) {
  return (tool.execute as unknown as (toolCallId: string, params: unknown) => Promise<unknown>)(
    id,
    args,
  );
}

function submission(id: string, mode?: "blocking" | "nonblocking") {
  return {
    ...(mode === undefined ? {} : { mode }),
    tasks: [{ id, subagent: "worker", objective: id, expected_output: "done" }],
  } as const;
}

function makeTool(pool: ReturnType<typeof fixture>, roleConfig: RoleConfig = role) {
  return createDelegateTool({
    role: roleConfig,
    subagents: [worker],
    remainingChildren: 4,
    runId: "run",
    parentRole: "orchestrator",
    parentVisitIndex: 1,
    primaryCheckout: process.cwd(),
    runStateDir: "/tmp/delegation-factory-test",
    persistRecord: (record) => pool.log.append(record),
    agentDir: process.cwd(),
    systemPromptRoot: process.cwd(),
    modelRegistry: makeModelRegistryWithStub([]),
    sessionDir: "/tmp/delegation-factory-sessions",
    manager: new DelegationManager(),
    scheduler: pool.scheduler,
  });
}

describe("delegate factory asynchronous boundary", () => {
  it("admits A/B, retrieves B, starts C before A, and preserves controls", async () => {
    const gates = new Map<string, ReturnType<typeof deferred<ReturnType<typeof completed>>>>();
    const pool = fixture({
      maxParallel: 2,
      maxChildren: 4,
      runTask: async (task) => {
        const gate = deferred<ReturnType<typeof completed>>();
        gates.set(task.taskId, gate);
        return gate.promise;
      },
    });
    const tool = makeTool(pool, {
      ...role,
      delegation: { ...role.delegation, mode: "nonblocking" },
    } as RoleConfig);
    try {
      const a = await invoke(tool, "call-a", submission("a"));
      const b = await invoke(tool, "call-b", submission("b"));
      expect(pool.starts).toEqual(["a", "b"]);
      expect(a).toMatchObject({ details: { remainingChildren: 3 } });
      expect(b).toMatchObject({ details: { remainingChildren: 2 } });

      const status = await invoke(tool, "control-status", {
        operation: "status",
        child_ids: ["child-b"],
      });
      expect(status).toMatchObject({ details: { operation: "status" } });
      const bTask = pool.scheduler.status().find((item) => item.taskId === "b");
      if (bTask === undefined) throw new Error("task b missing");
      const bGate = gates.get("b");
      if (bGate === undefined) throw new Error("gate b missing");
      bGate.resolve(completed(child("b")));

      const waited = await invoke(tool, "control-wait", {
        operation: "wait",
        child_ids: [bTask.childId],
      });
      expect(waited).toMatchObject({ details: { operation: "wait" } });
      const waitedContent = JSON.parse(
        (waited as { content: readonly [{ text: string }] }).content[0].text,
      ) as { results: readonly [{ summary: string }] };
      expect(waitedContent.results[0].summary).toBe("result b");

      const result = await invoke(tool, "control-result", {
        operation: "result",
        child_ids: [bTask.childId],
      });
      expect(result).toMatchObject({ details: { operation: "result" } });

      await invoke(tool, "call-c", submission("c"));
      expect(pool.starts).toEqual(["a", "b", "c"]);
      expect(pool.scheduler.status(["child-a"])[0]?.status).toBe("running");
    } finally {
      for (const [taskId, gate] of gates) gate.resolve(completed(child(taskId)));
      await pool.scheduler.close();
    }
  });

  it("keeps blocking results ordered, snake_case, and duplicate calls idempotent", async () => {
    const pool = fixture({
      maxParallel: 2,
      maxChildren: 4,
      runTask: async (task) => ({
        ...completed(task),
        completionEvidence: {
          completion_protocol: "minimal",
          completion_source: "final_response",
          normalization_reason: "normal_final_response_changed",
          report_result_called: false,
          final_response_present: true,
          summary_truncated: false,
          worktree_state: "changed",
          file_tool_calls: { read: 0, grep: 0, find: 0, ls: 0, edit: 0, write: 0 },
          duplicate_read_calls: 0,
        },
      }),
    });
    const tool = makeTool(pool, {
      ...role,
      delegation: { ...role.delegation, mode: "blocking" },
    } as RoleConfig);
    try {
      const first = await invoke(tool, "blocking-call", {
        mode: "blocking",
        tasks: [
          { id: "first", subagent: "worker", objective: "first", expected_output: "done" },
          { id: "second", subagent: "worker", objective: "second", expected_output: "done" },
        ],
      });
      const firstContent = JSON.parse(
        (first as { content: readonly [{ text: string }] }).content[0].text,
      ) as { results: readonly [{ task_id: string }, { task_id: string }] };
      expect(firstContent.results.map((item) => item.task_id)).toEqual(["first", "second"]);
      expect(firstContent.results[0]).toHaveProperty("completion_evidence");

      const duplicate = await invoke(tool, "blocking-call", {
        mode: "blocking",
        tasks: [
          { id: "first", subagent: "worker", objective: "first", expected_output: "done" },
          { id: "second", subagent: "worker", objective: "second", expected_output: "done" },
        ],
      });
      expect(pool.starts).toEqual(["first", "second"]);
      expect(duplicate).toMatchObject({ details: { remainingChildren: 2 } });
    } finally {
      await pool.scheduler.close();
    }
  });

  it("persists an accepted prestart failure without session or usage", async () => {
    const pool = fixture({
      maxParallel: 1,
      skipStartedRecord: true,
      runTask: async (task) => ({
        ...completed(task),
        status: "failed" as const,
        failureReason: "child could not start",
        headCommit: null,
        sessionFile: null,
        usage: null,
        lifecycleStarted: false,
      }),
    });
    const tool = makeTool(pool);
    await invoke(tool, "prestart", submission("prestart"));
    const accepted = pool.scheduler.status().find((item) => item.taskId === "prestart");
    if (accepted === undefined) throw new Error("prestart handle missing");
    await pool.scheduler.wait(accepted.childId);
    const failed = pool.log.records("run").find((record) => record.type === "subagent_failed");
    if (failed === undefined || failed.type !== "subagent_failed")
      throw new Error("prestart terminal missing");
    expect(failed.session_file).toBeNull();
    expect(failed.usage).toBeNull();
    let prestartRecord: unknown;
    appendFailed(
      (record) => {
        prestartRecord = record;
      },
      "run",
      {
        childId: "child-prestart" as never,
        taskId: "prestart",
        subagent: "worker",
        model: "stub:model",
        status: "failed",
        summary: "child could not start",
        failureReason: "child could not start",
        worktreePath: "/tmp/prestart",
        branch: "branch/prestart",
        baseCommit: "base",
        headCommit: null,
        sessionFile: null,
        usage: null,
        lifecycleStarted: false,
      },
      true,
    );
    expect(prestartRecord).toMatchObject({ session_file: null, usage: null });
    await pool.scheduler.close();
  });

  it("rejects a conflicting configured mode before scheduler admission", async () => {
    const pool = fixture({
      maxParallel: 1,
      maxChildren: 2,
      runTask: async (task) => completed(task),
    });
    const configuredRole = {
      ...role,
      delegation: { ...role.delegation, mode: "blocking" },
    } as const;
    const tool = makeTool(pool, configuredRole);
    const result = await invoke(tool, "conflict-call", submission("conflict", "nonblocking"));
    expect(result).toMatchObject({ isError: true, details: { code: "delegation_mode_mismatch" } });
    expect(pool.starts).toEqual([]);
    await pool.scheduler.close("test cleanup");
  });
});
