import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTrustedProjectedWorktree,
  inspectTrustedProjectedWorktree,
} from "../../src/host/execution/sandbox/trusted-git.js";
import {
  captureTrustedParentProjection,
  readTrustedParentBlob,
} from "../../src/host/execution/sandbox/trusted-git-parent.js";

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("trusted projected Git worktree", () => {
  it("creates a generated branch containing only selected raw blobs", async () => {
    const fixture = await createFixture();
    const worktree = await createTrustedProjectedWorktree({
      hostWorktreePath: fixture.repository,
      generatedWorktreePath: join(fixture.root, "child"),
      generatedBranch: "conduct/run/child",
      baseCommit: fixture.commit,
      selectedPaths: ["bin/run.sh", "safe.txt"],
    });

    expect(await readFile(join(worktree.workTree, "safe.txt"), "utf8")).toBe("safe\n");
    expect(await readFile(join(worktree.workTree, "bin/run.sh"), "utf8")).toBe("#!/bin/sh\n");
    await expect(readFile(join(worktree.workTree, "hidden.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await inspectTrustedProjectedWorktree(worktree)).toEqual({
      branch: "conduct/run/child",
      headCommit: fixture.commit,
    });
  });

  it("never executes ambient hooks, filters, fsmonitor, external diff, or global config", async () => {
    const fixture = await createFixture();
    const sentinel = join(fixture.root, "executed");
    const script = join(fixture.root, "malicious.sh");
    const home = join(fixture.root, "home");
    await mkdir(home);
    await writeFile(script, `#!/bin/sh\nprintf x >> '${sentinel}'\ncat\n`, { mode: 0o755 });
    await writeFile(
      join(home, ".gitconfig"),
      `[core]\n\thooksPath = ${script}\n\tfsmonitor = ${script}\n[diff]\n\texternal = ${script}\n[filter "evil"]\n\tclean = ${script}\n\tsmudge = ${script}\n`,
    );
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", home);
    await writeFile(join(fixture.repository, ".gitattributes"), "safe.txt filter=evil diff=evil\n");
    await git(fixture.repository, ["config", "core.hooksPath", script]);
    await git(fixture.repository, ["config", "core.fsmonitor", script]);
    await git(fixture.repository, ["config", "diff.external", script]);
    await git(fixture.repository, ["config", "filter.evil.clean", script]);
    await git(fixture.repository, ["config", "filter.evil.smudge", script]);

    await createTrustedProjectedWorktree({
      hostWorktreePath: fixture.repository,
      generatedWorktreePath: join(fixture.root, "child"),
      generatedBranch: "conduct-safe",
      baseCommit: fixture.commit,
      selectedPaths: ["safe.txt"],
    });

    await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["symlink", "120000", "link"],
    ["submodule", "160000", "module"],
  ])("rejects a selected %s entry", async (_kind, mode, path) => {
    const fixture = await createFixture();
    if (mode === "120000") {
      await symlink("safe.txt", join(fixture.repository, path));
      await git(fixture.repository, ["add", path]);
    } else {
      await git(fixture.repository, [
        "update-index",
        "--add",
        "--cacheinfo",
        `${mode},${fixture.commit},${path}`,
      ]);
    }
    await git(fixture.repository, ["commit", "-qm", `add ${path}`]);
    await exec("/usr/bin/chmod", ["-R", "go-w", fixture.repository]);
    const commit = (await git(fixture.repository, ["rev-parse", "HEAD"])).trim();

    await expect(
      createTrustedProjectedWorktree({
        hostWorktreePath: fixture.repository,
        generatedWorktreePath: join(fixture.root, `child-${mode}`),
        generatedBranch: `reject-${mode}`,
        baseCommit: commit,
        selectedPaths: [path],
      }),
    ).rejects.toThrow("unsupported selected Git entry");
  });

  it("rejects unsafe and absent selected paths before materializing content", async () => {
    const fixture = await createFixture();
    for (const selectedPath of ["../escape", ".git/config", "missing.txt"]) {
      await expect(
        createTrustedProjectedWorktree({
          hostWorktreePath: fixture.repository,
          generatedWorktreePath: join(fixture.root, `child-${selectedPath.replaceAll("/", "-")}`),
          generatedBranch: `reject-${selectedPath.replaceAll(/[/.]/g, "-")}`,
          baseCommit: fixture.commit,
          selectedPaths: [selectedPath],
        }),
      ).rejects.toThrow();
    }
  });

  it("rejects replaced captured Git metadata before inspection", async () => {
    const fixture = await createFixture();
    const worktree = await createTrustedProjectedWorktree({
      hostWorktreePath: fixture.repository,
      generatedWorktreePath: join(fixture.root, "child"),
      generatedBranch: "identity-check",
      baseCommit: fixture.commit,
      selectedPaths: ["safe.txt"],
    });
    const replacement = join(fixture.root, "replacement-index");
    await writeFile(replacement, await readFile(worktree.index));
    await chmod(replacement, 0o600);
    await rename(replacement, worktree.index);

    await expect(inspectTrustedProjectedWorktree(worktree)).rejects.toThrow(
      "trusted Git identity changed: index",
    );
  });
});

describe("trusted parent projection capture", () => {
  it("captures sparse materialized H paths and the complete tracked T set", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.repository, "odd\nname.txt"), "odd\n");
    await git(fixture.repository, ["add", "odd\nname.txt"]);
    await git(fixture.repository, ["commit", "-qm", "add unusual tracked path"]);
    await git(fixture.repository, ["sparse-checkout", "init", "--no-cone"]);
    await git(fixture.repository, ["sparse-checkout", "set", "--no-cone", "/safe.txt"]);
    await exec("/usr/bin/chmod", ["-R", "go-w", fixture.repository]);

    const captured = await captureTrustedParentProjection(fixture.repository);

    expect(captured.paths).toEqual(["safe.txt"]);
    expect(captured.trackedPaths).toEqual([
      "bin/run.sh",
      "hidden.txt",
      "odd\nname.txt",
      "safe.txt",
    ]);
    expect(captured.isSparse).toBe(true);
  });

  it("rejects a materialized file reached through a replaced ancestor link", async () => {
    const fixture = await createFixture();
    const moved = join(fixture.root, "moved-bin");
    await rename(join(fixture.repository, "bin"), moved);
    await symlink(moved, join(fixture.repository, "bin"));

    await expect(captureTrustedParentProjection(fixture.repository)).rejects.toThrow();
  });

  it("reads raw immutable blobs only within the caller byte bound", async () => {
    const fixture = await createFixture();

    const complete = await readTrustedParentBlob(fixture.repository, fixture.commit, "safe.txt", 5);
    const oversized = await readTrustedParentBlob(
      fixture.repository,
      fixture.commit,
      "hidden.txt",
      2,
    );

    expect("bytes" in complete ? complete.bytes.toString("utf8") : null).toBe("safe\n");
    expect(oversized).toEqual({ oversizedByteLength: 7 });
  });

  it("accepts raw-matching files without executing declared filters or ambient Git programs", async () => {
    const fixture = await createFixture();
    const sentinel = join(fixture.root, "parent-executed");
    const script = join(fixture.root, "parent-malicious.sh");
    const home = join(fixture.root, "parent-home");
    await mkdir(home);
    await writeFile(script, `#!/bin/sh\nprintf x >> '${sentinel}'\ncat\n`, { mode: 0o755 });
    await writeFile(
      join(home, ".gitconfig"),
      `[core]\n\tfsmonitor = ${script}\n[diff]\n\texternal = ${script}\n`,
    );
    await writeFile(join(fixture.repository, ".gitattributes"), "safe.txt filter=evil\n");
    await git(fixture.repository, ["add", ".gitattributes"]);
    await git(fixture.repository, ["commit", "-qm", "declare filter attribute"]);
    await git(fixture.repository, ["config", "filter.evil.clean", script]);
    await git(fixture.repository, ["config", "filter.evil.smudge", script]);
    await git(fixture.repository, ["config", "core.fsmonitor", script]);
    await exec("/usr/bin/chmod", ["-R", "go-w", fixture.repository]);
    vi.stubEnv("HOME", home);
    vi.stubEnv("GIT_EXTERNAL_DIFF", script);

    const captured = await captureTrustedParentProjection(fixture.repository);

    expect(captured.paths).toContain("safe.txt");
    await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createFixture(): Promise<{ root: string; repository: string; commit: string }> {
  const root = await mkdtemp(join(tmpdir(), "conductor-trusted-git-"));
  roots.push(root);
  const repository = join(root, "repository");
  await mkdir(join(repository, "bin"), { recursive: true });
  await git(repository, ["init", "-q"]);
  await git(repository, ["config", "user.name", "Test"]);
  await git(repository, ["config", "user.email", "test@example.invalid"]);
  await writeFile(join(repository, "safe.txt"), "safe\n");
  await writeFile(join(repository, "hidden.txt"), "hidden\n");
  await writeFile(join(repository, "bin/run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  await chmod(join(repository, "bin/run.sh"), 0o755);
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-qm", "fixture"]);
  await exec("/usr/bin/chmod", ["-R", "go-w", repository]);
  return { root, repository, commit: (await git(repository, ["rev-parse", "HEAD"])).trim() };
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await exec("/usr/bin/git", [...args], { cwd });
  return result.stdout;
}
