import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { prepareDelegateSubmission } from "../../src/host/delegation/admission.js";
import type { SandboxAdmissionAdapter } from "../../src/host/delegation/delegate-tool.js";
import { resolveSandboxWritableAuthority } from "../../src/host/execution/sandbox/writable-authority.js";
import type { DelegationPolicy, SubagentProfile } from "../../src/manifest/types.js";

const run = promisify(execFile);
const roots: string[] = [];
const policy: DelegationPolicy = {
  allowed_subagents: ["worker"],
  max_children_per_session: 2,
  max_parallel: 2,
};
const descriptor = {
  backend: "bubblewrap" as const,
  execution_policy_digest: "a".repeat(64),
  runtime_digest: "b".repeat(64),
  materialization_id: "issue-107-projection",
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Issue #107 trusted projection admission", () => {
  it("prepares the whole disjoint batch and retains unrelated tracked names", async () => {
    const { checkout, promptRoot } = await fixture();
    const captures: { selected: readonly string[]; tracked: readonly string[] }[] = [];
    const prepared = await prepare(
      checkout,
      promptRoot,
      [task("alpha", ["src/alpha.ts"]), task("beta", ["src/beta.ts"])],
      {
        capture: async (input) => {
          captures.push({ selected: input.selectedPaths, tracked: input.trackedPaths });
          resolveSandboxWritableAuthority({
            writablePaths: input.profile.execution?.writable_paths ?? [],
            selectedPaths: input.selectedPaths,
            trackedPaths: input.trackedPaths,
            ...(input.projectionRoots === undefined
              ? {}
              : { projectionRoots: input.projectionRoots }),
          });
          return { sandbox: descriptor };
        },
        verify: async () => {},
      },
    );

    expect(prepared.tasks).toHaveLength(2);
    expect(captures).toHaveLength(2);
    expect(captures.map((capture) => capture.selected)).toEqual(
      expect.arrayContaining([["src/alpha.ts"], ["src/beta.ts"]]),
    );
    for (const capture of captures) {
      expect(capture.tracked).toEqual([
        "docs/notes + final.md",
        "docs/space name.md",
        "src/alpha.ts",
        "src/beta.ts",
      ]);
    }
  });

  it("rejects the whole batch when one explicit selection is unsafe", async () => {
    const { checkout, promptRoot } = await fixture();
    let captureCalls = 0;
    const adapter: SandboxAdmissionAdapter = {
      capture: async () => {
        captureCalls += 1;
        return { sandbox: descriptor };
      },
      verify: async () => {},
    };
    for (const unsafePath of ["docs/space name.md", "docs/notes + final.md", "../secret.md"]) {
      await expect(
        prepare(
          checkout,
          promptRoot,
          [task("safe", ["src/alpha.ts"]), task("unsafe", [unsafePath])],
          adapter,
        ),
      ).rejects.toMatchObject({
        code: "batch_validation_failed",
        errors: expect.arrayContaining([
          expect.objectContaining({ code: "unsafe-projection-path" }),
        ]),
      });
    }
    expect(captureCalls).toBe(0);
  });

  it("rejects writable ancestors of materialized tracked names that cannot be selected", async () => {
    const { checkout, promptRoot } = await fixture();
    const excluded = "src/notes + final.md";
    await writeFile(join(checkout, excluded), "excluded\n", { mode: 0o600 });
    await git(checkout, ["add", excluded]);
    await git(checkout, ["commit", "-qm", "excluded descendant"]);
    await chmod(join(checkout, ".git/index"), 0o600);
    const adapter: SandboxAdmissionAdapter = {
      capture: async (input) => {
        expect(input.trackedPaths).toContain(excluded);
        resolveSandboxWritableAuthority({
          writablePaths: input.profile.execution?.writable_paths ?? [],
          selectedPaths: input.selectedPaths,
          trackedPaths: input.trackedPaths,
        });
        return { sandbox: descriptor };
      },
      verify: async () => {},
    };
    await expect(
      prepare(
        checkout,
        promptRoot,
        [task("both", ["src/alpha.ts", "src/beta.ts"])],
        adapter,
        profile(["src"]),
      ),
    ).rejects.toMatchObject({ code: "sandbox-writable-excluded-descendant" });
  });

  it("passes complete sparse tracked metadata to writable-authority checks", async () => {
    const { checkout, promptRoot } = await fixture();
    await git(checkout, ["sparse-checkout", "init", "--no-cone"]);
    await git(checkout, ["sparse-checkout", "set", "--no-cone", "src/alpha.ts"]);
    await chmod(join(checkout, "src/alpha.ts"), 0o600);
    await chmod(join(checkout, ".git/index"), 0o600);
    let captured: { selected: readonly string[]; tracked: readonly string[] } | undefined;
    const adapter: SandboxAdmissionAdapter = {
      capture: async (input) => {
        captured = { selected: input.selectedPaths, tracked: input.trackedPaths };
        resolveSandboxWritableAuthority({
          writablePaths: input.profile.execution?.writable_paths ?? [],
          selectedPaths: input.selectedPaths,
          trackedPaths: input.trackedPaths,
          ...(input.projectionRoots === undefined
            ? {}
            : { projectionRoots: input.projectionRoots }),
        });
        return { sandbox: descriptor };
      },
      verify: async () => {},
    };
    await expect(
      prepare(checkout, promptRoot, [task("sparse", ["src/alpha.ts"])], adapter, profile(["src"])),
    ).rejects.toMatchObject({ code: "sandbox-writable-excluded-descendant" });
    expect(captured).toEqual({
      selected: ["src/alpha.ts"],
      tracked: ["docs/notes + final.md", "docs/space name.md", "src/alpha.ts", "src/beta.ts"],
    });
  });
});

