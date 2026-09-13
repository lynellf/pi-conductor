import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { captureMaterializedParentProjection } from "../../src/host/delegation/projection.js";
import { captureTrustedParentProjection } from "../../src/host/execution/sandbox/trusted-git-parent.js";
import { resolveSandboxWritableAuthority } from "../../src/host/execution/sandbox/writable-authority.js";

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("sandbox complete base projection capture", () => {
  it.each(["ordinary sparse", "sparse index"])("retains excluded paths with %s", async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "conductor-sandbox-projection-"));
    roots.push(root);
    const git = (args: string[]) => execute("git", args, { cwd: root });
    await git(["init", "--quiet"]);
    await mkdir(join(root, "src/visible"), { recursive: true });
    await mkdir(join(root, "src/hidden"), { recursive: true });
    await writeFile(join(root, "src/visible/a.ts"), "visible");
    await writeFile(join(root, "src/hidden/has spaces.ts"), "hidden");
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "base",
    ]);
    const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await git([
      "sparse-checkout",
      "init",
      "--cone",
      mode === "sparse index" ? "--sparse-index" : "--no-sparse-index",
    ]);
    await git(["sparse-checkout", "set", "src/visible"]);
    const captured = await captureMaterializedParentProjection(root, head);
    expect(captured.paths).toEqual(["src/visible/a.ts"]);
    expect(captured.trackedPaths).toEqual(["src/hidden/has spaces.ts", "src/visible/a.ts"]);
    expect(() =>
      resolveSandboxWritableAuthority({
        writablePaths: ["src"],
        selectedPaths: captured.paths,
        trackedPaths: captured.trackedPaths,
      }),
    ).toThrowError(expect.objectContaining({ code: "sandbox-writable-excluded-descendant" }));
  });

  it("filters nonselectable materialized paths while retaining all tracked metadata", async () => {
    const root = await repositoryWithPaths({
      "src/a+b.ts": "plus",
      "src/has spaces.ts": "spaces",
      "src/safe.ts": "safe",
    });

    const captured = await captureTrustedParentProjection(root);

    expect(captured.paths).toEqual(["src/safe.ts"]);
    expect(captured.trackedPaths).toEqual(["src/a+b.ts", "src/has spaces.ts", "src/safe.ts"]);
    expect(
      resolveSandboxWritableAuthority({
        writablePaths: ["src/safe.ts"],
        selectedPaths: captured.paths,
        trackedPaths: captured.trackedPaths,
      }),
    ).toEqual([{ path: "src/safe.ts", kind: "file" }]);
  });

  it("rejects a dirty nonselectable materialized path before filtering", async () => {
    const root = await repositoryWithPaths({
      "src/has spaces.ts": "clean",
      "src/safe.ts": "safe",
    });
    await chmod(join(root, "src"), 0o700);
    await chmod(join(root, "src/has spaces.ts"), 0o600);
    await writeFile(join(root, "src/has spaces.ts"), "dirty");

    await expect(captureTrustedParentProjection(root)).rejects.toThrow(
      "trusted parent working bytes differ from raw HEAD: src/has spaces.ts",
    );
  });

  it("rejects an unsupported nonselectable materialized path before filtering", async () => {
    const root = await repositoryWithPaths({
      "src/has spaces.ts": "content",
      "src/safe.ts": "safe",
    });
    await chmod(join(root, "src"), 0o700);
    await rm(join(root, "src/has spaces.ts"));
    await symlink("safe.ts", join(root, "src/has spaces.ts"));

    await expect(captureTrustedParentProjection(root)).rejects.toThrow();
  });

  it("rejects a group-writable trusted Git index before filtering", async () => {
    const root = await repositoryWithPaths({
      "src/has spaces.ts": "content",
      "src/safe.ts": "safe",
    });
    await chmod(join(root, ".git", "index"), 0o660);

    await expect(captureTrustedParentProjection(root)).rejects.toThrow();
  });

  it("rejects a committed nonselectable symlink before filtering", async () => {
    const root = await repositoryWithPaths({
      "src/has spaces.ts": "content",
      "src/safe.ts": "safe",
    });
    await rm(join(root, "src/has spaces.ts"));
    await symlink("safe.ts", join(root, "src/has spaces.ts"));
    const git = (args: string[]) => execute("git", args, { cwd: root });
    await git(["add", "src/has spaces.ts"]);
    await git([
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "add symlink",
    ]);
    await chmod(join(root, ".git", "index"), 0o600);

    await expect(captureTrustedParentProjection(root)).rejects.toThrow(
      "unsupported materialized parent Git entry: src/has spaces.ts",
    );
  });
});

async function repositoryWithPaths(paths: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "conductor-sandbox-projection-"));
  roots.push(root);
  const git = (args: string[]) => execute("git", args, { cwd: root });
  await git(["init", "--quiet"]);
  for (const [path, contents] of Object.entries(paths)) {
    const slash = path.lastIndexOf("/");
    if (slash > 0) await mkdir(join(root, path.slice(0, slash)), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  await git(["add", "."]);
  await git([
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "base",
  ]);
  await chmod(root, 0o700);
  await chmod(join(root, ".git"), 0o700);
  await chmod(join(root, ".git", "index"), 0o600);
  for (const path of Object.keys(paths)) {
    const slash = path.lastIndexOf("/");
    if (slash > 0) await chmod(join(root, path.slice(0, slash)), 0o700);
    await chmod(join(root, path), 0o600);
  }
  return root;
}
