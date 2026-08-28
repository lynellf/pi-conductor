import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  type ChildTerminal,
  executeDelegate,
  type SpawnChildConfig,
} from "../../src/host/delegation/delegate-tool.js";
import type { DelegationPolicy, SubagentProfile } from "../../src/manifest/types.js";
import type { ContextArtifact } from "../../src/seam/schema.js";

const execFileAsync = promisify(execFile);
const repositories: string[] = [];

const policy: DelegationPolicy = {
  allowed_subagents: ["focused"],
  max_children_per_session: 2,
  max_parallel: 2,
};

const profile: SubagentProfile = {
  name: "focused",
  models: [{ model: "stub:model", effort: "medium" }],
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
});
