/**
 * Tests for delegation/child-tool-policy.ts.
 */

import { describe, expect, test } from "vitest";
import {
  buildChildToolsAllowlist,
  isForbiddenTool,
} from "../../../src/host/delegation/child-tool-policy.js";

describe("buildChildToolsAllowlist", () => {
  describe('workspace: "read_only"', () => {
    test("returns read-only tool list", () => {
      const tools = buildChildToolsAllowlist({
        workspace: "read_only",
        role: "worker",
      });
      expect(tools).toEqual(["read", "grep", "find", "ls", "report_result"]);
    });

    test("includes report_result", () => {
      const tools = buildChildToolsAllowlist({
        workspace: "read_only",
        role: "orchestrator",
      });
      expect(tools).toContain("report_result");
    });

    test("does NOT include edit, write, run", () => {
      const tools = buildChildToolsAllowlist({
        workspace: "read_only",
        role: "worker",
      });
      expect(tools).not.toContain("edit");
      expect(tools).not.toContain("write");
      expect(tools).not.toContain("run");
      expect(tools).not.toContain("bash");
    });

    test("does NOT include handoff, end, ask_user, delegate", () => {
      const tools = buildChildToolsAllowlist({
        workspace: "read_only",
        role: "worker",
      });
      for (const forbidden of ["handoff", "end", "ask_user", "delegate", "bash"]) {
        expect(tools).not.toContain(forbidden);
      }
    });
  });

  describe('workspace: "worktree"', () => {
    test("returns worktree tool list", () => {
      const tools = buildChildToolsAllowlist({
        workspace: "worktree",
        role: "worker",
      });
      expect(tools).toContain("edit");
      expect(tools).toContain("write");
      expect(tools).toContain("run");
      expect(tools).toContain("read");
      expect(tools).toContain("report_result");
    });

    test("does NOT include bash", () => {
      const tools = buildChildToolsAllowlist({
        workspace: "worktree",
        role: "worker",
      });
      expect(tools).not.toContain("bash");
    });

    test("does NOT include handoff, end, ask_user, delegate", () => {
      const tools = buildChildToolsAllowlist({
        workspace: "worktree",
        role: "worker",
      });
      for (const forbidden of ["handoff", "end", "ask_user", "delegate", "bash"]) {
        expect(tools).not.toContain(forbidden);
      }
    });

    test("role parameter is accepted (no-op in Phase 2)", () => {
      // Phase 2: role is accepted but not used for filtering.
      // Phase 3 may use it for per-role tool overrides.
      const tools1 = buildChildToolsAllowlist({
        workspace: "worktree",
        role: "worker",
      });
      const tools2 = buildChildToolsAllowlist({
        workspace: "worktree",
        role: "orchestrator",
      });
      expect(tools1).toEqual(tools2);
    });
  });

  test("returns readonly arrays", () => {
    const tools = buildChildToolsAllowlist({
      workspace: "read_only",
      role: "worker",
    });
    // The returned array is readonly.
    expect(Object.isFrozen(tools)).toBe(true);
  });
});

describe("isForbiddenTool", () => {
  test("returns true for forbidden tools", () => {
    for (const tool of ["handoff", "end", "ask_user", "delegate", "bash"]) {
      expect(isForbiddenTool(tool)).toBe(true);
    }
  });

  test("returns false for allowed tools", () => {
    for (const tool of ["read", "write", "edit", "grep", "find", "ls", "run", "report_result"]) {
      expect(isForbiddenTool(tool)).toBe(false);
    }
  });
});
