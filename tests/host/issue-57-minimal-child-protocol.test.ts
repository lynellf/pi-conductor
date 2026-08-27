import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { Role } from "../../src/core/types.js";
import { createDelegateTool } from "../../src/host/delegation/delegate-tool-factory.js";
import { DelegationManager } from "../../src/host/delegation/manager.js";
import type { DelegationPolicy, RoleConfig, SubagentProfile } from "../../src/manifest/types.js";
import { InMemoryRecordLog } from "../../src/persistence/log.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";

const execFileAsync = promisify(execFile);
const runId = "issue-57-run";
const parentRole = "parent" as Role;
const policy: DelegationPolicy = {
  allowed_subagents: ["child"],
  max_children_per_session: 1,
  max_parallel: 1,
};
const role: RoleConfig = {
  name: parentRole,
  max_visits: 1,
  tools: ["delegate"],
  delegation: policy,
};

let repositories: string[] = [];

afterEach(async () => {
  await Promise.all(repositories.map((path) => rm(path, { recursive: true, force: true })));
  repositories = [];
});

function profile(completion_protocol: SubagentProfile["completion_protocol"]): SubagentProfile {
  return {
    name: "child",
    models: [{ model: "stub:stub-model", effort: "medium" }],
    max_session_cost_usd: 1,
    system_prompt: "child.md",
    completion_protocol,
  };
}

async function repository(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-conductor-issue-57-"));
  repositories.push(path);
  await git(path, "init");
  await git(path, "config", "user.email", "issue-57@example.test");
  await git(path, "config", "user.name", "Issue 57 Test");
  await writeFile(join(path, "README.md"), "base\n");
  await writeFile(join(path, "child.md"), "Perform the bounded task.");
  await writeFile(join(path, ".gitignore"), ".pi-conductor/\n");
  await git(path, "add", ".");
  await git(path, "commit", "-m", "base");
  return path;
}

function tool(
  primaryCheckout: string,
  childProfile: SubagentProfile,
  steps: Parameters<typeof makeModelRegistryWithStub>[0],
  log: InMemoryRecordLog,
  manager = new DelegationManager(),
): ReturnType<typeof createDelegateTool> {
  return createDelegateTool({
    role,
    subagents: [childProfile],
    remainingChildren: 1,
    runId,
    parentRole,
    parentVisitIndex: 1,
    primaryCheckout,
    runStateDir: join(primaryCheckout, ".pi-conductor", "runs", runId),
    persistRecord: (record) => log.append(record),
    agentDir: primaryCheckout,
    systemPromptRoot: primaryCheckout,
    modelRegistry: makeModelRegistryWithStub(steps),
    sessionDir: join(primaryCheckout, ".pi-conductor", "sessions"),
    manager,
  });
}

function task() {
  return {
    tasks: [
      {
        id: "task",
        subagent: "child",
        objective: "Update the bounded file.",
        expected_output: "Give a concise final summary.",
      },
    ],
  };
}

async function execute(
  primaryCheckout: string,
  childProfile: SubagentProfile,
  steps: Parameters<typeof makeModelRegistryWithStub>[0],
): Promise<{ readonly result: Record<string, unknown>; readonly log: InMemoryRecordLog }> {
  const log = new InMemoryRecordLog();
  const result = await tool(primaryCheckout, childProfile, steps, log).execute(
    "delegate",
    task(),
    undefined,
    undefined,
    {} as never,
  );
  const content = result.content[0];
  if (content === undefined || content.type !== "text")
    throw new Error("delegate did not return text");
  return { result: JSON.parse(content.text) as Record<string, unknown>, log };
}

function firstResult(result: Record<string, unknown>): Record<string, unknown> {
  const results = result.results;
  if (!Array.isArray(results) || results[0] === undefined || typeof results[0] !== "object") {
    throw new Error("delegate returned no result");
  }
  return results[0] as Record<string, unknown>;
}

