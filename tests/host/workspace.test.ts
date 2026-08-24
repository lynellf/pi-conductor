/**
 * Issue #48 T3 tests — Workspace manager.
 *
 * Table-driven tests for the workspace lifecycle (§5):
 * - Pinning: clean/dirty primary, `ref:`, non-Git
 * - `--detach` snapshot idempotency
 * - Per-visit branch naming
 * - Resume re-creation
 * - No auto-cleanup (INV-005)
 *
 * Uses temp real Git repos via `tmp` + `mkdtemp`.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ensureSharedSnapshotForResume,
  ensureSnapshotCheckout,
  hasSnapshotCheckout,
  listSnapshotShortCommits,
  listWorkspaceNames,
  provisionWorkspace,
  removeSnapshotCheckout,
  removeWorkspace,
  resolvePinnedCommit,
  resolveSharedSnapshot,
  resumeWorkspace,
  type SnapshotCheckout,
  SnapshotError,
  WorkspaceError,
  type WorkspaceResult,
} from "../../src/host/workspace/index.js";
import {
  computeGuarantee,
  type GuaranteeResult,
  pathInProjection,
} from "../../src/host/workspace/mounts.js";

const execFileAsync = promisify(execFile);

// ─── Helpers ────────────────────────────────────────────────────────────

async function createGitRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "# Test\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: dir });
}

async function commitFile(dir: string, name: string, content: string): Promise<string> {
  await writeFile(join(dir, name), content);
  await execFileAsync("git", ["add", name], { cwd: dir });
  const { stdout } = await execFileAsync("git", ["commit", "-m", `add ${name}`], { cwd: dir });
  // git commit outputs the commit message, not the hash.
  // Get the hash from git log.
  const { stdout: hash } = await execFileAsync("git", ["log", "-1", "--format=%H"], { cwd: dir });
  return hash.trim();
}

function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-conductor-t3-"));
}

// ─── Tests: resolvePinnedCommit ─────────────────────────────────────────

describe("resolvePinnedCommit (T3 pinning)", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await createTempDir();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it("resolves HEAD for a clean repo (source: snapshot)", async () => {
    const repoDir = join(tmp, "repo");
    await mkdir(repoDir, { recursive: true });
    await createGitRepo(repoDir);

    const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoDir });
    const commit = await resolvePinnedCommit(repoDir, "snapshot");
    expect(commit).toBe(head.trim());
  });

  it("resolves a specific commit (source: snapshot, after multiple commits)", async () => {
    const repoDir = join(tmp, "repo");
    await mkdir(repoDir, { recursive: true });
    await createGitRepo(repoDir);
    const commit2 = await commitFile(repoDir, "b.txt", "b");
    const commit3 = await commitFile(repoDir, "c.txt", "c");

    const commit = await resolvePinnedCommit(repoDir, "snapshot");
    expect(commit).toBe(commit3);
  });

  it("resolves a named ref (source: ref:<ref>)", async () => {
    const repoDir = join(tmp, "repo");
    await mkdir(repoDir, { recursive: true });
    await createGitRepo(repoDir);
    const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoDir });
    await execFileAsync("git", ["branch", "feature"], { cwd: repoDir });

    const commit = await resolvePinnedCommit(repoDir, "ref:feature");
    expect(commit).toBe(head.trim());
  });

  it("throws SnapshotError('non-git') for a non-Git directory", async () => {
    const repoDir = join(tmp, "nogit");
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, "file.txt"), "content");

    await expect(resolvePinnedCommit(repoDir, "snapshot")).rejects.toThrow(
      expect.objectContaining({ code: "non-git" }),
    );
  });

  it("throws SnapshotError('git-failed') for a bad ref", async () => {
    const repoDir = join(tmp, "repo");
    await mkdir(repoDir, { recursive: true });
    await createGitRepo(repoDir);

    await expect(resolvePinnedCommit(repoDir, "ref:nonexistent-branch")).rejects.toThrow(
      expect.objectContaining({ code: "git-failed" }),
    );
  });
});

// ─── Tests: ensureSnapshotCheckout ────────────────────────────────────────

describe("ensureSnapshotCheckout (T3 snapshot idempotency)", () => {
  let tmp: string;
  let primaryCheckout: string;
  let snapshotsDir: string;
  let commit: string;

  beforeEach(async () => {
    tmp = await createTempDir();
    primaryCheckout = join(tmp, "primary");
    snapshotsDir = join(tmp, "snapshots");
    await mkdir(primaryCheckout, { recursive: true });
    await createGitRepo(primaryCheckout);
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: primaryCheckout });
    commit = stdout.trim();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it("creates a new snapshot worktree", async () => {
    const result = await ensureSnapshotCheckout(snapshotsDir, commit, primaryCheckout);
    expect(result.shortCommit).toBe(commit.slice(0, 8));

    // Verify the worktree exists and points at the correct commit.
    const { stdout: wc } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: result.checkoutPath,
    });
    expect(wc.trim()).toBe(commit);
  });

  it("returns the same path for the same commit (idempotent — REQ-005)", async () => {
    const r1 = await ensureSnapshotCheckout(snapshotsDir, commit, primaryCheckout);
    const r2 = await ensureSnapshotCheckout(snapshotsDir, commit, primaryCheckout);
    expect(r1.checkoutPath).toBe(r2.checkoutPath);
  });

  it("replaces a stale checkout (different commit)", async () => {
    const r1 = await ensureSnapshotCheckout(snapshotsDir, commit, primaryCheckout);
    // Make a new commit in the primary.
    const newCommit = await commitFile(primaryCheckout, "new.txt", "new");
    // Create another snapshot at the new commit.
    const r2 = await ensureSnapshotCheckout(snapshotsDir, newCommit, primaryCheckout);
    expect(r2.checkoutPath).not.toBe(r1.checkoutPath);
    const { stdout: wc } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: r2.checkoutPath,
    });
    expect(wc.trim()).toBe(newCommit);
  });

  it("does not leak directories (only sha8/ dirs exist)", async () => {
    // Pass the snapshotsDir directly to ensureSnapshotCheckout.
    await ensureSnapshotCheckout(snapshotsDir, commit, primaryCheckout);
    // Since snapshotsDir IS the snapshots directory (not runStateDir),
    // read its contents directly.
    const entries = await readdir(snapshotsDir);
    expect(entries).toEqual([commit.slice(0, 8)]);
  });
});

// ─── Tests: hasSnapshotCheckout ──────────────────────────────────────────

describe("hasSnapshotCheckout (T3 snapshot existence)", () => {
  let tmp: string;
  let primaryCheckout: string;
  let snapshotsDir: string;

  beforeEach(async () => {
    tmp = await createTempDir();
    primaryCheckout = join(tmp, "primary");
    snapshotsDir = join(tmp, "snapshots");
    await mkdir(primaryCheckout, { recursive: true });
    await createGitRepo(primaryCheckout);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it("returns true for an existing checkout at the right commit", async () => {
    const { stdout: commit } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: primaryCheckout,
    });
    const checkout = await ensureSnapshotCheckout(snapshotsDir, commit.trim(), primaryCheckout);
    const exists = await hasSnapshotCheckout(
      snapshotsDir,
      checkout.checkoutPath.split("/").pop()! === commit.slice(0, 8) ? commit.trim() : "",
    );
    // Actually use the full commit.
    const exists2 = await hasSnapshotCheckout(snapshotsDir, commit.trim());
    expect(exists2).toBe(true);
  });

  it("returns false for a non-existent checkout", async () => {
    const fakeCommit = "0000000000000000000000000000000000000000";
    expect(await hasSnapshotCheckout(snapshotsDir, fakeCommit)).toBe(false);
  });
});

// ─── Tests: provisionWorkspace ────────────────────────────────────────────

describe("provisionWorkspace (T3 per-visit provisioning)", () => {
  let tmp: string;
  let primaryCheckout: string;
  let runStateDir: string;
  let commit: string;

  beforeEach(async () => {
    tmp = await createTempDir();
    primaryCheckout = join(tmp, "primary");
    runStateDir = join(tmp, "runs", "test-run");
    await mkdir(primaryCheckout, { recursive: true });
    await createGitRepo(primaryCheckout);
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: primaryCheckout });
    commit = stdout.trim();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it("shared backend returns the primary checkout", async () => {
    const result = await provisionWorkspace({
      role: "implementer" as never,
      visitIndex: 1,
      backend: "shared",
      source: "snapshot",
      commit,
      primaryCheckout,
      runStateDir,
    });
    expect(result.backend).toBe("shared");
    expect(result.workspacePath).toBe(primaryCheckout);
  });

  it("worktree backend creates a per-visit worktree", async () => {
    const runStateDirShort = join(tmp, "runs", "run1");
    const result = await provisionWorkspace({
      role: "implementer" as never,
      visitIndex: 1,
      backend: "worktree",
      source: "snapshot",
      commit,
      primaryCheckout,
      runStateDir: runStateDirShort,
    });
    expect(result.backend).toBe("worktree");
    expect(result.shortCommit).toBe(commit.slice(0, 8));
    // Verify the worktree exists and points at the correct commit.
    const { stdout: wc } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: result.workspacePath,
    });
    expect(wc.trim()).toBe(commit);
  });

  it("worktree backend supports ref: source", async () => {
    const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: primaryCheckout,
    });
    await execFileAsync("git", ["branch", "feature"], { cwd: primaryCheckout });
    const { stdout: featureCommit } = await execFileAsync("git", ["rev-parse", "feature"], {
      cwd: primaryCheckout,
    });

    const runStateDirShort = join(tmp, "runs", "run2");
    const result = await provisionWorkspace({
      role: "reviewer" as never,
      visitIndex: 1,
      backend: "worktree",
      source: "ref:feature",
      commit: featureCommit.trim(),
      primaryCheckout,
      runStateDir: runStateDirShort,
    });
    const { stdout: wc } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: result.workspacePath,
    });
    expect(wc.trim()).toBe(featureCommit.trim());
  });

  it("copy backend (Git repo) creates a non-Git copy", async () => {
    const runStateDirShort = join(tmp, "runs", "run3");
    // Get the real commit hash from the test repo.
    const { stdout: testCommit } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: primaryCheckout,
    });

    const result = await provisionWorkspace({
      role: "implementer" as never,
      visitIndex: 1,
      backend: "copy",
      source: "snapshot",
      commit: testCommit.trim(),
      primaryCheckout,
      runStateDir: runStateDirShort,
    });
    expect(result.backend).toBe("copy");
    // The copy should NOT have a .git directory.
    const { stat } = await import("node:fs/promises");
    const hasGit = await stat(join(result.workspacePath, ".git"))
      .then(() => true)
      .catch(() => false);
    expect(hasGit).toBe(false);
    // But the README should exist.
    const readme = await readFile(join(result.workspacePath, "README.md"), "utf-8");
    expect(readme).toContain("# Test");
  });

  it("copy backend (non-Git) does a recursive copy", async () => {
    const nonGitDir = join(tmp, "nogit");
    await mkdir(nonGitDir, { recursive: true });
    await writeFile(join(nonGitDir, "file.txt"), "content");
    await mkdir(join(nonGitDir, "sub"), { recursive: true });
    await writeFile(join(nonGitDir, "sub", "nested.txt"), "nested");

    const runStateDirShort = join(tmp, "runs", "run4");
    const result = await provisionWorkspace({
      role: "implementer" as never,
      visitIndex: 1,
      backend: "copy",
      source: "snapshot" as const,
      commit: "unused",
      primaryCheckout: nonGitDir,
      runStateDir: runStateDirShort,
    });
    const { readFile: rf, stat } = await import("node:fs/promises");
    const fileExists = await stat(join(result.workspacePath, "file.txt"))
      .then(() => true)
      .catch(() => false);
    const nestedExists = await stat(join(result.workspacePath, "sub", "nested.txt"))
      .then(() => true)
      .catch(() => false);
    expect(fileExists).toBe(true);
    expect(nestedExists).toBe(true);
    expect(await rf(join(result.workspacePath, "sub", "nested.txt"), "utf-8")).toBe("nested");
  });
});

// ─── Tests: resumeWorkspace ──────────────────────────────────────────────

describe("resumeWorkspace (T3 resume re-creation)", () => {
  let tmp: string;
  let primaryCheckout: string;
  let runStateDir: string;
  let commit: string;

  beforeEach(async () => {
    tmp = await createTempDir();
    primaryCheckout = join(tmp, "primary");
    runStateDir = join(tmp, "runs", "run5");
    await mkdir(primaryCheckout, { recursive: true });
    await createGitRepo(primaryCheckout);
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: primaryCheckout });
    commit = stdout.trim();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it("re-creates a worktree that was deleted (resume scenario)", async () => {
    const runStateDirShort = join(tmp, "runs", "run5a");
    // Provision a workspace.
    const r1 = await provisionWorkspace({
      role: "implementer" as never,
      visitIndex: 1,
      backend: "worktree",
      source: "snapshot",
      commit,
      primaryCheckout,
      runStateDir: runStateDirShort,
    });

    // Delete the worktree (simulating a crash/interruption).
    await rm(r1.workspacePath, { recursive: true, force: true });

    // Resume should re-create it.
    const r2 = await resumeWorkspace({
      role: "implementer" as never,
      visitIndex: 1,
      backend: "worktree",
      source: "snapshot",
      commit,
      primaryCheckout,
      runStateDir: runStateDirShort,
    });

    // The workspace should exist again and point at the same commit.
    const { stdout: wc } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: r2.workspacePath,
    });
    expect(wc.trim()).toBe(commit);
  });

  it("re-creates a copy that was deleted", async () => {
    const runStateDirShort = join(tmp, "runs", "run5b");
    // Get the real commit hash from the test repo.
    const { stdout: testCommit } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: primaryCheckout,
    });

    const r1 = await provisionWorkspace({
      role: "implementer" as never,
      visitIndex: 1,
      backend: "copy",
      source: "snapshot",
      commit: testCommit.trim(),
      primaryCheckout,
      runStateDir: runStateDirShort,
    });

    await rm(r1.workspacePath, { recursive: true, force: true });

    const r2 = await resumeWorkspace({
      role: "implementer" as never,
      visitIndex: 1,
      backend: "copy",
      source: "snapshot",
      commit: testCommit.trim(),
      primaryCheckout,
      runStateDir: runStateDirShort,
    });

    const { stat, readFile: rf } = await import("node:fs/promises");
    const hasReadme = await stat(join(r2.workspacePath, "README.md"))
      .then(() => true)
      .catch(() => false);
    expect(hasReadme).toBe(true);
    expect(await rf(join(r2.workspacePath, "README.md"), "utf-8")).toContain("# Test");
  });
});

// ─── Tests: INV-005 (no auto-cleanup) ────────────────────────────────────

describe("INV-005: no auto-cleanup", () => {
  let tmp: string;
  let primaryCheckout: string;
  let runStateDir: string;

  beforeEach(async () => {
    tmp = await createTempDir();
    primaryCheckout = join(tmp, "primary");
    runStateDir = join(tmp, "runs", "run6");
    await mkdir(primaryCheckout, { recursive: true });
    await createGitRepo(primaryCheckout);
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: primaryCheckout });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it("workspaces persist after multiple visits (no auto-deletion)", async () => {
    const runStateDirShort = join(tmp, "runs", "run6a");
    const { stdout: commit } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: primaryCheckout,
    });

    // Create 3 workspaces.
    for (let v = 1; v <= 3; v++) {
      await provisionWorkspace({
        role: "implementer" as never,
        visitIndex: v,
        backend: "worktree",
        source: "snapshot",
        commit: commit.trim(),
        primaryCheckout,
        runStateDir: runStateDirShort,
      });
    }

    // All 3 should still exist.
    const names = await listWorkspaceNames(runStateDirShort);
    expect(names).toHaveLength(3);
  });

  it("snapshots persist after multiple unique commits", async () => {
    const runStateDirShort = join(tmp, "runs", "run6b");
    const { stdout: commit1 } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: primaryCheckout,
    });

    // Create 2 snapshots at the same commit (should merge to 1).
    await ensureSnapshotCheckout(
      join(runStateDirShort, "snapshots"),
      commit1.trim(),
      primaryCheckout,
    );
    await ensureSnapshotCheckout(
      join(runStateDirShort, "snapshots"),
      commit1.trim(),
      primaryCheckout,
    );

    // Make a new commit and create another snapshot.
    await commitFile(primaryCheckout, "file2.txt", "file2");
    const { stdout: commit2 } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: primaryCheckout,
    });
    await ensureSnapshotCheckout(
      join(runStateDirShort, "snapshots"),
      commit2.trim(),
      primaryCheckout,
    );

    const entries = await listSnapshotShortCommits(runStateDirShort);
    expect(entries).toHaveLength(2);
  });
});

// ─── Tests: computeGuarantee ─────────────────────────────────────────────

describe("computeGuarantee (T3 guarantee computation)", () => {
  it("shared → guarantee 'none'", () => {
    const result = computeGuarantee({
      backend: "shared",
      tools: ["read", "edit", "handoff", "end"],
      source: "snapshot",
      pinDir: "/test",
      pinSha8: "abc12345",
    });
    expect(result.level).toBe("none");
    expect(result.warnings).toEqual([]);
  });

  it("worktree (in-process) → 'confined'", () => {
    const result = computeGuarantee({
      backend: "worktree",
      tools: ["read", "edit", "write", "handoff", "end"],
      source: "snapshot",
      pinDir: "/test",
      pinSha8: "abc12345",
    });
    expect(result.level).toBe("confined");
  });

  it("copy (in-process) → 'confined'", () => {
    const result = computeGuarantee({
      backend: "copy",
      tools: ["read", "edit", "handoff", "end"],
      source: "snapshot",
      pinDir: "/test",
      pinSha8: "abc12345",
    });
    expect(result.level).toBe("confined");
  });

  it("container → 'sandbox' (no writable host mounts)", () => {
    const result = computeGuarantee({
      backend: "container",
      tools: ["read", "handoff", "end"],
      source: "snapshot",
      pinDir: "/test",
      pinSha8: "abc12345",
    });
    expect(result.level).toBe("sandbox");
  });

  it("container with writable absolute mount → 'confined' + warning (rule 7)", () => {
    const result = computeGuarantee({
      backend: "container",
      tools: ["read", "edit", "handoff", "end"],
      workspaceConfig: {
        mounts: [{ path: "/data/output", writable: true }],
      },
      source: "snapshot",
      pinDir: "/test",
      pinSha8: "abc12345",
    });
    expect(result.level).toBe("confined");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("capped at 'confined'");
  });

  it("worktree/copy with writable absolute mount → 'confined' + warning (rule 7)", () => {
    const result = computeGuarantee({
      backend: "worktree",
      tools: ["read", "edit", "handoff", "end"],
      workspaceConfig: {
        mounts: [{ path: "/shared/data", writable: true }],
      },
      source: "snapshot",
      pinDir: "/test",
      pinSha8: "abc12345",
    });
    expect(result.level).toBe("confined");
    expect(result.warnings).toHaveLength(1);
  });
});

// ─── Tests: pathInProjection ─────────────────────────────────────────────

describe("pathInProjection (T3 containment check)", () => {
  const projection: GuaranteeResult["projection"] = {
    workspaceRoot: "/home/user/project",
    mounts: [
      { path: "/home/user/snapshot/abc12345", writable: false },
      { path: "/data/output", writable: true },
    ],
  };

  it("returns inside=true for a path within the workspace root", () => {
    const result = pathInProjection("/home/user/project/src/main.ts", projection);
    expect(result.inside).toBe(true);
  });

  it("returns inside=true for a path within a mount", () => {
    const result = pathInProjection("/data/output/report.txt", projection);
    expect(result.inside).toBe(true);
  });

  it("returns inside=false for a path outside all roots", () => {
    const result = pathInProjection("/other/secret/.ssh/id_rsa", projection);
    expect(result.inside).toBe(false);
    expect((result as { inside: false; reason: string }).reason).toContain(
      "outside all projection roots",
    );
  });
});
