/** Issue #111: existing broader snapshots support repeated delegated repair batches. */
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { StreamFunction } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import {
  createDelegateTool,
  type DelegateToolFactoryOptions,
} from "../../src/host/delegation/delegate-tool-factory.js";
import { createDelegateScheduler } from "../../src/host/delegation/factory-scheduler.js";
import { DelegationManager } from "../../src/host/delegation/manager.js";
import {
  makeStubModel,
  makeStubStreamFunction,
  type StubStep,
} from "../../src/host/stub-provider.js";
import type { SubagentProfile } from "../../src/manifest/types.js";
import type { PersistedRecord } from "../../src/persistence/log.js";
import { createRealDelegationFixture } from "./fixtures/bubblewrap-delegation-fixture.js";

const execute = promisify(execFile);
const areas = ["alpha", "beta"] as const;
const imports = Array.from({ length: 55 }, (_, index) => `deps/dep-${index}.sh`);

it.each([
  "broad",
  "narrow",
  "snapshot",
] as const)("reuses one %s profile for two batches with changing files and tests", async (mode) => {
  const setupStarted = performance.now();
  const fixture = await createRealDelegationFixture();
  const records: PersistedRecord[] = [];
  const diagnostics = new Set<string>();
  const profile: SubagentProfile = {
    name: "implementer",
    models: [{ model: "stub:worker", effort: "medium" }],
    max_session_cost_usd: 1,
    system_prompt: "worker.md",
    completion_protocol: "minimal",
    execution: {
      backend: "bubblewrap",
      runtime_root: ".pi/runtime",
      writable_paths: ["alpha", "beta"],
    },
    tool_execution: { timeout_seconds: 5, termination_grace_seconds: 1 },
    ...(mode === "narrow"
      ? {
          workspace: {
            projection: { required: true, allowed_paths: ["alpha", "beta", "deps", "tests"] },
          },
        }
      : mode === "snapshot"
        ? {
            workspace: {
              snapshot: { paths: ["alpha", "beta", "deps", "tests", "reference"], max_files: 100 },
            },
          }
        : {}),
  };
  const pinnedProfile = JSON.stringify(profile);
  const manager = new DelegationManager();
  const selectedCounts: number[] = [];
  const selectedSets: (readonly string[])[] = [];
  const options = {
    role: {
      name: "orchestrator",
      is_orchestrator: true,
      models: [{ model: "stub:parent", effort: "medium" }],
      system_prompt: "worker.md",
      tools: ["delegate"],
      delegation: {
        mode: "blocking",
        allowed_subagents: ["implementer"],
        max_children_per_session: 4,
        max_parallel: 2,
      },
    },
    subagents: [profile],
    remainingChildren: 4,
    runId: "real-delegate",
    parentRole: "orchestrator",
    parentVisitIndex: 1,
    primaryCheckout: fixture.checkout,
    runStateDir: fixture.runStateDir,
    persistRecord: (record: PersistedRecord) => {
      records.push(record);
    },
    records: () => records,
    agentDir: fixture.agentDir,
    systemPromptRoot: fixture.promptRoot,
    modelRegistry: registry(records, diagnostics),
    sessionDir: fixture.sessionDir,
    manager,
    sandboxAdmission: {
      capture: async (input) => {
        selectedCounts.push(input.selectedPaths.length);
        selectedSets.push([...input.selectedPaths]);
        return fixture.sandboxAdmission.capture(input);
      },
      verify: (input) => fixture.sandboxAdmission.verify(input),
    },
    sandboxHostApproval: fixture.hostApproval,
  } satisfies DelegateToolFactoryOptions;
  const scheduler = createDelegateScheduler(options, "campaign-parent");
  const tool = createDelegateTool({ ...options, scheduler });
  try {
    await mkdir(join(fixture.checkout, "deps"));
    await mkdir(join(fixture.checkout, "tests"));
    await mkdir(join(fixture.checkout, "reference"));
    for (let index = 0; index < 10; index++)
      await writeFile(
        join(fixture.checkout, `reference/context-${index}.md`),
        "approved reference\n",
      );
    for (const path of imports) await writeFile(join(fixture.checkout, path), ":\n");
    for (let index = 0; index < 20; index++)
      await writeFile(join(fixture.checkout, `docs/unrelated-${index}.md`), "not a dependency\n");
    await writeFile(join(fixture.checkout, "tests/check.sh"), checkScript(mode === "snapshot"));
    await git(fixture.checkout, ["add", "."]);
    await commit(fixture.checkout, "experiment inputs");
    const setupMs = performance.now() - setupStarted;
    const cycles: unknown[] = [];
    for (const cycle of [1, 2]) {
      const preparationStarted = performance.now();
      if (cycle === 2) {
        await writeFile(join(fixture.checkout, "deps/later.sh"), ":\n");
        await writeFile(join(fixture.checkout, "tests/later.sh"), checkScript(mode === "snapshot"));
        await git(fixture.checkout, ["add", "."]);
        await commit(fixture.checkout, "discover later verification requirement");
      }
      const before = records.length;
      const preparationMs = performance.now() - preparationStarted;
      const submittedAt = Date.now();
      const startedAt = performance.now();
      const response = await tool.execute(
        `cycle-${cycle}`,
        {
          mode: "blocking",
          tasks: areas.map((area) => ({
            id: `cycle-${cycle}-${area}`,
            subagent: "implementer",
            objective: `cycle-${cycle}-${area}`,
            expected_output: "A verified file change.",
            ...(mode === "narrow"
              ? {
                  projection_paths: [
                    ...imports,
                    "alpha/value.txt",
                    "beta/value.txt",
                    "tests/check.sh",
                    ...(cycle === 2 ? ["deps/later.sh", "tests/later.sh"] : []),
                  ],
                }
              : {}),
          })),
        },
        undefined,
        undefined,
        {} as never,
      );
      const content = response.content[0];
      if (content?.type !== "text") throw new Error("missing batch response");
      const batch = JSON.parse(content.text) as {
        results: {
          status: string;
          task_id: string;
          worktree_path: string;
          completion_evidence: { changed_paths: string[] };
        }[];
      };
      expect(batch.results, content.text).toHaveLength(2);
      const settledAt = performance.now();
      for (const child of batch.results) {
        expect(child.status).toBe("completed");
        const area = child.task_id.endsWith("alpha") ? "alpha" : "beta";
        const path = `${area}/${cycle === 1 ? "value" : "new"}.txt`;
        expect(child.completion_evidence.changed_paths).toEqual([path]);
        const value = await readFile(join(child.worktree_path, path), "utf8");
        expect(value).toBe(`cycle-${cycle}-${area}\n`);
        const other = area === "alpha" ? "beta" : "alpha";
        expect(await readFile(join(child.worktree_path, other, "value.txt"), "utf8")).toBe(
          cycle === 1 ? "original\n" : `cycle-1-${other}\n`,
        );
        if (cycle === 1)
          expect(await readFile(join(fixture.checkout, path), "utf8")).toBe("original\n");
        else
          await expect(readFile(join(fixture.checkout, path))).rejects.toMatchObject({
            code: "ENOENT",
          });
        // The parent explicitly verifies and selects each attributable edit.
        await writeFile(join(fixture.checkout, path), value);
      }
      await git(fixture.checkout, ["add", "alpha", "beta"]);
      await commit(fixture.checkout, `integrate cycle ${cycle}`);
      const cycleRecords = records.slice(before);
      const accepted = cycleRecords.find(
        (record) => record.type === "delegation_submission_accepted",
      );
      if (!accepted) throw new Error("missing accepted batch");
      const starts = cycleRecords.filter((record) => record.type === "subagent_started");
      const terminals = cycleRecords.filter((record) => record.type === "subagent_completed");
      const finishes = cycleRecords.filter((record) => record.type === "tool_execution_finished");
      expect(starts).toHaveLength(2);
      expect(terminals).toHaveLength(2);
      expect(finishes.filter((record) => record.sandbox?.normalized_status === 17)).toHaveLength(2);
      expect(finishes.filter((record) => record.sandbox?.normalized_status === 0)).toHaveLength(2);
      const firstFinish = cycleRecords.findIndex(
        (record) => record.type === "tool_execution_finished",
      );
      expect(
        cycleRecords
          .slice(0, firstFinish)
          .filter((record) => record.type === "tool_execution_started"),
      ).toHaveLength(2);
      cycles.push({
        cycle,
        preparationMs,
        admissionMs: accepted.ts - submittedAt,
        childWallMs:
          Math.max(...terminals.map((record) => record.ts)) -
          Math.min(...starts.map((record) => record.ts)),
        verificationAggregateMs: finishes.reduce((sum, record) => sum + record.elapsed_ms, 0),
        delegatedMs: settledAt - startedAt,
        integrationMs: performance.now() - settledAt,
      });
    }
    expect(JSON.stringify(profile)).toBe(pinnedProfile);
    expect(diagnostics.size).toBe(4);
    expect(selectedCounts).toHaveLength(4);
    if (mode === "narrow") expect(selectedCounts).toEqual([58, 58, 60, 60]);
    if (mode === "snapshot") {
      expect(selectedCounts).toEqual([68, 68, 70, 70]);
      for (const paths of selectedSets) {
        expect(paths).not.toContain("docs/unrelated-0.md");
        expect(paths).toContain("reference/context-0.md");
      }
    }
    for (const paths of selectedSets.slice(0, 2)) expect(paths).not.toContain("deps/later.sh");
    for (const paths of selectedSets.slice(2)) {
      expect(paths).toContain("deps/later.sh");
      expect(paths).toContain("tests/later.sh");
    }
    expect(selectedCounts.every((count) => (mode === "narrow" ? count <= 64 : count > 64))).toBe(
      true,
    );
    expect(
      records.filter((record) => record.type === "delegation_submission_accepted"),
    ).toHaveLength(2);
    console.log(
      JSON.stringify({
        experiment: `issue-111-${mode}`,
        model: "deterministic-stub",
        setupMs,
        selectedCounts,
        cycles,
      }),
    );
  } finally {
    try {
      await scheduler.close();
      await manager.abortAll();
    } finally {
      await fixture.cleanup();
    }
  }
}, 120_000);