async function fixture(): Promise<{ checkout: string; promptRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-conductor-issue-107-"));
  roots.push(root);
  const checkout = join(root, "checkout");
  const promptRoot = join(root, "prompts");
  await mkdir(join(checkout, "src"), { recursive: true });
  await mkdir(join(checkout, "docs"), { recursive: true });
  await mkdir(promptRoot);
  await writeFile(join(checkout, "src/alpha.ts"), "alpha\n");
  await writeFile(join(checkout, "src/beta.ts"), "beta\n");
  await writeFile(join(checkout, "docs/notes + final.md"), "notes\n");
  await writeFile(join(checkout, "docs/space name.md"), "space\n");
  await writeFile(join(promptRoot, "worker.md"), "worker\n");
  await git(checkout, ["init", "-q"]);
  await git(checkout, ["config", "user.name", "Issue 107"]);
  await git(checkout, ["config", "user.email", "issue-107@example.invalid"]);
  await git(checkout, ["add", "."]);
  await git(checkout, ["commit", "-qm", "fixture"]);
  await chmod(checkout, 0o700);
  await chmod(join(checkout, "src"), 0o700);
  await chmod(join(checkout, "docs"), 0o700);
  await chmod(join(checkout, "src/alpha.ts"), 0o600);
  await chmod(join(checkout, "src/beta.ts"), 0o600);
  await chmod(join(checkout, "docs/notes + final.md"), 0o600);
  await chmod(join(checkout, "docs/space name.md"), 0o600);
  await chmod(join(checkout, ".git"), 0o700);
  await chmod(join(checkout, ".git/index"), 0o600);
  return { checkout, promptRoot };
}

function profile(writablePaths: readonly string[] = []): SubagentProfile {
  return {
    name: "worker",
    models: [{ model: "stub:model", effort: "medium" }],
    max_session_cost_usd: 1,
    system_prompt: "worker.md",
    completion_protocol: "minimal",
    execution: {
      backend: "bubblewrap",
      runtime_root: "runtime",
      writable_paths: [...writablePaths],
    },
    workspace: { projection: { required: true, allowed_paths: ["src"] } },
  };
}

function task(id: string, projection_paths: readonly string[]) {
  return {
    id,
    subagent: "worker",
    objective: "Inspect the selected file.",
    expected_output: "Report the result.",
    projection_paths: [...projection_paths],
  };
}

async function prepare(
  checkout: string,
  promptRoot: string,
  tasks: ReturnType<typeof task>[],
  sandboxAdmission: SandboxAdmissionAdapter,
  worker: SubagentProfile = profile(),
) {
  return prepareDelegateSubmission({
    args: { tasks },
    policy,
    profiles: [worker],
    remainingChildren: 2,
    runStateDir: join(checkout, ".state"),
    runId: "issue-107-run",
    parentRole: "orchestrator",
    primaryCheckout: checkout,
    systemPromptRoot: promptRoot,
    spawnAndRunChild: async () => {
      throw new Error("unused");
    },
    sandboxAdmission,
  });
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await run("git", args, { cwd });
}