describe("Issue #57 minimal delegated-child protocol — real SDK child lifecycle", () => {
  it("normal final text plus a changed verified worktree completes without report_result", async () => {
    const primaryCheckout = await repository();
    const { result, log } = await execute(primaryCheckout, profile("minimal"), [
      {
        kind: "emit_tool_calls",
        calls: [{ name: "write", arguments: { path: "README.md", content: "changed\n" } }],
      },
      { kind: "emit_text", text: "Updated README." },
    ]);

    expect(firstResult(result)).toMatchObject({
      status: "completed",
      summary: "Updated README.",
      completion_evidence: {
        completion_protocol: "minimal",
        completion_source: "final_response",
        normalization_reason: "normal_final_response_changed",
        final_response_present: true,
        worktree_state: "changed",
      },
    });
    expect(
      log.records(runId).filter((record) => record.type === "subagent_completed"),
    ).toHaveLength(1);
    expect(log.records(runId).find((record) => record.type === "subagent_started")).toMatchObject({
      completion_protocol: "minimal",
      task_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      projection_fingerprint: {
        kind: "full_materialized",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it("normal final text plus a clean verified worktree normalizes to no_changes", async () => {
    const primaryCheckout = await repository();
    const { result } = await execute(primaryCheckout, profile("minimal"), [
      { kind: "emit_text", text: "Nothing required." },
    ]);

    expect(firstResult(result)).toMatchObject({
      status: "no_changes",
      completion_evidence: { normalization_reason: "normal_final_response_clean" },
    });
  });

  it("counts only exact repeated read tuples without retaining tool arguments", async () => {
    const primaryCheckout = await repository();
    const { result } = await execute(primaryCheckout, profile("minimal"), [
      {
        kind: "emit_tool_calls",
        calls: [{ name: "read", arguments: { path: "README.md", offset: 0, limit: 10 } }],
      },
      {
        kind: "emit_tool_calls",
        calls: [{ name: "read", arguments: { path: "README.md", offset: 0, limit: 10 } }],
      },
      { kind: "emit_text", text: "Read the file twice." },
    ]);

    expect(firstResult(result)).toMatchObject({
      completion_evidence: {
        file_tool_calls: { read: 2 },
        duplicate_read_calls: 1,
      },
    });
  });

  it("an explicit blocker remains blocked despite retained partial edits", async () => {
    const primaryCheckout = await repository();
    const { result, log } = await execute(primaryCheckout, profile("minimal"), [
      {
        kind: "emit_tool_calls",
        calls: [{ name: "write", arguments: { path: "README.md", content: "partial\n" } }],
      },
      { kind: "emit_text", text: "BLOCKED: missing external schema" },
    ]);

    expect(firstResult(result)).toMatchObject({
      status: "blocked",
      summary: "BLOCKED: missing external schema",
      failure_reason: "final_response_blocked",
      completion_evidence: {
        normalization_reason: "final_response_blocked",
        blocker_reason: "missing external schema",
      },
    });
    expect(log.records(runId).find((record) => record.type === "subagent_failed")).toMatchObject({
      status: "blocked",
      summary: "BLOCKED: missing external schema",
    });
  });

  it("a normal minimal end without final text remains missing_final_response", async () => {
    const primaryCheckout = await repository();
    const { result } = await execute(primaryCheckout, profile("minimal"), [
      { kind: "no_emission" },
    ]);

    expect(firstResult(result)).toMatchObject({
      status: "failed",
      failure_reason: "missing_final_response",
      completion_evidence: { normalization_reason: "missing_final_response" },
    });
  });

  it("a model/session failure cannot be hidden by final text or worktree state", async () => {
    const primaryCheckout = await repository();
    const { result } = await execute(primaryCheckout, profile("minimal"), [
      { kind: "fail", errorMessage: "provider unavailable" },
    ]);

    expect(firstResult(result)).toMatchObject({
      status: "failed",
      failure_reason: "model_or_session_error",
      completion_evidence: { normalization_reason: "model_or_session_error" },
    });
  });

  it("a retryable provider error followed by normal file work completes from the final settlement", async () => {
    const primaryCheckout = await repository();
    const finalResponse = `Recovered normally.\n${"detail\n".repeat(600)}`;
    const { result, log } = await execute(primaryCheckout, profile("minimal"), [
      { kind: "fail", errorMessage: "service unavailable" },
      {
        kind: "emit_tool_calls",
        calls: [{ name: "write", arguments: { path: "README.md", content: "recovered\\n" } }],
      },
      { kind: "emit_text", text: finalResponse },
    ]);

    const child = firstResult(result);
    expect(child).toMatchObject({
      status: "completed",
      completion_evidence: {
        normalization_reason: "normal_final_response_changed",
        final_response_present: true,
        summary_truncated: true,
        worktree_state: "changed",
      },
    });
    expect(child.summary).toBe(finalResponse.slice(0, 4096));
    expect(log.records(runId).find((record) => record.type === "subagent_completed")).toMatchObject(
      {
        summary: finalResponse.slice(0, 4096),
      },
    );
  });

  it("a legacy normal end without report_result retains missing_report_result", async () => {
    const primaryCheckout = await repository();
    const { result } = await execute(primaryCheckout, profile("report_result"), [
      { kind: "no_emission" },
    ]);

    expect(firstResult(result)).toMatchObject({
      status: "failed",
      failure_reason: "missing_report_result",
      completion_evidence: {
        completion_protocol: "report_result",
        normalization_reason: "missing_report_result",
      },
    });
  });

  it("a cancellation wins over a live minimal child session", async () => {
    const primaryCheckout = await repository();
    const log = new InMemoryRecordLog();
    const manager = new DelegationManager();
    const delegated = tool(primaryCheckout, profile("minimal"), [{ kind: "wait" }], log, manager);
    const running = delegated.execute("delegate", task(), undefined, undefined, {} as never);
    await waitFor(() => log.records(runId).some((record) => record.type === "subagent_started"));
    await manager.abortAll();
    const response = await running;
    const content = response.content[0];
    if (content === undefined || content.type !== "text")
      throw new Error("delegate did not return text");

    expect(firstResult(JSON.parse(content.text) as Record<string, unknown>)).toMatchObject({
      status: "cancelled",
      failure_reason: "cancelled",
      completion_evidence: { normalization_reason: "cancelled" },
    });
  });

  it("a legacy child still completes from report_result after terminal settlement", async () => {
    const primaryCheckout = await repository();
    const { result } = await execute(primaryCheckout, profile("report_result"), [
      {
        kind: "emit_tool_calls",
        calls: [{ name: "write", arguments: { path: "README.md", content: "legacy\n" } }],
      },
      {
        kind: "emit_tool_calls",
        calls: [
          { name: "report_result", arguments: { status: "completed", summary: "Legacy report." } },
        ],
      },
    ]);

    expect(firstResult(result)).toMatchObject({
      status: "completed",
      summary: "Legacy report.",
      completion_evidence: {
        completion_protocol: "report_result",
        completion_source: "report_result",
        report_result_called: true,
        final_response_present: false,
        normalization_reason: "report_result_completed_changed",
      },
    });
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for child session start");
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}