function registry(records: PersistedRecord[], diagnostics: Set<string>): ModelRegistry {
  const streams = new Map<string, StreamFunction>();
  for (const cycle of [1, 2])
    for (const area of areas) {
      const task = `cycle-${cycle}-${area}`;
      const path = `${area}/${cycle === 1 ? "value" : "new"}.txt`;
      const command = `/bin/bash tests/${cycle === 1 ? "check" : "later"}.sh ${path} ${task}`;
      const output = {
        output_ref: "00000000-0000-4000-8000-000000000000",
        stream: "stderr",
        offset: 0,
        max_bytes: 4096,
      };
      streams.set(
        task,
        makeStubStreamFunction({
          steps: [
            call("write", { path, content: "broken\n" }),
            call("bash", { command }),
            call("read_execution_output", output),
            call("write", { path, content: `${task}\n` }),
            call("bash", { command }),
            { kind: "emit_text", text: "verified" },
          ],
          onRequest: (context) => {
            const child = records.find(
              (record) => record.type === "subagent_started" && record.task_id === task,
            );
            const failed = records.find(
              (record) =>
                record.type === "tool_execution_finished" &&
                record.role_session_id ===
                  (child?.type === "subagent_started" ? child.child_id : undefined) &&
                record.sandbox?.normalized_status === 17,
            );
            if (failed?.type === "tool_execution_finished" && failed.sandbox?.output_ref)
              output.output_ref = failed.sandbox.output_ref;
            if (hasDiagnostic(context, `expected-${task}`)) diagnostics.add(task);
          },
        }),
      );
    }
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  const model = makeStubModel();
  registry.registerProvider("stub", {
    api: "anthropic-messages",
    apiKey: "unused",
    baseUrl: model.baseUrl,
    models: [{ ...model, id: "worker", name: "worker" }],
    streamSimple: ((model, context, options) => {
      const text = JSON.stringify(context);
      const stream = [...streams].find(([task]) => text.includes(task))?.[1];
      if (!stream) throw new Error("unknown experiment task");
      return stream(model, context, options);
    }) as StreamFunction,
  });
  return registry;
}

