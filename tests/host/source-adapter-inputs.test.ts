import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { materializeSourceAdapterInputs } from "../../src/host/controller/source-adapter-inputs.js";

const roots: string[] = [];
const execute = promisify(execFile);
afterEach(async () =>
  Promise.all(
    roots.splice(0).map(async (root) => {
      await execute("chmod", ["-R", "u+w", root]).catch(() => undefined);
      await chmod(root, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }),
  ),
);
describe("source adapter file inputs", () => {
  it("copies bounded authorized bytes into a private filesystem input tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "source-adapter-inputs-"));
    roots.push(root);
    const inputs = await materializeSourceAdapterInputs({
      root,
      files: [{ path: "request/data.txt", bytes: Buffer.from("sealed") }],
      maxFiles: 1,
      maxBytes: 6,
    });
    expect(await readFile(join(inputs.directory, "request/data.txt"), "utf8")).toBe("sealed");
    await expect(inputs.verify()).resolves.toBeUndefined();
  });
  it("rejects source-adapter input bytes changed after materialization", async () => {
    const root = await mkdtemp(join(tmpdir(), "source-adapter-inputs-"));
    roots.push(root);
    const inputs = await materializeSourceAdapterInputs({
      root,
      files: [{ path: "request/data.txt", bytes: Buffer.from("sealed") }],
      maxFiles: 1,
      maxBytes: 6,
    });
    await chmod(join(inputs.directory, "request"), 0o700);
    await chmod(join(inputs.directory, "request/data.txt"), 0o600);
    await writeFile(join(inputs.directory, "request/data.txt"), "mutated");
    await expect(inputs.verify()).rejects.toThrow(/source adapter input tree/);
  });
  it("rejects an extra empty directory after materialization", async () => {
    const root = await mkdtemp(join(tmpdir(), "source-adapter-inputs-"));
    roots.push(root);
    const inputs = await materializeSourceAdapterInputs({
      root,
      files: [{ path: "request/data.txt", bytes: Buffer.from("sealed") }],
      maxFiles: 1,
      maxBytes: 6,
    });
    await chmod(inputs.directory, 0o700);
    await mkdir(join(inputs.directory, "extra"), { mode: 0o500 });
    await chmod(inputs.directory, 0o500);
    await expect(inputs.verify()).rejects.toThrow(/unexpected directory/);
  });
  it("removes the private input root only after confirmed ownership cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "source-adapter-inputs-"));
    roots.push(root);
    const inputs = await materializeSourceAdapterInputs({
      root,
      files: [{ path: "request/data.txt", bytes: Buffer.from("sealed") }],
      maxFiles: 1,
      maxBytes: 6,
    });
    await inputs.dispose();
    roots.splice(roots.indexOf(root), 1);
    await expect(readFile(join(inputs.directory, "request/data.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it.each([
    ["../escape"],
    [".git/config"],
    ["same"],
  ] as const)("rejects unsafe or duplicate %s", async (path) => {
    const root = await mkdtemp(join(tmpdir(), "source-adapter-inputs-"));
    roots.push(root);
    const files =
      path === "same"
        ? [
            { path, bytes: Buffer.from("a") },
            { path, bytes: Buffer.from("b") },
          ]
        : [{ path, bytes: Buffer.from("a") }];
    await expect(
      materializeSourceAdapterInputs({ root, files, maxFiles: 2, maxBytes: 4 }),
    ).rejects.toThrow();
  });
});
