import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import type { Role } from "../../src/core/types.js";
import { createDelegateTool } from "../../src/host/delegation/delegate-tool-factory.js";
import { DelegationManager } from "../../src/host/delegation/manager.js";
import { buildChildTools, CHILD_FILE_TOOL_NAMES } from "../../src/host/delegation/run-tool.js";
import { verifyWorktree } from "../../src/host/delegation/worktree.js";
import { makeStubModel } from "../../src/host/stub-provider.js";
import type { DelegationPolicy, RoleConfig, SubagentProfile } from "../../src/manifest/types.js";
import { InMemoryRecordLog } from "../../src/persistence/log.js";

import { makeModelRegistryWithStub } from "./production-host-fixture.js";

const execFileAsync = promisify(execFile);
const runId = "issue-55-run";
const parentRole = "parent" as Role;
const delegationPolicy: DelegationPolicy = {
  allowed_subagents: ["focused"],
  max_children_per_session: 1,
  max_parallel: 1,
};
const role: RoleConfig = {
  name: parentRole,
  max_visits: 1,
  tools: ["delegate"],
  delegation: delegationPolicy,
};

let repositories: string[] = [];

afterEach(async () => {
  await Promise.all(
    repositories.map((repository) => rm(repository, { recursive: true, force: true })),
  );
  repositories = [];
});

function profile(workspace?: SubagentProfile["workspace"]): SubagentProfile {
  return {
    name: "focused",
    models: [{ model: "stub:stub-model", effort: "medium" }],
    max_session_cost_usd: 1,
    system_prompt: "child.md",
    ...(workspace === undefined ? {} : { workspace }),
  };
}

async function createRepository(wideFileCount = 0): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "pi-conductor-issue-55-"));
  repositories.push(repository);
  await execFileAsync("git", ["init"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "issue-55@example.test"], {
    cwd: repository,
  });
  await execFileAsync("git", ["config", "user.name", "Issue 55 Test"], { cwd: repository });
  await Promise.all([
    mkdir(join(repository, "selected"), { recursive: true }),
    mkdir(join(repository, "wide"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(repository, "selected", "a.txt"), "selected-a\n"),
    writeFile(join(repository, "selected", "b.txt"), "selected-b\n"),
    writeFile(join(repository, "allowed-only.txt"), "allowed-only\n"),
    writeFile(join(repository, "secret.txt"), "top-secret\n"),
    writeFile(join(repository, "child.md"), "Return the requested result."),
    writeFile(join(repository, ".gitignore"), ".pi-conductor/\n"),
    ...Array.from({ length: wideFileCount }, (_, index) =>
      writeFile(join(repository, "wide", `file-${index}.txt`), `wide-${index}\n`),
    ),
  ]);
  await execFileAsync("git", ["add", "."], { cwd: repository });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: repository });
  return repository;
}

function delegateTool(repository: string, childProfile: SubagentProfile, log: InMemoryRecordLog) {
  return createDelegateTool({
    role,
    subagents: [childProfile],
    remainingChildren: 1,
    runId,
    parentRole,
    parentVisitIndex: 1,
    primaryCheckout: repository,
    runStateDir: join(repository, ".pi-conductor", "runs", runId),
    persistRecord: (record) => log.append(record),
    agentDir: repository,
    systemPromptRoot: repository,
    modelRegistry: makeModelRegistryWithStub([
      {
        kind: "emit_tool_calls",
        calls: [
          {
            name: "report_result",
            arguments: { status: "no_changes", summary: "Checked the projection." },
          },
        ],
      },
    ]),
    sessionDir: join(repository, ".pi-conductor", "sessions"),
    manager: new DelegationManager(),
  });
}

function task(projectionPaths?: readonly string[]) {
  return {
    id: "focused-task",
    subagent: "focused",
    objective: "Inspect only the projected files.",
    expected_output: "Report the result.",
    ...(projectionPaths === undefined ? {} : { projection_paths: projectionPaths }),
  };
}

function startedRecord(log: InMemoryRecordLog) {
  const record = log.records(runId).find((entry) => entry.type === "subagent_started");
  if (record === undefined || record.type !== "subagent_started") {
    throw new Error("expected a subagent_started record");
  }
  return record;
}

