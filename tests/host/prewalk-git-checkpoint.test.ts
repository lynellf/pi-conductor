import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
import {
  createPrewalkGitCheckpoint,
  inspectPrewalkGitBase,
  PrewalkGitCheckpointError,
} from "../../src/host/prewalk-git-checkpoint.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function repository(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-conductor-prewalk-git-"));
  roots.push(cwd);
  await git(cwd, ["init", "--quiet"]);
  await writeFile(join(cwd, "tracked.txt"), "base\n", "utf8");
  await git(cwd, ["add", "tracked.txt"]);
  await git(cwd, [
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "base",
  ]);
  return cwd;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Prewalk git checkpoint", () => {
  it("records an exact clean base without mutating HEAD, index, worktree, or git config", async () => {
    const cwd = await repository();
    const head = await git(cwd, ["rev-parse", "HEAD"]);
    const configBefore = await readFile(join(cwd, ".git", "config"), "utf8");

    const base = await inspectPrewalkGitBase({ cwd });

    expect(base).toEqual({ base_sha: head, clean: true });
    expect(await git(cwd, ["rev-parse", "HEAD"])).toBe(head);
    expect(await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");
    expect(await readFile(join(cwd, ".git", "config"), "utf8")).toBe(configBefore);
  });

  it("creates a deterministic recoverable exemplar commit while preserving the dirty exemplar", async () => {
    const cwd = await repository();
    const base = await inspectPrewalkGitBase({ cwd });
    await writeFile(join(cwd, "tracked.txt"), "guide exemplar\n", "utf8");
    await writeFile(join(cwd, "new.txt"), "new guide file\n", "utf8");
    const diffBefore = await git(cwd, ["diff", "--", "."]);
    const statusBefore = await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const configBefore = await readFile(join(cwd, ".git", "config"), "utf8");

    const first = await createPrewalkGitCheckpoint({ cwd, base, roleSessionId: "role/session 1" });
    const second = await createPrewalkGitCheckpoint({ cwd, base, roleSessionId: "role/session 1" });

    expect(first).toEqual(second);
    expect(first.base_sha).toBe(base.base_sha);
    expect(await git(cwd, ["rev-parse", "HEAD"])).toBe(base.base_sha);
    expect(await git(cwd, ["show", `${first.exemplar_sha}:tracked.txt`])).toBe("guide exemplar");
    expect(await git(cwd, ["show", `${first.exemplar_sha}:new.txt`])).toBe("new guide file");
    expect(await git(cwd, ["diff", "--", "."])).toBe(diffBefore);
    expect(await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(
      statusBefore,
    );
    expect(await readFile(join(cwd, ".git", "config"), "utf8")).toBe(configBefore);
    expect(await git(cwd, ["rev-parse", "refs/pi-conductor/prewalk/role-session-1"])).toBe(
      first.exemplar_sha,
    );
  });

  it("fails closed when the recorded base was dirty or HEAD moved", async () => {
    const cwd = await repository();
    await writeFile(join(cwd, "tracked.txt"), "already dirty\n", "utf8");
    const dirtyBase = await inspectPrewalkGitBase({ cwd });

    await expect(
      createPrewalkGitCheckpoint({ cwd, base: dirtyBase, roleSessionId: "session" }),
    ).rejects.toMatchObject({ code: "prewalk_git_checkpoint_failed" });

    await git(cwd, ["checkout", "--", "tracked.txt"]);
    const cleanBase = await inspectPrewalkGitBase({ cwd });
    await writeFile(join(cwd, "later.txt"), "later\n", "utf8");
    await git(cwd, ["add", "later.txt"]);
    await git(cwd, [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "move head",
    ]);

    await expect(
      createPrewalkGitCheckpoint({ cwd, base: cleanBase, roleSessionId: "session" }),
    ).rejects.toBeInstanceOf(PrewalkGitCheckpointError);
    expect(await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");
  });

  it("preserves the dirty exemplar when an injected git operation fails", async () => {
    const cwd = await repository();
    const base = await inspectPrewalkGitBase({ cwd });
    await writeFile(join(cwd, "tracked.txt"), "keep me dirty\n", "utf8");
    const before = await git(cwd, ["diff", "--", "."]);

    await expect(
      createPrewalkGitCheckpoint({
        cwd,
        base,
        roleSessionId: "session",
        runGit: async (request) => {
          if (request.args[0] === "write-tree") throw new Error("injected write-tree failure");
          const { stdout } = await execFile("git", request.args, {
            cwd: request.cwd,
            env: request.env,
            encoding: "utf8",
          });
          return stdout;
        },
      }),
    ).rejects.toMatchObject({ code: "prewalk_git_checkpoint_failed" });

    expect(await git(cwd, ["diff", "--", "."])).toBe(before);
    expect(await git(cwd, ["rev-parse", "HEAD"])).toBe(base.base_sha);
  });
});
