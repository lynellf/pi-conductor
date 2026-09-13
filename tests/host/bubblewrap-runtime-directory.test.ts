import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capturePreparedRuntime } from "../../src/host/execution/sandbox/runtime-capture.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("protected runtime directory diagnostics (#108)", () => {
  it.each([
    ["missing", "missing", "ENOENT"],
    ["file", "not a directory", undefined],
    ["symlink", "symlink", undefined],
    ["dangling symlink", "symlink", undefined],
    ["symlink ancestor", "noncanonical", undefined],
    ["file ancestor", "non-directory path component", "ENOTDIR"],
    ["noncanonical", "noncanonical", undefined],
  ])("identifies the %s protected destination", async (kind, category, code) => {
    const root = await mkdtemp(join(tmpdir(), "conductor-108-directory-"));
    roots.push(root);
    for (const name of ["source", "state", "checkout"]) await mkdir(join(root, name));
    let destination = join(root, "state", "worktrees");
    if (kind === "file") await writeFile(destination, "retain me");
    if (kind === "symlink") await symlink(join(root, "checkout"), destination);
    if (kind === "dangling symlink") await symlink(join(root, "absent"), destination);
    if (kind === "symlink ancestor") {
      await mkdir(join(root, "checkout", "worktrees"));
      await symlink(join(root, "checkout"), join(root, "state", "alias"));
      destination = join(root, "state", "alias", "worktrees");
    }
    if (kind === "file ancestor") {
      await writeFile(join(root, "state", "file"), "retain me");
      destination = join(root, "state", "file", "worktrees");
    }
    if (kind === "noncanonical") destination = `${root}/state/./worktrees`;
    const result = capturePreparedRuntime({
      sourcePath: join(root, "source"),
      snapshotParent: join(root, "state"),
      hostProtection: {
        primaryCheckout: join(root, "checkout"),
        stateRoots: [join(root, "state")],
        childWorkspaceRoots: [destination],
      },
      bootstrapApproval: { approvalId: "unused-before-validation", files: [] },
    });
    await expect(result).rejects.toMatchObject({
      code: "runtime-invalid-source",
      message: expect.stringContaining(JSON.stringify(destination)),
    });
    await expect(result).rejects.toThrow(category);
    if (code !== undefined) await expect(result).rejects.toThrow(code);
  });

  it("bounds and escapes a missing protected filename", async () => {
    const root = await mkdtemp(join(tmpdir(), "conductor-108-directory-"));
    roots.push(root);
    for (const name of ["source", "state", "checkout"]) await mkdir(join(root, name));
    const destination = `${root}/state/missing\n\u001b/${"long/".repeat(100)}`.slice(0, -1);
    const result = capturePreparedRuntime({
      sourcePath: join(root, "source"),
      snapshotParent: join(root, "state"),
      hostProtection: {
        primaryCheckout: join(root, "checkout"),
        stateRoots: [join(root, "state")],
        childWorkspaceRoots: [destination],
      },
      bootstrapApproval: { approvalId: "unused-before-validation", files: [] },
    }).catch((cause: unknown) => cause);
    const error = await result;
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("expected directory error");
    expect(error.message).toContain("\\n\\u001b");
    expect(error.message).toContain("truncated");
    expect(error.message).toContain("ENOENT");
    expect(error.message).not.toContain("\n");
    expect(error.message).not.toContain("\u001b");
    expect(error.message.length).toBeLessThan(1200);
  });
});