function call(name: string, args: Record<string, unknown>): StubStep {
  return { kind: "emit_tool_calls", calls: [{ name, arguments: args }] };
}
function checkScript(snapshot: boolean): string {
  const denied = snapshot
    ? "if [[ -e docs/unrelated-0.md || -e .git || -e .pi-conductor ]]; then exit 19; fi\nif (printf unexpected > deps/dep-0.sh) 2>/dev/null; then exit 20; fi\n"
    : "";
  return (
    denied +
    'for dependency in deps/*.sh; do source "$dependency" || exit 18; done\nif [[ $(<"$1") == "$2" ]]; then printf pass; else printf "expected-%s\\n" "$2" >&2; exit 17; fi\n'
  );
}
async function git(cwd: string, args: string[]) {
  return execute("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    env: { PATH: "/usr/bin:/bin", LANG: "C", GIT_CONFIG_NOSYSTEM: "1", HOME: "/nonexistent" },
  });
}
async function commit(cwd: string, message: string) {
  await git(cwd, [
    "-c",
    "user.name=Experiment",
    "-c",
    "user.email=experiment@example.invalid",
    "commit",
    "-qm",
    message,
  ]);
  await chmod(join(cwd, ".git/index"), 0o600);
}

function hasDiagnostic(context: unknown, expected: string): boolean {
  if (
    typeof context !== "object" ||
    context === null ||
    !("messages" in context) ||
    !Array.isArray(context.messages)
  )
    return false;
  return context.messages.some((message: unknown) => {
    if (typeof message !== "object" || message === null) return false;
    const result = message as {
      role?: unknown;
      toolName?: unknown;
      isError?: unknown;
      content?: unknown;
    };
    return (
      result.role === "toolResult" &&
      result.toolName === "read_execution_output" &&
      result.isError === false &&
      JSON.stringify(result.content)?.includes(expected) === true
    );
  });
}
