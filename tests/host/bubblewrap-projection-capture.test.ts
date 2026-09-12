import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { captureMaterializedParentProjection } from "../../src/host/delegation/projection.js";
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
});
