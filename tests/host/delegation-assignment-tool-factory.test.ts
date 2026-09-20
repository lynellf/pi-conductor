import { describe, expect, it } from "vitest";

import { createAssignmentDelegationTools } from "../../src/host/delegation/delegate-tool-factory.js";
import { DelegationManager } from "../../src/host/delegation/manager.js";
import type { RoleConfig } from "../../src/manifest/types.js";
import { child, completed, deferred, fixture } from "./delegation-scheduler-review-fixture.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";

const role: RoleConfig = {
  name: "orchestrator",
  is_orchestrator: true,
  tools: ["handoff", "end", "delegate_task", "delegation_control"],
  delegation: {
    interface: "assignments_v1",
    mode: "nonblocking",
    allowed_subagents: ["worker"],
    max_children_per_session: 2,
    max_parallel: 1,
    assignments: [
      {
        name: "review",
        subagent: "worker",
        expected_output: "A review result.",
      },
    ],
  },
};

const worker = {
  name: "worker",
  models: [{ model: "stub:model", effort: "medium" as const }],
  max_session_cost_usd: 1,
  system_prompt: "worker.md",
  completion_protocol: "minimal" as const,
};

function invoke(
  tool: { execute: (...args: never[]) => Promise<unknown> },
  id: string,
  args: unknown,
) {
  return (tool.execute as unknown as (toolCallId: string, params: unknown) => Promise<unknown>)(
    id,
    args,
  );
}

function makeTools(pool: ReturnType<typeof fixture>, configuredRole = role) {
  return createAssignmentDelegationTools({
    role: configuredRole,
    subagents: [worker],
    remainingChildren: 2,
    runId: "run",
    parentRole: "orchestrator",
    parentVisitIndex: 1,
    primaryCheckout: process.cwd(),
    runStateDir: "/tmp/delegation-assignment-factory-test",
    persistRecord: (record) => pool.log.append(record),
    agentDir: process.cwd(),
    systemPromptRoot: process.cwd(),
    modelRegistry: makeModelRegistryWithStub([]),
    sessionDir: "/tmp/delegation-assignment-factory-sessions",
    manager: new DelegationManager(),
    scheduler: pool.scheduler,
  });
}

describe("assignment delegation tool factory", () => {
  it("returns one child handle for nonblocking assignment submissions", async () => {
    const pool = fixture({
      maxParallel: 1,
      maxChildren: 2,
      runTask: async (task) => completed(task),
    });
    const tools = makeTools(pool);
    try {
      expect(tools.submission.name).toBe("delegate_task");
      expect(tools.control.name).toBe("delegation_control");
      const result = await invoke(tools.submission, "assignment-call", {
        assignment: "review",
        brief: "Inspect the changed files.",
      });
      const body = JSON.parse(
        (result as { content: readonly [{ text: string }] }).content[0].text,
      ) as {
        child_id: string;
      };
      expect(body).toEqual({ child_id: "child-review" });
      expect(pool.scheduler.status()[0]?.taskId).toBe("review");
      expect(tools.control).not.toBe(tools.submission);
    } finally {
      await pool.scheduler.close();
    }
  });

  it("shares admission and controls across distinct nonblocking assignments", async () => {
    const pool = fixture({
      maxParallel: 1,
      maxChildren: 2,
      runTask: async (task) => completed(task),
    });
    const assignmentPolicy = role.delegation;
    if (assignmentPolicy?.interface !== "assignments_v1") {
      throw new Error("missing assignment policy");
    }
    const twoAssignmentRole: RoleConfig = {
      ...role,
      delegation: {
        ...assignmentPolicy,
        assignments: [
          ...(assignmentPolicy.assignments ?? []),
          { name: "test", subagent: "worker", expected_output: "A test result." },
        ],
      },
    };
    const tools = makeTools(pool, twoAssignmentRole);
    try {
      await invoke(tools.submission, "assignment-a", {
        assignment: "review",
        brief: "Inspect the changed files.",
      });
      await invoke(tools.submission, "assignment-b", {
        assignment: "test",
        brief: "Add the focused regression test.",
      });
      expect(pool.starts).toEqual(["review", "test"]);
      const waited = await invoke(tools.control, "control-wait", {
        operation: "wait",
        child_ids: ["child-review", "child-test"],
      });
      expect(
        JSON.parse((waited as { content: readonly [{ text: string }] }).content[0].text),
      ).toEqual({
        results: [
          expect.objectContaining({ task_id: "review" }),
          expect.objectContaining({ task_id: "test" }),
        ],
      });
    } finally {
      await pool.scheduler.close();
    }
  });

  it("returns child_id plus the existing terminal result in blocking mode", async () => {
    const gate = deferred<ReturnType<typeof completed>>();
    const pool = fixture({
      maxParallel: 1,
      maxChildren: 2,
      runTask: async () => gate.promise,
    });
    const tools = makeTools(pool, {
      ...role,
      delegation: {
        ...(role.delegation as NonNullable<RoleConfig["delegation"]>),
        mode: "blocking",
      },
    });
    try {
      const pending = invoke(tools.submission, "blocking-assignment", {
        assignment: "review",
        brief: "Inspect the changed files.",
      });
      while (pool.starts.length === 0) await Promise.resolve();
      const task = pool.scheduler.status()[0];
      if (task === undefined) throw new Error("missing scheduled assignment");
      gate.resolve(completed(child(task.taskId)));
      const result = await pending;
      const body = JSON.parse(
        (result as { content: readonly [{ text: string }] }).content[0].text,
      ) as {
        child_id: string;
        result: { task_id: string };
      };
      expect(body.child_id).toBe(task.childId);
      expect(body.result.task_id).toBe("review");
    } finally {
      gate.resolve(completed(child("review")));
      await pool.scheduler.close();
    }
  });

  it("preserves SDK tool-call idempotency and rejects changed redelivery", async () => {
    const pool = fixture({
      maxParallel: 1,
      maxChildren: 2,
      runTask: async (task) => completed(task),
    });
    const tools = makeTools(pool);
    try {
      const first = await invoke(tools.submission, "same-call", {
        assignment: "review",
        brief: "Inspect the changed files.",
      });
      const second = await invoke(tools.submission, "same-call", {
        assignment: "review",
        brief: "Inspect the changed files.",
      });
      expect(
        JSON.parse((first as { content: readonly [{ text: string }] }).content[0].text),
      ).toEqual({ child_id: "child-review" });
      expect(
        JSON.parse((second as { content: readonly [{ text: string }] }).content[0].text),
      ).toEqual({ child_id: "child-review" });
      expect(pool.starts).toEqual(["review"]);

      const changed = await invoke(tools.submission, "same-call", {
        assignment: "review",
        brief: "Use a different brief.",
      });
      expect(changed).toMatchObject({
        isError: true,
        details: { code: "delegation_submission_failed" },
      });
      expect(pool.starts).toEqual(["review"]);
    } finally {
      await pool.scheduler.close();
    }
  });

  it("keeps lifecycle controls on the independent control tool", async () => {
    const pool = fixture({
      maxParallel: 1,
      maxChildren: 2,
      runTask: async (task) => completed(task),
    });
    const tools = makeTools(pool);
    try {
      await invoke(tools.submission, "control-source", {
        assignment: "review",
        brief: "Inspect the changed files.",
      });
      const result = await invoke(tools.control, "control-call", {
        operation: "status",
        child_ids: ["child-review"],
      });
      expect(result).toMatchObject({ details: { operation: "status" } });
    } finally {
      await pool.scheduler.close();
    }
  });
});
