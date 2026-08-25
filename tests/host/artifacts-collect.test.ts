/** Issue #48 R4.a — declared artifact collection behavior. */

import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectAutoPatch, collectDeclaredArtifacts } from "../../src/host/artifacts/collect.js";
import type { Projection } from "../../src/host/workspace/mounts.js";

let tempRoot: string;
let workspaceRoot: string;
let integrationRoot: string;
let artifactsDir: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "pi-conductor-artifacts-"));
  workspaceRoot = join(tempRoot, "workspace");
  integrationRoot = join(tempRoot, "integration");
  artifactsDir = join(tempRoot, "run-state", "artifacts", "run-1");
  await Promise.all([mkdir(workspaceRoot), mkdir(integrationRoot)]);
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

function collectionOptions(args: {
  projection?: Projection;
  artifactsConfig?: { max_file_bytes?: number; max_files?: number };
  role?: string;
  artifactsDir?: string;
}) {
  return {
    runId: "run-1",
    role: args.role ?? "implementer",
    visitIndex: 1,
    sessionId: "session-1",
    workspaceRoot,
    projection: args.projection ?? { workspaceRoot, mounts: [] },
    artifactsConfig: args.artifactsConfig,
    artifactsDir: args.artifactsDir ?? artifactsDir,
  };
}

async function initializeGitWorkspace(): Promise<void> {
  execFileSync("git", ["init", "--quiet"], { cwd: workspaceRoot });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspaceRoot });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workspaceRoot });
  await writeFile(join(workspaceRoot, "baseline.txt"), "baseline\n");
  execFileSync("git", ["add", "baseline.txt"], { cwd: workspaceRoot });
  execFileSync("git", ["commit", "--quiet", "-m", "initial"], { cwd: workspaceRoot });
}

