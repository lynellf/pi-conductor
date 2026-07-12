/**
 * Tests for delegation/worktree.ts — Git worktree lifecycle manager.
 */

import { describe, expect, test } from "vitest";
import { isValidChildId } from "../../../src/host/delegation/ids.js";
import { createWorktreeManager, WorktreeError } from "../../../src/host/delegation/worktree.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

// In-memory fake runGit for testing
function createFakeRunGit(behavior: {
  isRepo?: boolean;
  currentHead?: string | null;
  isClean?: boolean;
  worktreeCreate?: { exitCode: number; stderr: string };
  branchHead?: string | null;
  worktreeClean?: boolean;
  removeResult?: { exitCode: number; stderr: string };
}) {
  return async (
    args: readonly string[],
    _opts?: { cwd?: string },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    const cmd = args[0];
    if (cmd === "rev-parse") {
      if (args[1] === "--show-toplevel") {
        return {
          stdout: behavior.isRepo ? "/project" : "",
          stderr: "",
          exitCode: behavior.isRepo ? 0 : 128,
        };
      }
      if (args[1] === "--verify" && args[2] === "HEAD") {
        return {
          stdout: behavior.currentHead ?? "",
          stderr: "",
          exitCode: behavior.currentHead ? 0 : 128,
        };
      }
      if (args[1] === "--verify" && args[2]?.startsWith("conductor/")) {
        return {
          stdout: behavior.branchHead ?? "",
          stderr: "",
          exitCode: behavior.branchHead ? 0 : 128,
        };
      }
    }
    if (cmd === "status") {
      // This handles: status, status --porcelain=v1, status --porcelain=v1 --untracked-files=all
      return {
        stdout: behavior.isClean ? "" : "M  file.txt",
        stderr: "",
        exitCode: 0,
      };
    }
    if (cmd === "worktree") {
      if (args[1] === "add") {
        return {
          stdout: `Preparing worktree (new branch 'conductor/child-xxx')\nDetached HEAD at abc1234`,
          stderr: behavior.worktreeCreate?.stderr ?? "",
          exitCode: behavior.worktreeCreate?.exitCode ?? 0,
        };
      }
      if (args[1] === "remove") {
        return {
          stdout: "",
          stderr: behavior.removeResult?.stderr ?? "",
          exitCode: behavior.removeResult?.exitCode ?? 0,
        };
      }
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
}

const STATE_DIR = "/run/42eae1e0";
const CWD = "/project";

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("createWorktreeManager", () => {
  describe("isRepo", () => {
    test("returns true for a git repository", async () => {
      const runGit = createFakeRunGit({ isRepo: true });
      const mgr = createWorktreeManager({ cwd: CWD, stateDir: STATE_DIR, runGit });

      const result = await mgr.isRepo();

      expect(result).toBe(true);
    });

    test("returns false for non-repository", async () => {
      const runGit = createFakeRunGit({ isRepo: false });
      const mgr = createWorktreeManager({ cwd: CWD, stateDir: STATE_DIR, runGit });

      const result = await mgr.isRepo();

      expect(result).toBe(false);
    });
  });

  describe("currentHead", () => {
    test("returns current HEAD commit hash", async () => {
      const runGit = createFakeRunGit({ currentHead: "abc123def456" });
      const mgr = createWorktreeManager({ cwd: CWD, stateDir: STATE_DIR, runGit });

      const result = await mgr.currentHead();

      expect(result).toBe("abc123def456");
    });

    test("returns null for empty repository", async () => {
      const runGit = createFakeRunGit({ currentHead: null });
      const mgr = createWorktreeManager({ cwd: CWD, stateDir: STATE_DIR, runGit });

      const result = await mgr.currentHead();

      expect(result).toBeNull();
    });
  });

  describe("isClean", () => {
    test("returns true for clean working directory", async () => {
      const runGit = createFakeRunGit({ isClean: true });
      const mgr = createWorktreeManager({ cwd: CWD, stateDir: STATE_DIR, runGit });

      const result = await mgr.isClean();

      expect(result).toBe(true);
    });

    test("returns false for dirty working directory", async () => {
      const runGit = createFakeRunGit({ isClean: false });
      const mgr = createWorktreeManager({ cwd: CWD, stateDir: STATE_DIR, runGit });

      const result = await mgr.isClean();

      expect(result).toBe(false);
    });
  });

  describe("create", () => {
    test("creates worktree with valid childId (16 hex chars)", async () => {
      const runGit = createFakeRunGit({});
      const mgr = createWorktreeManager({ cwd: CWD, stateDir: STATE_DIR, runGit });

      // Valid childId: 16 hex characters (8 bytes = 16 hex chars)
      const result = await mgr.create({ childId: "child-abcdef1234567890", baseCommit: "abc1234" });

      expect(result.path).toBe(`${STATE_DIR}/worktrees/child-abcdef1234567890`);
      expect(result.branch).toBe("conductor/child-abcdef1234567890");
    });

    test("rejects invalid childId format", async () => {
      const runGit = createFakeRunGit({});
      const mgr = createWorktreeManager({ cwd: CWD, stateDir: STATE_DIR, runGit });

      await expect(mgr.create({ childId: "invalid-id", baseCommit: "abc1234" })).rejects.toThrow(
        WorktreeError,
      );

      try {
        await mgr.create({ childId: "invalid-id", baseCommit: "abc1234" });
      } catch (err) {
        expect(err).toBeInstanceOf(WorktreeError);
        expect((err as WorktreeError).code).toBe("invalid_child_id");
      }
    });

    test("handles branch already exists error", async () => {
      const runGit = createFakeRunGit({
        worktreeCreate: {
          exitCode: 1,
          stderr: "fatal: 'conductor/child-abcd123456789000' already exists",
        },
      });
      const mgr = createWorktreeManager({ cwd: CWD, stateDir: STATE_DIR, runGit });

      await expect(
        mgr.create({ childId: "child-abcd123456789000", baseCommit: "abc1234" }),
      ).rejects.toThrow(WorktreeError);

      try {
        await mgr.create({ childId: "child-abcd123456789000", baseCommit: "abc1234" });
      } catch (err) {
        expect(err).toBeInstanceOf(WorktreeError);
        expect((err as WorktreeError).code).toBe("branch_exists");
      }
    });
  });

  describe("head", () => {
    test("returns commit hash for conductor branch", async () => {
      const runGit = createFakeRunGit({ branchHead: "def567" });
      const mgr = createWorktreeManager({ cwd: CWD, stateDir: STATE_DIR, runGit });

      const result = await mgr.head("conductor/child-abcdef1234567890");

      expect(result).toBe("def567");
    });

    test("returns null for non-existent branch", async () => {
      const runGit = createFakeRunGit({ branchHead: null });
      const mgr = createWorktreeManager({ cwd: CWD, stateDir: STATE_DIR, runGit });

      const result = await mgr.head("conductor/child-abcdef1234567890");

      expect(result).toBeNull();
    });
  });

  describe("isWorktreeClean", () => {
    test("returns true for non-conductor paths (safety)", async () => {
      const runGit = createFakeRunGit({});
      const mgr = createWorktreeManager({ cwd: CWD, stateDir: STATE_DIR, runGit });

      // Paths not beneath stateDir/worktrees/ are treated as clean
      // This is a safety check to prevent accidental removal of non-worktree paths
      const result = await mgr.isWorktreeClean("/etc/passwd");

      expect(result).toBe(true);
    });

    test("returns true for clean worktree (git status returns empty output)", async () => {
      // Create a fake that returns clean status for worktree paths
      const cleanRunGit = async (
        _args: readonly string[],
        _opts?: { cwd?: string },
      ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      const mgr = createWorktreeManager({ cwd: CWD, stateDir: STATE_DIR, runGit: cleanRunGit });

      const result = await mgr.isWorktreeClean(`${STATE_DIR}/worktrees/child-abcdef1234567890`);

      expect(result).toBe(true);
    });

    test("returns false for dirty worktree (git status returns modified files)", async () => {
      // Create a fake that returns dirty status for worktree paths
      const dirtyRunGit = async (
        _args: readonly string[],
        _opts?: { cwd?: string },
      ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
        return { stdout: "M  file.txt", stderr: "", exitCode: 0 };
      };
      const mgr = createWorktreeManager({ cwd: CWD, stateDir: STATE_DIR, runGit: dirtyRunGit });

      const result = await mgr.isWorktreeClean(`${STATE_DIR}/worktrees/child-abcdef1234567890`);

      expect(result).toBe(false);
    });
  });

  describe("remove", () => {
    test("removes conductor-owned worktree", async () => {
      const runGit = createFakeRunGit({ removeResult: { exitCode: 0, stderr: "" } });
      const mgr = createWorktreeManager({ cwd: CWD, stateDir: STATE_DIR, runGit });

      await expect(mgr.remove(`${STATE_DIR}/worktrees/abcdef1234567890`)).resolves.not.toThrow();
    });

    test("rejects removal of non-conductor paths", async () => {
      const runGit = createFakeRunGit({});
      const mgr = createWorktreeManager({ cwd: CWD, stateDir: STATE_DIR, runGit });

      await expect(mgr.remove("/etc/passwd")).rejects.toThrow(WorktreeError);

      try {
        await mgr.remove("/etc/passwd");
      } catch (err) {
        expect(err).toBeInstanceOf(WorktreeError);
        expect((err as WorktreeError).code).toBe("removal_failed");
        expect((err as WorktreeError).message).toContain("not beneath");
      }
    });

    test("handles removal failure", async () => {
      const runGit = createFakeRunGit({
        removeResult: { exitCode: 1, stderr: "fatal: could not remove" },
      });
      const mgr = createWorktreeManager({ cwd: CWD, stateDir: STATE_DIR, runGit });

      await expect(mgr.remove(`${STATE_DIR}/worktrees/abcdef1234567890`)).rejects.toThrow(
        WorktreeError,
      );

      try {
        await mgr.remove(`${STATE_DIR}/worktrees/abcdef1234567890`);
      } catch (err) {
        expect(err).toBeInstanceOf(WorktreeError);
        expect((err as WorktreeError).code).toBe("removal_failed");
      }
    });
  });
});

describe("isValidChildId", () => {
  test("accepts valid child IDs (16 hex chars)", () => {
    // Valid: 16 hex characters (8 bytes)
    expect(isValidChildId("child-0000000000000000")).toBe(true);
    expect(isValidChildId("child-ffffffffffffffff")).toBe(true);
    expect(isValidChildId("child-0123456789abcdef")).toBe(true);
    expect(isValidChildId("child-abcdef1234567890")).toBe(true);
  });

  test("rejects invalid child IDs", () => {
    expect(isValidChildId("")).toBe(false);
    expect(isValidChildId("child-")).toBe(false);
    expect(isValidChildId("child-abc")).toBe(false); // too short (3 chars)
    expect(isValidChildId("child-abc123def456")).toBe(false); // too short (12 chars)
    expect(isValidChildId("child-0123456789abcde")).toBe(false); // too short (15 chars)
    expect(isValidChildId("invalid-prefix-abc1234567890")).toBe(false);
    expect(isValidChildId("child-0123456789ABCDEF")).toBe(false); // uppercase
    expect(isValidChildId("child-abc!def12345678")).toBe(false); // special char
  });
});
