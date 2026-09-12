import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { prepareDelegateSubmission } from "../../src/host/delegation/admission.js";
import type { SandboxAdmissionAdapter } from "../../src/host/delegation/delegate-tool.js";
import type { DelegationPolicy, SubagentProfile } from "../../src/manifest/types.js";

const execFileAsync = promisify(execFile);
const policy: DelegationPolicy = {
  allowed_subagents: ["worker"],
  max_children_per_session: 2,
  max_parallel: 1,
};
const descriptor = {
  backend: "bubblewrap" as const,
  execution_policy_digest: "a".repeat(64),
  runtime_digest: "b".repeat(64),
  materialization_id: "550e8400-e29b-41d4-a716-446655440000",
};
const roots = { required: ["src-a.txt", "tests-b.txt"], optional: ["src-a.txt", "tests-b.txt"] };
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; promptRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-conductor-sandbox-admission-"));
  tempDirs.push(root);
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "src-a.txt"), "a\n");
  await writeFile(join(root, "tests-b.txt"), "b\n");
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: root });
  const promptRoot = await mkdtemp(join(tmpdir(), "pi-conductor-prompts-"));
  tempDirs.push(promptRoot);
  await writeFile(join(promptRoot, "worker.md"), "worker\n");
  return { root, promptRoot };
}

function profile(
  execution: SubagentProfile["execution"],
  projection: SubagentProfile["workspace"],
): SubagentProfile {
  return {
    name: "worker",
    models: [{ model: "stub:model", effort: "medium" }],
    max_session_cost_usd: 1,
    system_prompt: "worker.md",
    completion_protocol: "minimal",
    ...(execution === undefined ? {} : { execution }),
    ...(projection === undefined ? {} : { workspace: projection }),
  };
}

async function prepare(
  root: string,
  promptRoot: string,
  worker: SubagentProfile,
  adapter?: SandboxAdmissionAdapter,
  projection_paths?: string[],
) {
  return prepareDelegateSubmission({
    args: {
      tasks: [
        {
          id: "task",
          subagent: "worker",
          objective: "inspect",
          expected_output: "report",
          ...(projection_paths === undefined ? {} : { projection_paths }),
        },
      ],
    },
    policy,
    profiles: [worker],
    remainingChildren: 2,
    runStateDir: join(root, ".state"),
    runId: "run",
    parentRole: "orchestrator",
    primaryCheckout: root,
    systemPromptRoot: promptRoot,
    spawnAndRunChild: async () => {
      throw new Error("spawned");
    },
    ...(adapter === undefined ? {} : { sandboxAdmission: adapter }),
  });
}

describe("sandbox admission preparation", () => {
  it("passes exact selected and complete tracked paths, then freezes the descriptor", async () => {
    const { root, promptRoot } = await fixture();
    let captured: { selectedPaths: readonly string[]; trackedPaths: readonly string[] } | undefined;
    const adapter: SandboxAdmissionAdapter = {
      capture: async (input) => {
        captured = input;
        return { sandbox: { ...descriptor } };
      },
      verify: async () => {},
    };
    const result = await prepare(
      root,
      promptRoot,
      profile(
        { backend: "bubblewrap", runtime_root: "runtime", writable_paths: [] },
        { projection: { required: true, allowed_paths: ["src-a.txt"] } },
      ),
      adapter,
      ["src-a.txt"],
    );
    expect(captured?.selectedPaths).toEqual(["src-a.txt"]);
    expect(captured?.trackedPaths).toEqual(["src-a.txt", "tests-b.txt"]);
    expect(Object.isFrozen(result.tasks[0]?.sandbox)).toBe(true);
  });

  it.each([
    [true, roots.required],
    [false, ["tests-b.txt"]],
  ])("passes %s projection roots", async (required, expectedRoots) => {
    const { root, promptRoot } = await fixture();
    let received: readonly string[] | undefined;
    const adapter: SandboxAdmissionAdapter = {
      capture: async (input) => {
        received = input.projectionRoots;
        return { sandbox: descriptor };
      },
      verify: async () => {},
    };
    await prepare(
      root,
      promptRoot,
      profile(
        { backend: "bubblewrap", runtime_root: "runtime", writable_paths: [] },
        {
          projection: {
            required,
            allowed_paths: roots.required,
            ...(required ? {} : { default_paths: ["tests-b.txt"] }),
          },
        },
      ),
      adapter,
      required ? ["src-a.txt"] : undefined,
    );
    expect(received).toEqual(expectedRoots);
  });

  it("fails capture before acceptance and never calls spawn", async () => {
    const { root, promptRoot } = await fixture();
    const spawned = false;
    const adapter: SandboxAdmissionAdapter = {
      capture: async () => {
        throw new Error("capture failed");
      },
      verify: async () => {},
    };
    await expect(
      prepare(
        root,
        promptRoot,
        profile({ backend: "bubblewrap", runtime_root: "runtime", writable_paths: [] }, undefined),
        adapter,
      ),
    ).rejects.toThrow("capture failed");
    expect(spawned).toBe(false);
  });

  it("skips the adapter for file-only profiles", async () => {
    const { root, promptRoot } = await fixture();
    let calls = 0;
    const adapter: SandboxAdmissionAdapter = {
      capture: async () => {
        calls += 1;
        return { sandbox: descriptor };
      },
      verify: async () => {},
    };
    await prepare(root, promptRoot, profile(undefined, undefined), adapter);
    expect(calls).toBe(0);
  });

  it("rejects opt-in profiles without an adapter", async () => {
    const { root, promptRoot } = await fixture();
    await expect(
      prepare(
        root,
        promptRoot,
        profile({ backend: "bubblewrap", runtime_root: "runtime", writable_paths: [] }, undefined),
      ),
    ).rejects.toThrow("sandbox-backend-unavailable");
  });
});
