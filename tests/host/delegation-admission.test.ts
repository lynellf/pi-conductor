import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { prepareDelegateSubmission } from "../../src/host/delegation/admission.js";
import { DelegationOwnershipError } from "../../src/host/delegation/delegate-error.js";
import { type ChildTerminal, runPreparedChild } from "../../src/host/delegation/delegate-tool.js";
import type { DelegationPolicy, SubagentProfile } from "../../src/manifest/types.js";
import type { DelegateSubmissionArgs } from "../../src/seam/schema.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const usage = { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 };
const policy: DelegationPolicy = {
  allowed_subagents: ["implementer"],
  max_children_per_session: 2,
  max_parallel: 1,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("prepared delegation admission", () => {
  it("rejects invalid admission before creating child artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-conductor-delegation-invalid-"));
    roots.push(root);
    await execFile("git", ["init", "--quiet"], { cwd: root });
    await expect(
      prepareDelegateSubmission({
        args: { tasks: [] },
        policy,
        profiles: [],
        remainingChildren: 2,
        runStateDir: join(root, "run-state"),
        runId: "run-invalid",
        parentRole: "orchestrator",
        primaryCheckout: root,
        systemPromptRoot: root,
        spawnAndRunChild: async () => {
          throw new Error("unused");
        },
      }),
    ).rejects.toMatchObject({ code: "batch_validation_failed" });
    await expect(access(join(root, "run-state", "worktrees"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("pins prompt, profile, context, base, and projection before child execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-conductor-delegation-admission-"));
    roots.push(root);
    await mkdir(join(root, ".pi"), { recursive: true });
    const promptPath = join(root, "child.md");
    await writeFile(promptPath, "original prompt", "utf8");
    await execFile("git", ["init", "--quiet"], { cwd: root });
    await execFile("git", ["add", "."], { cwd: root });
    await execFile(
      "git",
      [
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "base",
      ],
      { cwd: root },
    );
    const profile = {
      name: "implementer",
      models: [{ model: "stub:model", effort: "medium" }],
      max_session_cost_usd: 1,
      system_prompt: "child.md",
      completion_protocol: "report_result",
    } satisfies SubagentProfile;
    const context = { id: "snapshot", source: "inline" as const, text: "original context" };
    const args: DelegateSubmissionArgs = {
      tasks: [
        {
          id: "task-1",
          subagent: "implementer",
          objective: "original objective",
          expected_output: "original output",
          context_artifacts: [context],
        },
      ],
    };
    const prepared = await prepareDelegateSubmission({
      args,
      policy,
      profiles: [profile],
      remainingChildren: 2,
      runStateDir: join(root, "run-state"),
      runId: "run-1",
      parentRole: "orchestrator",
      primaryCheckout: root,
      systemPromptRoot: root,
      spawnAndRunChild: async () => {
        throw new Error("unused");
      },
    });
    expect(prepared.tasks).toHaveLength(1);
    await expect(access(join(root, "run-state", "worktrees"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await writeFile(promptPath, "mutated prompt", "utf8");
    const mutableModel = profile.models[0];
    if (mutableModel === undefined) throw new Error("profile model missing");
    mutableModel.model = "mutated:model";
    context.text = "mutated context";
    await writeFile(join(root, "after.txt"), "advanced checkout", "utf8");
    await execFile("git", ["add", "."], { cwd: root });
    await execFile(
      "git",
      [
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "advanced",
      ],
      { cwd: root },
    );

    let observed: ChildTerminal | null = null;
    let throwOwnership = false;
    const child = prepared.tasks[0];
    if (child === undefined) throw new Error("prepared child missing");
    const result = await runPreparedChild({
      prepared: child,
      runId: "run-1",
      parentRole: "orchestrator",
      primaryCheckout: root,
      parentMaterializedPaths: prepared.materializedParentPaths,
      systemPromptRoot: root,
      spawnAndRunChild: async (spawned) => {
        if (throwOwnership) {
          throw new DelegationOwnershipError("child ownership became ambiguous", new Error("test"));
        }
        expect(spawned.systemPrompt).toContain("original prompt");
        expect(spawned.profile.models[0]?.model).toBe("stub:model");
        expect(spawned.contextArtifacts[0]).toMatchObject({ text: "original context" });
        expect(spawned.baseCommit).toBe(prepared.baseCommit);
        expect(spawned.worktreePath).toContain(child.childId);
        await expect(readFile(join(spawned.worktreePath, "child.md"), "utf8")).resolves.toBe(
          "original prompt",
        );
        await expect(access(join(spawned.worktreePath, "after.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        observed = {
          started: false,
          model: spawned.profile.models[0]?.model ?? "",
          sessionFile: null,
          usage,
          status: "failed",
          failureReason: "test",
          sessionError: null,
        };
        return observed;
      },
    });
    expect(result.status).toBe("failed");
    expect(observed).not.toBeNull();

    const worktreePath = child.worktreePath;
    await execFile("git", ["worktree", "remove", "--force", worktreePath], { cwd: root });
    await execFile("git", ["branch", "-D", child.branch], { cwd: root });
    throwOwnership = true;
    await expect(
      runPreparedChild({
        prepared: child,
        runId: "run-1",
        parentRole: "orchestrator",
        primaryCheckout: root,
        parentMaterializedPaths: prepared.materializedParentPaths,
        systemPromptRoot: root,
        spawnAndRunChild: async (spawned) => {
          throw new DelegationOwnershipError(
            "child ownership became ambiguous",
            new Error(`unexpected callback ${spawned.childId}`),
          );
        },
      }),
    ).rejects.toBeInstanceOf(DelegationOwnershipError);
  });
});
