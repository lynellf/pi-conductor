import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { withSandboxDirectory } from "../../src/host/execution/sandbox/anchored-file-access.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sandbox-files-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/a"), "before");
  return root;
}

describe("descriptor-anchored sandbox file access", () => {
  it("reads and updates the same regular inode, creates parents, and removes a file", async () => {
    const root = await fixture();
    const before = await stat(join(root, "src/a"));
    await withSandboxDirectory(root, async (files) => {
      expect((await files.read("src/a", 100)).toString()).toBe("before");
      await files.write("src/a", Buffer.from("after"));
      await files.mkdir("src/new/nested");
      await files.write("src/new/nested/file", Buffer.from("new"));
      await files.remove("src/new/nested/file");
    });
    expect((await stat(join(root, "src/a"))).ino).toBe(before.ino);
    expect(await readFile(join(root, "src/a"), "utf8")).toBe("after");
  });

  it.each([
    "../outside",
    "/etc/passwd",
    "src/../outside",
    "src/.git/config",
    "src//a",
    "src/./a",
    "src/\\a",
    "src/\0a",
  ])("rejects unsafe path %j before access", async (path) => {
    const root = await fixture();
    await expect(withSandboxDirectory(root, (files) => files.read(path, 100))).rejects.toThrow(
      /path/,
    );
  });

  it.each([
    "symlink",
    "hardlink",
    "fifo",
    "ancestor",
  ])("never reads or changes a %s target", async (kind) => {
    const root = await fixture();
    const secret = join(root, "secret");
    await writeFile(secret, "sentinel");
    const target = join(root, "src/unsafe");
    if (kind === "symlink") await symlink(secret, target);
    if (kind === "hardlink") await link(secret, target);
    if (kind === "fifo") await promisify(execFile)("mkfifo", [target]);
    if (kind === "ancestor") await symlink(root, target);
    const path = kind === "ancestor" ? "src/unsafe/secret" : "src/unsafe";
    await withSandboxDirectory(root, async (files) => {
      await expect(files.read(path, 100)).rejects.toThrow();
      await expect(files.write(path, Buffer.from("changed"))).rejects.toThrow();
      await expect(files.remove(path)).rejects.toThrow();
    });
    expect(await readFile(secret, "utf8")).toBe("sentinel");
  });

  it("rejects an oversized file before reading its contents", async () => {
    const root = await fixture();
    await expect(withSandboxDirectory(root, (files) => files.read("src/a", 2))).rejects.toThrow(
      /bound/,
    );
  });

  it("fails after its root descriptor is closed", async () => {
    const root = await fixture();
    const files = await withSandboxDirectory(root, async (files) => files);
    await expect(files.read("src/a", 100)).rejects.toThrow(/closed/);
  });

  it("walks a complete tree with bounded entries and refuses unsafe output", async () => {
    const root = await fixture();
    await withSandboxDirectory(root, async (files) => {
      expect((await files.entries(10)).map((entry) => entry.path)).toEqual(["src", "src/a"]);
      await expect(files.entries(1)).rejects.toThrow(/bound/);
      await symlink("a", join(root, "src/link"));
      await expect(files.entries(10)).rejects.toThrow(/unsupported/);
    });
  });
});
