import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { Role } from "../../src/core/types.js";
import {
  type ChildTerminal,
  executeDelegate,
  type SpawnChildConfig,
} from "../../src/host/delegation/delegate-tool.js";
import { createDelegateTool } from "../../src/host/delegation/delegate-tool-factory.js";
import { DelegationManager } from "../../src/host/delegation/manager.js";
import type { DelegationPolicy, RoleConfig, SubagentProfile } from "../../src/manifest/types.js";
import { InMemoryRecordLog } from "../../src/persistence/log.js";
import type { ContextArtifact } from "../../src/seam/schema.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";

const execFileAsync = promisify(execFile);
const repositories: string[] = [];

const policy: DelegationPolicy = {
  allowed_subagents: ["focused"],
  max_children_per_session: 2,
  max_parallel: 2,
};

const profile: SubagentProfile = {
  name: "focused",
  models: [{ model: "stub:stub-model", effort: "medium" }],
  max_session_cost_usd: 1,
  system_prompt: "child.md",
  completion_protocol: "report_result",
};

afterEach(async () => {
  await Promise.all(repositories.map((path) => rm(path, { recursive: true, force: true })));
  repositories.length = 0;
});

async function repository(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-conductor-context-delegate-"));
  repositories.push(path);
  await execFileAsync("git", ["init"], { cwd: path });
  await execFileAsync("git", ["config", "user.email", "issue-60@example.test"], { cwd: path });
  await execFileAsync("git", ["config", "user.name", "Issue 60 Test"], { cwd: path });
  await mkdir(join(path, "src"));
  await Promise.all([
    writeFile(join(path, "src", "owned.ts"), "export const owned = true;\n"),
    writeFile(join(path, "contract.md"), "Pinned contract.\n"),
    writeFile(join(path, "child.md"), "Profile instructions."),
    writeFile(join(path, ".gitignore"), ".pi-conductor/\n"),
  ]);
  await execFileAsync("git", ["add", "."], { cwd: path });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: path });
  return path;
}

function task(id: string, contextArtifacts?: ContextArtifact[]) {
  return {
    id,
    subagent: "focused",
    objective: "Inspect the supplied contract.",
    expected_output: "Report without changes.",
    projection_paths: ["src/owned.ts"],
    ...(contextArtifacts === undefined ? {} : { context_artifacts: contextArtifacts }),
  };
}