describe("collectDeclaredArtifacts", () => {
  it("copies a declared workspace-relative file under the artifact store with durable metadata", async () => {
    const source = join(workspaceRoot, "reports", "result.txt");
    await mkdir(join(workspaceRoot, "reports"));
    await writeFile(source, "artifact result");

    const result = await collectDeclaredArtifacts(collectionOptions({}), {
      artifacts: [{ path: "reports/result.txt", description: "verification report" }],
    });

    const storedPath = join(artifactsDir, "implementer-v1", "reports", "result.txt");
    expect(result.collected).toEqual([
      expect.objectContaining({
        type: "artifact_collected",
        source_path: "reports/result.txt",
        stored_path: storedPath,
        description: "verification report",
        bytes: Buffer.byteLength("artifact result"),
        sha256: "2d549345584359cc42f750a3f5346b4966b0bb996105da3250d29a806b186371",
      }),
    ]);
    await expect(readFile(storedPath, "utf8")).resolves.toBe("artifact result");
    expect(result.rejected).toEqual([]);
  });

  it("rejects traversal, absolute, and symlink-escape declarations without copying the integration canary", async () => {
    const integrationCanary = join(integrationRoot, "integration-canary.txt");
    await writeFile(integrationCanary, "do not collect");
    await symlink(integrationCanary, join(workspaceRoot, "escape.txt"));

    const result = await collectDeclaredArtifacts(collectionOptions({}), {
      artifacts: [
        { path: "../integration/integration-canary.txt" },
        { path: integrationCanary },
        { path: "escape.txt" },
      ],
    });

    expect(result.collected).toEqual([]);
    expect(result.rejected.map((record) => ({ path: record.path, reason: record.reason }))).toEqual(
      [
        { path: "../integration/integration-canary.txt", reason: "outside_projection" },
        { path: integrationCanary, reason: "outside_projection" },
        { path: "escape.txt", reason: "outside_projection" },
      ],
    );
    await expect(readFile(integrationCanary, "utf8")).resolves.toBe("do not collect");
    await expect(
      lstat(join(artifactsDir, "implementer-v1", "integration-canary.txt")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    {
      name: "missing input",
      config: {},
      artifacts: [{ path: "missing.txt" }],
      reason: "missing",
    },
    {
      name: "oversized input",
      config: { max_file_bytes: 3 },
      artifacts: [{ path: "large.txt" }],
      reason: "size_cap",
    },
  ])("returns a persisted-ready $name rejection", async ({ config, artifacts, reason }) => {
    if (reason === "size_cap") {
      await writeFile(join(workspaceRoot, "large.txt"), "too large");
    }

    const result = await collectDeclaredArtifacts(collectionOptions({ artifactsConfig: config }), {
      artifacts,
    });

    const artifact = artifacts[0];
    if (artifact === undefined) throw new Error("test case must declare one artifact");

    expect(result.collected).toEqual([]);
    expect(result.rejected).toEqual([
      expect.objectContaining({ type: "artifact_rejected", path: artifact.path, reason }),
    ]);
  });

  it("rejects a non-regular declaration with a typed collection error", async () => {
    await mkdir(join(workspaceRoot, "directory-artifact"));

    await expect(
      collectDeclaredArtifacts(collectionOptions({}), {
        artifacts: [{ path: "directory-artifact" }],
      }),
    ).rejects.toMatchObject({ name: "ArtifactCollectionError", code: "not_regular" });
  });

  it("enforces the count cap after retaining prior collected artifacts", async () => {
    await writeFile(join(workspaceRoot, "first.txt"), "first");
    await writeFile(join(workspaceRoot, "second.txt"), "second");

    const result = await collectDeclaredArtifacts(
      collectionOptions({ artifactsConfig: { max_files: 1 } }),
      { artifacts: [{ path: "first.txt" }, { path: "second.txt" }] },
    );

    expect(result.collected).toHaveLength(1);
    expect(result.rejected).toEqual([
      expect.objectContaining({
        type: "artifact_rejected",
        path: "second.txt",
        reason: "count_cap",
      }),
    ]);
  });

  it("collects a writable virtual mount and rejects a read-only virtual mount", async () => {
    const mountRoot = join(tempRoot, "mount");
    await mkdir(mountRoot);
    await writeFile(join(mountRoot, "mounted.txt"), "mounted artifact");

    const writable = await collectDeclaredArtifacts(
      collectionOptions({
        projection: {
          workspaceRoot,
          mounts: [{ path: mountRoot, writable: true }],
        },
      }),
      { artifacts: [{ path: "mounts/0/mounted.txt" }] },
    );
    const readOnly = await collectDeclaredArtifacts(
      collectionOptions({
        projection: {
          workspaceRoot,
          mounts: [{ path: mountRoot, writable: false }],
        },
      }),
      { artifacts: [{ path: "mounts/0/mounted.txt" }] },
    );

    await expect(
      readFile(join(artifactsDir, "implementer-v1", "mounts", "0", "mounted.txt"), "utf8"),
    ).resolves.toBe("mounted artifact");
    expect(writable.rejected).toEqual([]);
    expect(readOnly.collected).toEqual([]);
    expect(readOnly.rejected).toEqual([expect.objectContaining({ reason: "outside_projection" })]);
  });

  it("preserves nested artifact paths without writing to the integration workspace", async () => {
    await mkdir(join(workspaceRoot, "reports"));
    await mkdir(join(workspaceRoot, "nested", "reports"), { recursive: true });
    await writeFile(join(workspaceRoot, "reports", "result.txt"), "root report");
    await writeFile(join(workspaceRoot, "nested", "reports", "result.txt"), "nested report");
    const integrationCanary = join(integrationRoot, "integration-canary.txt");
    await writeFile(integrationCanary, "integration stays untouched");

    const result = await collectDeclaredArtifacts(collectionOptions({}), {
      artifacts: [{ path: "reports/result.txt" }, { path: "nested/reports/result.txt" }],
    });

    expect(result.collected.map((record) => record.stored_path)).toEqual([
      join(artifactsDir, "implementer-v1", "reports", "result.txt"),
      join(artifactsDir, "implementer-v1", "nested", "reports", "result.txt"),
    ]);
    await expect(
      readFile(join(artifactsDir, "implementer-v1", "reports", "result.txt"), "utf8"),
    ).resolves.toBe("root report");
    await expect(
      readFile(join(artifactsDir, "implementer-v1", "nested", "reports", "result.txt"), "utf8"),
    ).resolves.toBe("nested report");
    await expect(readFile(integrationCanary, "utf8")).resolves.toBe("integration stays untouched");
    await expect(lstat(join(integrationRoot, "reports"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a role storage path that would write a declared artifact to integration", async () => {
    await writeFile(join(workspaceRoot, "report.txt"), "workspace report");
    const integrationArtifactsDir = join(
      integrationRoot,
      ".pi-conductor",
      "runs",
      "run-1",
      "artifacts",
      "run-1",
    );
    const integrationCanary = join(integrationRoot, "canary-v1", "report.txt");

    await expect(
      collectDeclaredArtifacts(
        collectionOptions({
          artifactsDir: integrationArtifactsDir,
          role: "../../../../../canary",
        }),
        { artifacts: [{ path: "report.txt" }] },
      ),
    ).rejects.toMatchObject({ name: "ArtifactCollectionError", code: "artifact_store_escape" });

    await expect(lstat(integrationCanary)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    {
      name: "artifact root",
      prepareSymlink: async () => {
        await mkdir(join(tempRoot, "run-state", "artifacts"), { recursive: true });
        await symlink(integrationRoot, artifactsDir);
      },
    },
    {
      name: "role visit directory",
      prepareSymlink: async () => {
        await mkdir(artifactsDir, { recursive: true });
        await symlink(integrationRoot, join(artifactsDir, "implementer-v1"));
      },
    },
  ])("rejects a symlinked output $name before declared or auto-patch collection can write integration", async ({
    prepareSymlink,
  }) => {
    await writeFile(join(workspaceRoot, "report.txt"), "workspace report");
    await initializeGitWorkspace();
    await writeFile(join(workspaceRoot, "baseline.txt"), "ordinary unstaged change\n");
    await prepareSymlink();

    const [declared, autoPatch] = await Promise.allSettled([
      collectDeclaredArtifacts(collectionOptions({}), { artifacts: [{ path: "report.txt" }] }),
      collectAutoPatch({
        workspacePath: workspaceRoot,
        artifactsDir,
        runId: "run-1",
        role: "implementer",
        visitIndex: 1,
        sessionId: "session-1",
        kind: "auto_patch",
      }),
    ]);

    expect(declared).toMatchObject({
      status: "rejected",
      reason: { name: "ArtifactCollectionError", code: "artifact_store_escape" },
    });
    expect(autoPatch).toMatchObject({
      status: "rejected",
      reason: { name: "ArtifactCollectionError", code: "artifact_store_escape" },
    });
    await expect(
      lstat(join(integrationRoot, "implementer-v1", "report.txt")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      lstat(join(integrationRoot, "implementer-v1", "patch-implementer-v1.patch")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns null only after Git successfully produces an empty diff", async () => {
    await initializeGitWorkspace();

    await expect(
      collectAutoPatch({
        workspacePath: workspaceRoot,
        artifactsDir,
        runId: "run-1",
        role: "implementer",
        visitIndex: 1,
        sessionId: "session-1",
        kind: "auto_patch",
      }),
    ).resolves.toBeNull();
  });

  it("surfaces a real Git command failure as a typed auto-patch collection error", async () => {
    await expect(
      collectAutoPatch({
        workspacePath: workspaceRoot,
        artifactsDir,
        runId: "run-1",
        role: "implementer",
        visitIndex: 1,
        sessionId: "session-1",
        kind: "auto_patch",
      }),
    ).rejects.toMatchObject({ name: "ArtifactCollectionError", code: "auto_patch_failed" });
  });

  it("stores normal working-tree changes and intent-to-add untracked files in its auto-patch", async () => {
    const storedPath = join(artifactsDir, "implementer-v1", "patch-implementer-v1.patch");
    await initializeGitWorkspace();
    await writeFile(join(workspaceRoot, "baseline.txt"), "ordinary unstaged change\n");
    await writeFile(join(workspaceRoot, "untracked.txt"), "untracked change\n");

    const result = await collectAutoPatch({
      workspacePath: workspaceRoot,
      artifactsDir,
      runId: "run-1",
      role: "implementer",
      visitIndex: 1,
      sessionId: "session-1",
      kind: "auto_patch",
    });

    expect(result).toEqual(
      expect.objectContaining({
        role: "implementer",
        source_path: "(auto_patch)",
        stored_path: storedPath,
        kind: "auto_patch",
      }),
    );
    await expect(readFile(storedPath, "utf8")).resolves.toContain("ordinary unstaged change");
    await expect(readFile(storedPath, "utf8")).resolves.toContain("untracked.txt");
    await expect(readFile(storedPath, "utf8")).resolves.toContain("untracked change");
  });

  it("rejects an auto-patch filename conflict without overwriting the declared artifact", async () => {
    const patchFileName = "patch-implementer-v1.patch";
    const declaredBytes = "preserve this declared artifact";
    const storedPath = join(artifactsDir, "implementer-v1", patchFileName);
    await initializeGitWorkspace();
    await writeFile(join(workspaceRoot, patchFileName), declaredBytes);
    await writeFile(join(workspaceRoot, "baseline.txt"), "ordinary unstaged change\n");

    await collectDeclaredArtifacts(collectionOptions({}), {
      artifacts: [{ path: patchFileName }],
    });

    await expect(
      collectAutoPatch({
        workspacePath: workspaceRoot,
        artifactsDir,
        runId: "run-1",
        role: "implementer",
        visitIndex: 1,
        sessionId: "session-1",
        kind: "auto_patch",
      }),
    ).rejects.toMatchObject({ name: "ArtifactCollectionError", code: "artifact_store_conflict" });
    await expect(readFile(storedPath, "utf8")).resolves.toBe(declaredBytes);
  });

  it("rejects a role storage path that would write an auto-patch to integration", async () => {
    const stagedFile = join(workspaceRoot, "staged.txt");
    const integrationArtifactsDir = join(
      integrationRoot,
      ".pi-conductor",
      "runs",
      "run-1",
      "artifacts",
      "run-1",
      "nested",
      "store",
      "root",
    );
    const integrationCanaryDir = join(
      integrationRoot,
      ".pi-conductor",
      "runs",
      "run-1",
      "canary-v1",
    );
    const escapedPatch = join(integrationRoot, ".pi-conductor", "canary-v1.patch");
    await initializeGitWorkspace();
    await writeFile(stagedFile, "ordinary unstaged change\n");

    await expect(
      collectAutoPatch({
        workspacePath: workspaceRoot,
        artifactsDir: integrationArtifactsDir,
        runId: "run-1",
        role: "../../../../../canary",
        visitIndex: 1,
        sessionId: "session-1",
        kind: "auto_patch",
      }),
    ).rejects.toMatchObject({ name: "ArtifactCollectionError", code: "artifact_store_escape" });

    await expect(lstat(integrationCanaryDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(escapedPatch)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