async function materializedPaths(worktree: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", "-t", "-z"], { cwd: worktree });
  return stdout
    .split("\0")
    .filter((entry) => entry.startsWith("H "))
    .map((entry) => entry.slice(2))
    .sort();
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("Issue #55 delegated projection policy", () => {
  it("uses the real delegate batch gate to expand defaults into an exact sparse child projection", async () => {
    const repository = await createRepository();
    const log = new InMemoryRecordLog();
    const tool = delegateTool(
      repository,
      profile({
        projection: {
          required: false,
          allowed_paths: ["selected", "allowed-only.txt"],
          default_paths: ["selected"],
        },
      }),
      log,
    );

    const result = await tool.execute(
      "issue-55-default",
      { tasks: [task()] },
      undefined,
      undefined,
      {} as never,
    );
    const started = startedRecord(log);

    expect(result.content).toEqual([expect.objectContaining({ type: "text" })]);
    expect(started.projection_paths).toEqual(["selected/a.txt", "selected/b.txt"]);
    expect(await materializedPaths(started.worktree_path)).toEqual([
      "selected/a.txt",
      "selected/b.txt",
    ]);
    await expect(readFile(join(started.worktree_path, "secret.txt"), "utf8")).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );

    const { session } = await createAgentSession({
      cwd: started.worktree_path,
      model: makeStubModel(),
      sessionManager: SessionManager.inMemory(started.worktree_path),
      customTools: buildChildTools({ worktreePath: started.worktree_path }),
      tools: [...CHILD_FILE_TOOL_NAMES],
    });
    try {
      expect(session.getActiveToolNames()).toEqual(CHILD_FILE_TOOL_NAMES);
      const read = session.getToolDefinition("read");
      if (read === undefined) throw new Error("child read tool is missing");
      await expect(
        read.execute(
          "issue-55-read-outside-projection",
          { path: "secret.txt" },
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow();
    } finally {
      session.dispose();
    }
  });

  it("allows runtime narrowing of defaults but rejects a merely allowed file outside them", async () => {
    const repository = await createRepository();
    const log = new InMemoryRecordLog();
    const childProfile = profile({
      projection: {
        required: false,
        allowed_paths: ["selected", "allowed-only.txt"],
        default_paths: ["selected"],
      },
    });
    const accepted = delegateTool(repository, childProfile, log);

    await accepted.execute(
      "issue-55-narrow",
      { tasks: [task(["selected/a.txt"])] },
      undefined,
      undefined,
      {} as never,
    );

    expect(startedRecord(log).projection_paths).toEqual(["selected/a.txt"]);

    const rejected = delegateTool(repository, childProfile, log);
    const result = await rejected.execute(
      "issue-55-outside-default",
      { tasks: [task(["allowed-only.txt"])] },
      undefined,
      undefined,
      {} as never,
    );
    const validation = log
      .records(runId)
      .filter((entry) => entry.type === "delegation_validation_rejected");

    expect(result).toMatchObject({ isError: true });
    expect(validation).toContainEqual(
      expect.objectContaining({
        task_ids: ["focused-task"],
        errors: expect.arrayContaining([
          expect.objectContaining({ code: "projection-path-outside-defaults" }),
        ]),
      }),
    );
    expect(log.records(runId).filter((entry) => entry.type === "subagent_started")).toHaveLength(1);
  });

  it.each([
    [
      "required omission",
      profile({ projection: { required: true, allowed_paths: ["selected"] } }),
      task(),
      "projection-required",
    ],
    [
      "over-64 default expansion",
      profile({
        projection: { required: false, allowed_paths: ["wide"], default_paths: ["wide"] },
      }),
      task(),
      "default-projection-too-large",
    ],
    [
      "runtime request outside parent H",
      profile({ projection: { required: true, allowed_paths: ["selected"] } }),
      task(["not-materialized.txt"]),
      "projection-path-not-materialized",
    ],
    [
      "unsafe runtime request",
      profile({ projection: { required: true, allowed_paths: ["selected"] } }),
      task(["../secret.txt"]),
      "unsafe-projection-path",
    ],
    [
      "empty default expansion",
      profile({
        projection: { required: false, allowed_paths: ["empty"], default_paths: ["empty"] },
      }),
      task(),
      "default-projection-empty",
    ],
  ])("rejects %s before creating a worktree or child lifecycle", async (_name, childProfile, request, code) => {
    const repository = await createRepository(code === "default-projection-too-large" ? 65 : 0);
    const log = new InMemoryRecordLog();
    const tool = delegateTool(repository, childProfile, log);
    const worktreesPath = join(repository, ".pi-conductor", "runs", runId, "worktrees");

    const result = await tool.execute(
      "issue-55-rejected",
      { tasks: [request] },
      undefined,
      undefined,
      {} as never,
    );

    expect(result).toMatchObject({ isError: true });
    expect(log.records(runId).filter((entry) => entry.type === "subagent_started")).toEqual([]);
    expect(await exists(worktreesPath)).toBe(false);
    expect(log.records(runId)).toContainEqual(
      expect.objectContaining({
        type: "delegation_validation_rejected",
        errors: expect.arrayContaining([expect.objectContaining({ code })]),
      }),
    );
  });

  it("retains profile-less Issue #52 behavior and leaves reconciliation to the clean parent", async () => {
    const repository = await createRepository();
    const log = new InMemoryRecordLog();
    const tool = delegateTool(repository, profile(), log);

    await tool.execute("issue-55-legacy", { tasks: [task()] }, undefined, undefined, {} as never);
    const started = startedRecord(log);
    await writeFile(join(started.worktree_path, "selected", "a.txt"), "parent-reviewed change\n");
    const verified = await verifyWorktree(started.worktree_path, started.branch);
    const review = await execFileAsync("git", ["diff", "--", "selected/a.txt"], {
      cwd: started.worktree_path,
    });
    const parentStatus = await execFileAsync("git", ["status", "--porcelain=v1"], {
      cwd: repository,
    });

    expect(started.projection_paths).toBeUndefined();
    expect(await readFile(join(started.worktree_path, "secret.txt"), "utf8")).toContain(
      "top-secret",
    );
    expect(verified.isClean).toBe(false);
    expect(review.stdout).toContain("parent-reviewed change");
    expect(parentStatus.stdout).toBe("");
  });

  it("expands defaults from sparse parent H and rejects a skipped tracked file", async () => {
    const repository = await createRepository();
    await execFileAsync(
      "git",
      ["sparse-checkout", "set", "--no-cone", "--", "/.gitignore", "/child.md", "/selected/a.txt"],
      { cwd: repository },
    );
    const log = new InMemoryRecordLog();
    const childProfile = profile({
      projection: {
        required: false,
        allowed_paths: ["selected"],
        default_paths: ["selected"],
      },
    });

    expect(await materializedPaths(repository)).toEqual([
      ".gitignore",
      "child.md",
      "selected/a.txt",
    ]);

    await delegateTool(repository, childProfile, log).execute(
      "issue-55-sparse-default",
      { tasks: [task()] },
      undefined,
      undefined,
      {} as never,
    );
    const accepted = startedRecord(log);
    const worktreesPath = join(repository, ".pi-conductor", "runs", runId, "worktrees");
    const worktreesBeforeRejection = (await readdir(worktreesPath)).sort();
    const lifecycleBeforeRejection = log
      .records(runId)
      .filter(
        (record) =>
          record.type === "subagent_started" ||
          record.type === "subagent_completed" ||
          record.type === "subagent_failed",
      );

    expect(accepted.projection_paths).toEqual(["selected/a.txt"]);
    expect(await materializedPaths(accepted.worktree_path)).toEqual(["selected/a.txt"]);

    const rejected = await delegateTool(repository, childProfile, log).execute(
      "issue-55-sparse-explicit",
      { tasks: [task(["selected/b.txt"])] },
      undefined,
      undefined,
      {} as never,
    );

    expect(rejected).toMatchObject({ isError: true });
    expect(log.records(runId)).toContainEqual(
      expect.objectContaining({
        type: "delegation_validation_rejected",
        errors: expect.arrayContaining([
          expect.objectContaining({ code: "projection-path-not-materialized" }),
        ]),
      }),
    );
    expect(
      log
        .records(runId)
        .filter(
          (record) =>
            record.type === "subagent_started" ||
            record.type === "subagent_completed" ||
            record.type === "subagent_failed",
        ),
    ).toEqual(lifecycleBeforeRejection);
    expect((await readdir(worktreesPath)).sort()).toEqual(worktreesBeforeRejection);
  });
});