function terminal(): ChildTerminal {
  return {
    started: true,
    model: "stub:model",
    report: { status: "no_changes", summary: "Inspected." },
    sessionFile: "child.jsonl",
    usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 },
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function delegateTool(primaryCheckout: string, runId: string, log: InMemoryRecordLog) {
  const role: RoleConfig = {
    name: "parent" as Role,
    max_visits: 1,
    tools: ["delegate"],
    delegation: policy,
  };
  return createDelegateTool({
    role,
    subagents: [profile],
    remainingChildren: 2,
    runId,
    parentRole: role.name,
    parentVisitIndex: 1,
    primaryCheckout,
    runStateDir: join(primaryCheckout, ".pi-conductor", "runs", runId),
    persistRecord: (record) => log.append(record),
    agentDir: primaryCheckout,
    systemPromptRoot: primaryCheckout,
    modelRegistry: makeModelRegistryWithStub([
      {
        kind: "emit_tool_calls",
        calls: [
          {
            name: "report_result",
            arguments: { status: "no_changes", summary: "Inspected." },
          },
        ],
      },
    ]),
    sessionDir: join(primaryCheckout, ".pi-conductor", "sessions"),
    manager: new DelegationManager(),
  });
}

describe("Issue #60 delegate preflight and prompt wiring", () => {
  it("rejects a mixed batch atomically before worktree directories or child sessions", async () => {
    const primaryCheckout = await repository();
    const runStateDir = join(primaryCheckout, ".pi-conductor", "runs", "atomic");
    let spawnCount = 0;

    await expect(
      executeDelegate({
        args: {
          tasks: [
            task("valid", [{ id: "inline", source: "inline", text: "Contract." }]),
            task("invalid", [{ id: "missing", source: "file", path: "missing.md" }]),
          ],
        },
        policy,
        profiles: [profile],
        remainingChildren: 2,
        runStateDir,
        runId: "atomic",
        parentRole: "parent",
        primaryCheckout,
        systemPromptRoot: primaryCheckout,
        spawnAndRunChild: async () => {
          spawnCount += 1;
          return terminal();
        },
      }),
    ).rejects.toMatchObject({
      code: "batch_validation_failed",
      errors: [
        expect.objectContaining({
          code: "context-artifact-not-materialized",
          task_id: "invalid",
          artifact_id: "missing",
          path: "missing.md",
        }),
      ],
    });

    expect(spawnCount).toBe(0);
    expect(await exists(join(runStateDir, "worktrees"))).toBe(false);
    expect(await exists(join(runStateDir, "sessions"))).toBe(false);
  });

  it.each([
    "invalid",
    "missing",
    "unreadable",
    "changed",
    "oversized",
  ] as const)("keeps the whole batch side-effect free for a %s artifact failure", async (failure) => {
    const primaryCheckout = await repository();
    const runStateDir = join(primaryCheckout, ".pi-conductor", "runs", `atomic-${failure}`);
    let spawnCount = 0;
    const descriptor: ContextArtifact =
      failure === "invalid"
        ? { id: "source", source: "inline", text: "\uD800" }
        : { id: "source", source: "file", path: "contract.md" };
    const limits =
      failure === "oversized"
        ? { max_items: 8, max_item_utf8_bytes: 4, max_total_utf8_bytes: 4 }
        : undefined;
    let hookCalled = false;

    const expectedCode = {
      invalid: "context-artifact-invalid-inline-text",
      missing: "context-artifact-missing",
      unreadable: "context-artifact-unreadable",
      changed: "context-artifact-changed",
      oversized: "context-artifact-oversized",
    }[failure];
    await expect(
      executeDelegate({
        args: {
          tasks: [
            task("first", [{ id: "sibling", source: "inline", text: "valid" }]),
            task("failing", [descriptor]),
          ],
        },
        policy: {
          ...policy,
          ...(limits === undefined ? {} : { context_artifact_limits: limits }),
        },
        profiles: [profile],
        remainingChildren: 2,
        runStateDir,
        runId: `atomic-${failure}`,
        parentRole: "parent",
        primaryCheckout,
        systemPromptRoot: primaryCheckout,
        contextArtifactTestHook: async (stage) => {
          if (hookCalled) return;
          if (failure === "missing" && stage === "after-source-lstat") {
            hookCalled = true;
            await unlink(join(primaryCheckout, "contract.md"));
          } else if (failure === "unreadable" && stage === "after-source-lstat") {
            hookCalled = true;
            await chmod(join(primaryCheckout, "contract.md"), 0);
          } else if (failure === "changed" && stage === "before-final-check") {
            hookCalled = true;
            await writeFile(join(primaryCheckout, "contract.md"), "changed\n");
          }
        },
        spawnAndRunChild: async () => {
          spawnCount += 1;
          return terminal();
        },
      }),
    ).rejects.toMatchObject({
      code: "batch_validation_failed",
      errors: expect.arrayContaining([expect.objectContaining({ code: expectedCode })]),
    });

    expect(spawnCount).toBe(0);
    expect(await exists(join(runStateDir, "worktrees"))).toBe(false);
    expect(await exists(join(runStateDir, "sessions"))).toBe(false);
  });

  it("passes frozen inline and pinned-file snapshots into the actual child prompt only", async () => {
    const primaryCheckout = await repository();
    const runStateDir = join(primaryCheckout, ".pi-conductor", "runs", "accepted");
    let spawned: SpawnChildConfig | undefined;

    await executeDelegate({
      args: {
        tasks: [
          task("accepted", [
            { id: "inline", source: "inline", text: "Inline contract." },
            { id: "file", source: "file", path: "contract.md" },
          ]),
        ],
      },
      policy,
      profiles: [profile],
      remainingChildren: 2,
      runStateDir,
      runId: "accepted",
      parentRole: "parent",
      primaryCheckout,
      systemPromptRoot: primaryCheckout,
      spawnAndRunChild: async (config) => {
        spawned = config;
        await writeFile(join(primaryCheckout, "contract.md"), "Later mutation.\n");
        return terminal();
      },
    });

    if (spawned === undefined) throw new Error("expected child spawn");
    expect(spawned.contextArtifacts.map((artifact) => artifact.text)).toEqual([
      "Inline contract.",
      "Pinned contract.\n",
    ]);
    expect(Object.isFrozen(spawned.contextArtifacts)).toBe(true);
    expect(spawned.systemPrompt).toContain("HOST-SUPPLIED READ-ONLY CONTEXT ARTIFACTS");
    expect(spawned.systemPrompt).toContain('"kind":"parent_materialized_file"');
    expect(spawned.systemPrompt).toContain('"text":"Pinned contract.\\n"');
    expect(spawned.systemPrompt).not.toContain("Later mutation.");
    expect(spawned.systemPrompt).not.toContain("Visible files:\ncontract.md");
    await expect(readFile(join(spawned.worktreePath, "contract.md"), "utf8")).rejects.toMatchObject(
      { code: "ENOENT" },
    );
    expect(await readFile(join(spawned.worktreePath, "src", "owned.ts"), "utf8")).toContain(
      "owned",
    );
  });

  it("retains ordinary file-tool authority when the artifact source is independently projected", async () => {
    const primaryCheckout = await repository();
    let spawned: SpawnChildConfig | undefined;

    await executeDelegate({
      args: {
        tasks: [
          {
            ...task("projected", [{ id: "file", source: "file", path: "contract.md" }]),
            projection_paths: ["contract.md"],
          },
        ],
      },
      policy,
      profiles: [profile],
      remainingChildren: 1,
      runStateDir: join(primaryCheckout, ".pi-conductor", "runs", "projected"),
      runId: "projected",
      parentRole: "parent",
      primaryCheckout,
      systemPromptRoot: primaryCheckout,
      spawnAndRunChild: async (config) => {
        spawned = config;
        return terminal();
      },
    });

    if (spawned === undefined) throw new Error("expected child spawn");
    expect(await readFile(join(spawned.worktreePath, "contract.md"), "utf8")).toBe(
      "Pinned contract.\n",
    );
    expect(spawned.contextArtifacts[0]?.text).toBe("Pinned contract.\n");
  });

  it("persists exact new empty/nonempty inventories without file-derived text", async () => {
    const withArtifacts = await repository();
    const artifactLog = new InMemoryRecordLog();
    await delegateTool(withArtifacts, "audit-artifacts", artifactLog).execute(
      "delegate",
      {
        tasks: [
          task("audited", [
            { id: "inline", source: "inline", text: "Inline contract." },
            { id: "file", source: "file", path: "contract.md" },
          ]),
        ],
      },
      undefined,
      undefined,
      {} as never,
    );
    const started = artifactLog
      .records("audit-artifacts")
      .find((record) => record.type === "subagent_started");
    if (started === undefined || started.type !== "subagent_started") {
      throw new Error("expected start record");
    }

    expect(started.context_artifacts).toMatchObject({
      version: 1,
      total_utf8_bytes: 33,
      artifacts: [
        { ordinal: 0, id: "inline", source: "inline", text: "Inline contract." },
        { ordinal: 1, id: "file", source: "file", provenance: { path: "contract.md" } },
      ],
    });
    expect(JSON.stringify(started.context_artifacts)).not.toContain("Pinned contract.");

    const withoutArtifacts = await repository();
    const emptyLog = new InMemoryRecordLog();
    await delegateTool(withoutArtifacts, "audit-empty", emptyLog).execute(
      "delegate",
      { tasks: [task("empty")] },
      undefined,
      undefined,
      {} as never,
    );
    const emptyStarted = emptyLog
      .records("audit-empty")
      .find((record) => record.type === "subagent_started");

    expect(emptyStarted).toMatchObject({
      type: "subagent_started",
      context_artifacts: { version: 1, total_utf8_bytes: 0, artifacts: [] },
    });
  });

  it("persists safe structured context rejection identity and no raw text", async () => {
    const primaryCheckout = await repository();
    const log = new InMemoryRecordLog();
    const result = await delegateTool(primaryCheckout, "audit-rejection", log).execute(
      "delegate",
      {
        tasks: [
          task("rejected", [
            { id: "secret-inline", source: "inline", text: "do-not-log-on-rejection" },
            { id: "missing", source: "file", path: "missing.md" },
          ]),
        ],
      },
      undefined,
      undefined,
      {} as never,
    );
    const rejection = log
      .records("audit-rejection")
      .find((record) => record.type === "delegation_validation_rejected");

    expect(result).toMatchObject({ isError: true });
    expect(rejection).toMatchObject({
      type: "delegation_validation_rejected",
      errors: [
        expect.objectContaining({
          code: "context-artifact-not-materialized",
          task_id: "rejected",
          artifact_id: "missing",
          path: "missing.md",
        }),
      ],
    });
    expect(JSON.stringify(rejection)).not.toContain("do-not-log-on-rejection");
    expect(JSON.stringify(rejection)).not.toContain(primaryCheckout);
  });
});
