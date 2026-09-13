import { chmod, lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeProtectedRunLayout } from "../../src/host/execution/sandbox/protected-run-layout.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("protected sandbox run layout", () => {
  it("creates and revalidates fixed private workspace roots", async () => {
    const runStateDir = await fixture();

    await initializeProtectedRunLayout(runStateDir);
    await initializeProtectedRunLayout(runStateDir);

    await expectMode(join(runStateDir, "worktrees"), 0o700);
    await expectMode(join(runStateDir, "sandbox"), 0o700);
  });

  it("creates fixed roots safely when initialization races", async () => {
    const runStateDir = await fixture();

    await Promise.all([
      initializeProtectedRunLayout(runStateDir),
      initializeProtectedRunLayout(runStateDir),
    ]);

    await expectMode(join(runStateDir, "worktrees"), 0o700);
    await expectMode(join(runStateDir, "sandbox"), 0o700);
  });

  it("accepts an owner-protected workspace root created by file-only delegation", async () => {
    const runStateDir = await fixture();
    await mkdir(join(runStateDir, "worktrees"), { mode: 0o755 });
    await chmod(join(runStateDir, "worktrees"), 0o755);

    await initializeProtectedRunLayout(runStateDir);

    await expectMode(join(runStateDir, "worktrees"), 0o755);
    await expectMode(join(runStateDir, "sandbox"), 0o700);
  });

  it("rejects replacement of the logical run directory during setup", async () => {
    const runStateDir = await fixture();
    const replacement = `${runStateDir}-replacement`;

    await expect(
      initializeProtectedRunLayout(runStateDir, {
        beforeFinalValidation: async () => {
          await rename(runStateDir, replacement);
          await mkdir(runStateDir, { mode: 0o700 });
          await chmod(runStateDir, 0o700);
        },
      }),
    ).rejects.toThrow("changed during setup");
  });

  it("rejects replacement of a protected root during setup", async () => {
    const runStateDir = await fixture();
    const worktrees = join(runStateDir, "worktrees");

    await expect(
      initializeProtectedRunLayout(runStateDir, {
        beforeFinalValidation: async () => {
          await rename(worktrees, `${worktrees}-replacement`);
          await mkdir(worktrees, { mode: 0o700 });
          await chmod(worktrees, 0o700);
        },
      }),
    ).rejects.toThrow("changed during setup");
  });

  it("accepts a sibling child created below a retained protected root", async () => {
    const runStateDir = await fixture();
    const child = join(runStateDir, "worktrees", "child-1");

    await initializeProtectedRunLayout(runStateDir, {
      beforeFinalValidation: async () => {
        await mkdir(child, { mode: 0o700 });
      },
    });

    await expectMode(child, 0o700);
  });

  it.each([
    ["symlink", async (path: string) => symlink("/tmp", path)],
    ["regular file", async (path: string) => writeFile(path, "unexpected")],
    [
      "group-writable directory",
      async (path: string) => {
        await mkdir(path, { mode: 0o700 });
        await chmod(path, 0o770);
      },
    ],
  ])("rejects a pre-existing unsafe %s root without repairing it", async (_kind, prepare) => {
    const runStateDir = await fixture();
    const root = join(runStateDir, "worktrees");
    await prepare(root);

    await expect(initializeProtectedRunLayout(runStateDir)).rejects.toThrow("root-invalid");

    const observed = await lstat(root);
    expect(
      observed.isSymbolicLink() || !observed.isDirectory() || (observed.mode & 0o022) !== 0,
    ).toBe(true);
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "conductor-protected-run-"));
  roots.push(root);
  await chmod(root, 0o700);
  const runStateDir = join(root, "run");
  await mkdir(runStateDir, { mode: 0o700 });
  await chmod(runStateDir, 0o700);
  return runStateDir;
}

async function expectMode(path: string, mode: number): Promise<void> {
  const observed = await lstat(path);
  expect(observed.isDirectory()).toBe(true);
  expect(observed.mode & 0o777).toBe(mode);
}
