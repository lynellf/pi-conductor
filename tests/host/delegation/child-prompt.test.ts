/**
 * Tests for delegation/child-prompt.ts — child system prompt builder.
 */

import { describe, expect, test } from "vitest";
import { buildChildSystemPrompt } from "../../../src/host/delegation/child-prompt.js";

describe("buildChildSystemPrompt", () => {
  const minimalArgs = {
    role: "worker" as const,
    runId: "run-abc123",
    taskId: "task-001",
    parentRole: "orchestrator" as const,
    workspace: "read_only" as const,
    objective: "Count the files in /tmp",
    expectedOutput: "A number like 5",
    tools: ["read", "grep", "ls"] as readonly string[],
    cwd: "/tmp",
    baseCommit: null,
  };

  test("includes the role name", () => {
    const prompt = buildChildSystemPrompt(minimalArgs);
    expect(prompt).toContain('role "worker"');
  });

  test("includes the run ID", () => {
    const prompt = buildChildSystemPrompt(minimalArgs);
    expect(prompt).toContain("run-abc123");
  });

  test("includes the task objective", () => {
    const prompt = buildChildSystemPrompt(minimalArgs);
    expect(prompt).toContain("Count the files in /tmp");
  });

  test("includes expected output", () => {
    const prompt = buildChildSystemPrompt(minimalArgs);
    expect(prompt).toContain("A number like 5");
  });

  test("includes the task ID", () => {
    const prompt = buildChildSystemPrompt(minimalArgs);
    expect(prompt).toContain("task-001");
  });

  test("read_only workspace: notes read-only restriction", () => {
    const prompt = buildChildSystemPrompt({ ...minimalArgs, workspace: "read_only" });
    expect(prompt).toContain("read-only task");
    expect(prompt).toContain("Do not modify any files");
  });

  test("worktree workspace: includes working directory and base commit", () => {
    const prompt = buildChildSystemPrompt({
      ...minimalArgs,
      workspace: "worktree",
      baseCommit: "abc1234",
    });
    expect(prompt).toContain("Working directory:");
    expect(prompt).toContain("abc1234");
  });

  test("includes available tools", () => {
    const prompt = buildChildSystemPrompt(minimalArgs);
    expect(prompt).toContain("read, grep, ls");
  });

  test("no tools: indicates no tools available", () => {
    const prompt = buildChildSystemPrompt({ ...minimalArgs, tools: [] });
    expect(prompt).toContain("No tools are available");
  });

  test("includes the mandatory report_result contract", () => {
    const prompt = buildChildSystemPrompt(minimalArgs);
    expect(prompt).toContain("report_result");
    expect(prompt).toContain("exactly once");
  });

  test("forbids handoff, end, ask_user, delegate", () => {
    const prompt = buildChildSystemPrompt(minimalArgs);
    expect(prompt).toContain("Do not call");
    expect(prompt).toContain("handoff");
    expect(prompt).toContain("ask_user");
    expect(prompt).toContain("delegate");
  });

  test("does NOT include the parent transcript (spec §7.3 boundary)", () => {
    // The envelope must not include any parent session state.
    // This is a structural test: the prompt is bounded and known not to
    // include parent session content.
    const prompt = buildChildSystemPrompt(minimalArgs);
    // The prompt should not mention the orchestrator's transcript or context.
    // The parentRole appears only in context ("on behalf of parent role X").
    expect(prompt).not.toContain("previous");
    expect(prompt).not.toContain("session history");
    expect(prompt).not.toContain("handoff_payload");
  });

  test("prompt length is reasonable (≤ 8 KiB)", () => {
    const prompt = buildChildSystemPrompt({
      ...minimalArgs,
      objective: "A".repeat(5000),
      expectedOutput: "B".repeat(2000),
    });
    expect(prompt.length).toBeLessThan(8192);
  });

  test("result is plain string with content", () => {
    const result = buildChildSystemPrompt(minimalArgs);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result.trim().length).toBeGreaterThan(0);
  });
});
