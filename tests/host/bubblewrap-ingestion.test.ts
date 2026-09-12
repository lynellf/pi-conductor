import { execFile } from "node:child_process";
import { link, lstat, mkdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxOperationGate } from "../../src/host/execution/sandbox/operation-gate.js";
import { ingestSandboxProject } from "../../src/host/execution/sandbox/project-ingestion.js";
import {
  cleanupSandboxProjectFixture,
  createSandboxProjectFixture,
  materializeFixture,
} from "./fixtures/sandbox-project-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await cleanupSandboxProjectFixture(root);
});
async function fixture() {
  const value = await createSandboxProjectFixture({ writablePaths: ["src"] });
  roots.push(value.root);
  await rm(join(value.worktree, "src/hidden.ts"));
  const project = await materializeFixture(value);
  const gate = new SandboxOperationGate({ runId: "run-1", childId: "child-1" });
  const options = {
    gate,
    admission: value.admission,
    project,
    runStateDir: value.runStateDir,
    signal: new AbortController().signal,
    verifyWorktree: vi.fn(async () => {}),
  };
  return { ...value, project, options };
}

describe("validated sandbox patch ingestion", () => {
  it("stages regular modifications, new files, and deletions before applying once", async () => {
    const value = await fixture();
    await rm(join(value.project.writablePath, "src/a.ts"));
    await writeFile(join(value.project.writablePath, "src/new.ts"), "new\n");
    const result = await ingestSandboxProject(value.options);
    expect(result.entries).toEqual([
      { path: "src/a.ts", operation: "delete" },
      expect.objectContaining({ path: "src/new.ts", operation: "write", size: 4 }),
    ]);
    expect(await readFile(join(value.worktree, "src/new.ts"), "utf8")).toBe("new\n");
    await expect(lstat(join(value.worktree, "src/a.ts"))).rejects.toThrow();
    expect(await readFile(join(value.worktree, "package.json"), "utf8")).toBe("{}\n");
    expect(value.options.verifyWorktree).toHaveBeenCalledOnce();
    await expect(ingestSandboxProject(value.options)).rejects.toMatchObject({
      integration: "completed",
    });
  });

  it.each([
    "symlink",
    "hardlink",
    "fifo",
    "reserved",
    "outside",
  ])("applies no delta when output includes %s", async (kind) => {
    const value = await fixture();
    await writeFile(join(value.project.writablePath, "src/a.ts"), "changed\n");
    const target = join(value.project.writablePath, "src/unsafe");
    if (kind === "symlink") await symlink("a.ts", target);
    if (kind === "hardlink") await link(join(value.project.writablePath, "src/a.ts"), target);
    if (kind === "fifo") await promisify(execFile)("mkfifo", [target]);
    if (kind === "reserved") await mkdir(join(value.project.writablePath, "src/.git"));
    if (kind === "outside")
      await writeFile(join(value.project.writablePath, "outside"), "not authorized");
    await expect(ingestSandboxProject(value.options)).rejects.toMatchObject({
      integration: "not-started",
    });
    expect(await readFile(join(value.worktree, "src/a.ts"), "utf8")).toBe("a\n");
    expect(value.options.verifyWorktree).not.toHaveBeenCalled();
    await expect(value.options.gate.waitForIdle()).resolves.toBeUndefined();
  });

  it("rejects a changed generated worktree without applying staged bytes", async () => {
    const value = await fixture();
    await writeFile(join(value.project.writablePath, "src/a.ts"), "child\n");
    await writeFile(join(value.worktree, "src/a.ts"), "host changed\n");
    await expect(ingestSandboxProject(value.options)).rejects.toMatchObject({
      integration: "not-started",
    });
    expect(await readFile(join(value.worktree, "src/a.ts"), "utf8")).toBe("host changed\n");
  });

  it("durably reports partial application, retains staging and seals the gate", async () => {
    const value = await fixture();
    await writeFile(join(value.project.writablePath, "src/a.ts"), "child\n");
    await writeFile(join(value.project.writablePath, "src/new.ts"), "new\n");
    await expect(
      ingestSandboxProject({
        ...value.options,
        beforeApplyEntry: async (index) => {
          if (index === 1) throw new Error("injected interruption");
        },
      }),
    ).rejects.toMatchObject({ integration: "integration_incomplete" });
    const marker = JSON.parse(
      await readFile(join(value.project.projectPath, "integration-incomplete.json"), "utf8"),
    ) as { stage: string; outcome: string };
    expect(marker.outcome).toBe("integration_incomplete");
    expect(
      await readFile(join(value.project.projectPath, marker.stage, "files/src/new.ts"), "utf8"),
    ).toBe("new\n");
    expect(await readFile(join(value.worktree, "src/a.ts"), "utf8")).toBe("child\n");
    await expect(value.options.gate.waitForIdle()).rejects.toMatchObject({
      integration: "integration_incomplete",
    });
    const freshGate = new SandboxOperationGate({ runId: "run-1", childId: "child-1" });
    await expect(ingestSandboxProject({ ...value.options, gate: freshGate })).rejects.toThrow(
      /sealed/,
    );
  });

  it("does not overwrite unexpected untracked worktree files", async () => {
    const value = await fixture();
    await writeFile(join(value.project.writablePath, "src/new.ts"), "child");
    await writeFile(join(value.worktree, "src/new.ts"), "host");
    await expect(ingestSandboxProject(value.options)).rejects.toMatchObject({
      integration: "not-started",
    });
    expect(await readFile(join(value.worktree, "src/new.ts"), "utf8")).toBe("host");
  });

  it("validates all staged bytes before the first host mutation", async () => {
    const value = await fixture();
    await writeFile(join(value.project.writablePath, "src/a.ts"), "changed");
    await writeFile(join(value.project.writablePath, "src/z.ts"), "last");
    const { readdir } = await import("node:fs/promises");
    const verifyWorktree = async () => {
      const stage = (await readdir(value.project.projectPath)).find((name) =>
        name.startsWith("patch-"),
      );
      if (stage === undefined) throw new Error("missing stage");
      await writeFile(join(value.project.projectPath, stage, "files/src/z.ts"), "tampered");
    };
    await expect(ingestSandboxProject({ ...value.options, verifyWorktree })).rejects.toMatchObject({
      integration: "not-started",
    });
    expect(await readFile(join(value.worktree, "src/a.ts"), "utf8")).toBe("a\n");
  });

  it("handles a file-to-directory change within authority", async () => {
    const value = await fixture();
    await rm(join(value.project.writablePath, "src/a.ts"));
    await mkdir(join(value.project.writablePath, "src/a.ts"));
    await writeFile(join(value.project.writablePath, "src/a.ts/nested"), "nested");
    await ingestSandboxProject(value.options);
    expect(await readFile(join(value.worktree, "src/a.ts/nested"), "utf8")).toBe("nested");
  });

  it("rejects 10001 captured entries before mutation", async () => {
    const value = await fixture();
    for (let index = 0; index < 9999; index++)
      await mkdir(join(value.project.writablePath, "src", `dir-${index}`));
    await expect(ingestSandboxProject(value.options)).rejects.toMatchObject({
      integration: "not-started",
    });
    expect(value.options.verifyWorktree).not.toHaveBeenCalled();
  });

  it("rejects a delta larger than 256 MiB before host mutation", async () => {
    const value = await fixture();
    const path = join(value.project.writablePath, "src/large");
    await writeFile(path, "");
    await truncate(path, 256 * 1024 * 1024 + 1);
    await expect(ingestSandboxProject(value.options)).rejects.toMatchObject({
      integration: "not-started",
    });
    await expect(lstat(join(value.worktree, "src/large"))).rejects.toThrow();
  });
});
