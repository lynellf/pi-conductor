import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareControllerInvocationFiles } from "../../src/host/controller/invocation-files.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) =>
      execFile("chmod", ["-R", "u+w", root], (error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});
async function root() {
  const value = await mkdtemp(join(tmpdir(), "controller-files-"));
  roots.push(value);
  return value;
}

describe("controller invocation mounts", () => {
  it("gives the planner an empty read-only workspace and verifies exact bootstrap bytes", async () => {
    const state = await root();
    const files = await prepareControllerInvocationFiles(state, () => {});
    expect(files.writableMounts).toEqual([]);
    expect(await readdir(files.readonlyWorkspaceRoot)).toEqual([]);
    await files.verify();
    await chmod(files.bootstrapPath, 0o600);
    await writeFile(files.bootstrapPath, "untrusted");
    await expect(files.verify()).rejects.toThrow(/bootstrap/);
  });
  it("mounts only the adapter's output directory and rejects a replaced placeholder", async () => {
    const state = await root();
    const staging = join(state, "staging");
    await mkdir(join(staging, "output"), { recursive: true, mode: 0o700 });
    const files = await prepareControllerInvocationFiles(state, () => {}, staging);
    expect(files.writableMounts).toEqual([{ path: "output", kind: "directory" }]);
    expect(files.privateWritableRoot).toBe(staging);
    await files.verify();
    await chmod(files.readonlyWorkspaceRoot, 0o700);
    await rm(join(files.readonlyWorkspaceRoot, "output"), { recursive: true });
    await symlink(dirname(staging), join(files.readonlyWorkspaceRoot, "output"));
    await chmod(files.readonlyWorkspaceRoot, 0o500);
    await expect(files.verify()).rejects.toThrow(/placeholder/);
  });

  it("carries only host-verified source and file mounts with a bounded scratch quota", async () => {
    const state = await root();
    const source = join(state, "source");
    const inputs = join(state, "inputs");
    await mkdir(source, { mode: 0o700 });
    await mkdir(inputs, { mode: 0o700 });
    const files = await prepareControllerInvocationFiles(state, () => {}, undefined, {
      workspaceRoot: source,
      readonlyInputs: [
        { sourcePath: inputs, destination: "/inputs" },
        { sourcePath: source, destination: "/source-git" },
      ],
      scratchBytes: 4096,
    });
    expect(files.readonlyWorkspaceRoot).toBe(source);
    expect(files.readonlyInputs).toEqual([
      { sourcePath: inputs, destination: "/inputs" },
      { sourcePath: source, destination: "/source-git" },
    ]);
    expect(files.scratchBytes).toBe(4096);
  });
});
