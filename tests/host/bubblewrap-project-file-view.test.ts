import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  validateWritableProjectTree,
  withSandboxProjectFileView,
} from "../../src/host/execution/sandbox/project-file-view.js";

let root: string | undefined;
const execute = promisify(execFile);

afterEach(async () => {
  if (root !== undefined)
    await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
  root = undefined;
});

async function project() {
  root = await mkdtemp(join(tmpdir(), "pi-conductor-file-view-"));
  const base = join(root, "base");
  const writable = join(root, "writable");
  await Promise.all([
    mkdir(join(base, "src"), { recursive: true }),
    mkdir(join(writable, "src"), { recursive: true }),
  ]);
  await writeFile(join(base, "read-only.txt"), "base only");
  await writeFile(join(base, "src", "code.ts"), "base code");
  await writeFile(join(writable, "src", "code.ts"), "private code");
  return { base, writable };
}

describe("sandbox project file view", () => {
  it("merges writable copies over the immutable base and permits new authorized files", async () => {
    const { base, writable } = await project();
    await withSandboxProjectFileView(
      base,
      writable,
      [{ path: "src", kind: "directory" }],
      async (view) => {
        expect((await view.read("src/code.ts", 1024)).toString()).toBe("private code");
        expect((await view.read("read-only.txt", 1024)).toString()).toBe("base only");
        await view.write("src/nested/new.ts", Buffer.from("new"));
        await expect(view.write("read-only.txt", Buffer.from("bad"))).rejects.toThrow("read-only");
        expect((await view.read("src/nested/new.ts", 1024)).toString()).toBe("new");
      },
    );
  });

  it("rejects a symlink in the complete writable tree before base access", async () => {
    const { writable } = await project();
    await symlink("/etc/passwd", join(writable, "src", "escape"));
    await expect(
      validateWritableProjectTree(writable, [{ path: "src", kind: "directory" }]),
    ).rejects.toThrow("unsupported");
  });

  it("rejects a hardlinked writable file before base access", async () => {
    const { writable } = await project();
    await link(join(writable, "src", "code.ts"), join(writable, "src", "second.ts"));
    await expect(
      validateWritableProjectTree(writable, [{ path: "src", kind: "directory" }]),
    ).rejects.toThrow("singly linked");
  });

  it("rejects a FIFO created by a completed sandbox command", async () => {
    const { writable } = await project();
    await execute("mkfifo", [join(writable, "src", "command-output")]);
    await expect(
      validateWritableProjectTree(writable, [{ path: "src", kind: "directory" }]),
    ).rejects.toThrow("unsupported");
  });

  it("rejects a writable file outside the pinned authority", async () => {
    const { writable } = await project();
    await writeFile(join(writable, "unapproved.txt"), "bad");
    await expect(
      validateWritableProjectTree(writable, [{ path: "src", kind: "directory" }]),
    ).rejects.toThrow("outside writable authority");
  });

  it("does not reveal a base file deleted from the writable overlay", async () => {
    const { base, writable } = await project();
    await rm(join(writable, "src", "code.ts"));
    await withSandboxProjectFileView(
      base,
      writable,
      [{ path: "src", kind: "directory" }],
      async (view) => {
        await expect(view.read("src/code.ts", 1024)).rejects.toThrow();
        expect((await view.files()).map((file) => file.path)).not.toContain("src/code.ts");
      },
    );
  });
});
