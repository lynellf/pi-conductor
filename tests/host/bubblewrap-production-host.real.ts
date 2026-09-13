/** Regression for #108: production host protection roots exist before capture. */
import { lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StreamFunction } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { ProductionDelegationCoordinator } from "../../src/host/delegation/production-delegation.js";
import { createDelegateTool } from "../../src/host/production-host-delegation.js";
import { makeStubModel, makeStubStreamFunction } from "../../src/host/stub-provider.js";
import { InMemoryRecordLog, loadManifestFromString } from "../../src/index.js";
import type { PersistedRecord } from "../../src/persistence/log.js";
import type { DelegateArgs } from "../../src/seam/schema.js";
import {
  createRealDelegationFixture,
  type RealDelegationFixture,
} from "./fixtures/bubblewrap-delegation-fixture.js";

const paths = ["alpha", "beta", "gamma", "delta"] as const;
const fixtures: RealDelegationFixture[] = [];

afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())));

describe("real production host Bubblewrap delegation", () => {
  it.each([
    { name: "accepts four tasks from a fresh layout", unsafeRoot: false },
    { name: "rejects a symlink workspace root before admission", unsafeRoot: true },
  ])("$name (#108)", async ({ unsafeRoot }) => {
    const fixture = await createRealDelegationFixture({
      freshProductionLayout: true,
      fourFiles: true,
    });
    fixtures.push(fixture);
    const runRoot = fixture.runStateDir;
    const outside = join(fixture.root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "sentinel"), "untouched\n");
    if (unsafeRoot) await symlink(outside, join(runRoot, "worktrees"));
    const log = new InMemoryRecordLog();
    const records = (): readonly PersistedRecord[] => log.records("real-delegate");
    const profiles = paths.map((path) => profile(path));
    const loadedManifest = loadManifestFromString(manifestYaml(profiles), fixture.checkout);
    const registry = routedRegistry(
      new Map(paths.map((path) => [path, streamFor(`worker-${path}`)])),
    );
    const coordinator = new ProductionDelegationCoordinator();
    try {
      const tool = await createDelegateTool(
        {
          loadedManifest,
          sandboxHostApproval: fixture.hostApproval,
          runId: "real-delegate",
          cwd: fixture.root,
          agentDir: fixture.agentDir,
          sessionDir: fixture.sessionDir,
          modelRegistry: registry,
          displaySink: undefined,
          log,
          delegation: coordinator,
          runCostSoFar: () => 0,
          persistRecord: (record) => log.append(record),
          adaptDelegateToolResult: (result) => result as never,
        },
        "orchestrator",
        loadedManifest.manifest.roles[0],
        fixture.checkout,
        1,
        1,
        undefined,
        undefined,
        undefined,
      );

      if (unsafeRoot) expect((await lstat(join(runRoot, "worktrees"))).isSymbolicLink()).toBe(true);
      else
        await expect(lstat(join(runRoot, "worktrees"))).rejects.toMatchObject({ code: "ENOENT" });
      for (const name of ["sandbox", "sandboxes"]) {
        await expect(lstat(join(runRoot, name))).rejects.toMatchObject({ code: "ENOENT" });
      }

      const response = await invoke(tool, {
        mode: "nonblocking",
        tasks: profiles.map((child) => ({
          id: `task-${child.name}`,
          subagent: child.name,
          objective: `update ${child.name}`,
          expected_output: "done",
          projection_paths: [`${child.name.slice(7)}/value.txt`],
        })),
      });
      const first = response.content[0];
      const responseText = first?.type === "text" ? first.text : "";
      const accepted = JSON.parse(responseText || "{}") as { child_ids?: unknown[] };
      if (unsafeRoot) {
        expect(responseText).toContain("root-invalid");
        expect(responseText).toContain(join(runRoot, "worktrees"));
        expect(responseText).toContain("symlink");
        expect(responseText.length).toBeLessThan(1600);
        expect(accepted.child_ids).toBeUndefined();
        expect(
          records().filter((record) => record.type === "delegation_submission_accepted"),
        ).toHaveLength(0);
        expect(records().filter((record) => record.type === "subagent_started")).toHaveLength(0);
        expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("untouched\n");
        expect(await readdir(outside)).toEqual(["sentinel"]);
        return;
      }
      if (accepted.child_ids === undefined) throw new Error(responseText || "empty response");
      expect(accepted.child_ids).toHaveLength(4);
      expect(
        records().filter((record) => record.type === "delegation_submission_accepted"),
      ).toHaveLength(1);

      await waitFor(() => records().filter((record) => terminal(record)).length === 4);
      expect(records().filter((record) => record.type === "subagent_started")).toHaveLength(4);
      expect(records().filter((record) => record.type === "subagent_completed")).toHaveLength(4);
      const started = records().filter((record) => record.type === "subagent_started");
      const acceptedRecord = records().find(
        (record) => record.type === "delegation_submission_accepted",
      );
      if (acceptedRecord?.type !== "delegation_submission_accepted")
        throw new Error("missing accepted record");
      expect(new Set(acceptedRecord.children.map((child) => child.child_id))).toEqual(
        new Set(started.map((child) => (child.type === "subagent_started" ? child.child_id : ""))),
      );
      for (const record of records().filter((entry) => entry.type === "subagent_completed")) {
        if (record.type === "subagent_completed")
          expect(
            await readFile(
              join(record.worktree_path, record.subagent.replace("worker-", ""), "value.txt"),
              "utf8",
            ),
          ).toContain(record.subagent);
      }
      for (const name of ["worktrees", "sandbox", "sandboxes"]) {
        const stat = await lstat(join(runRoot, name));
        expect(stat.isDirectory()).toBe(true);
        expect(stat.mode & 0o777).toBe(0o700);
      }
      expect(await readFile(join(fixture.checkout, "alpha/value.txt"), "utf8")).toBe("original\n");
      expect(await readFile(join(fixture.checkout, "beta/value.txt"), "utf8")).toBe("original\n");
      expect(await readFile(join(fixture.checkout, "gamma/value.txt"), "utf8")).toBe("original\n");
      expect(await readFile(join(fixture.checkout, "delta/value.txt"), "utf8")).toBe("original\n");
    } finally {
      await coordinator.close();
    }
  }, 90_000);
});

function profile(path: (typeof paths)[number]) {
  return {
    name: `worker-${path}`,
    models: [{ model: `stub:${path}`, effort: "medium" as const }],
    max_session_cost_usd: 1,
    system_prompt: "worker.md",
    completion_protocol: "minimal" as const,
    execution: {
      backend: "bubblewrap" as const,
      runtime_root: ".pi/runtime",
      writable_paths: [`${path}/value.txt`],
    },
    workspace: { projection: { required: true, allowed_paths: [`${path}/value.txt`] } },
    tool_execution: { timeout_seconds: 5, termination_grace_seconds: 1 },
  };
}

function manifestYaml(profiles: readonly ReturnType<typeof profile>[]): string {
  return `version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [{ model: stub:parent, effort: medium }]
    system_prompt: worker.md
    tools: [delegate]
    delegation:
      mode: nonblocking
      allowed_subagents: [${profiles.map((profile) => profile.name).join(", ")}]
      max_children_per_session: 4
      max_parallel: 4
subagents:
${profiles
  .map(
    (profile) => `  - name: ${profile.name}
    models: [{ model: ${profile.models[0]?.model}, effort: medium }]
    max_session_cost_usd: 1
    system_prompt: worker.md
    completion_protocol: minimal
    execution:
      backend: bubblewrap
      runtime_root: .pi/runtime
      writable_paths: [${profile.execution.writable_paths[0]}]
    workspace:
      projection:
        required: true
        allowed_paths: [${profile.execution.writable_paths[0]}]
    tool_execution: { timeout_seconds: 5, termination_grace_seconds: 1 }`,
  )
  .join("\n")}`;
}

function streamFor(name: string): StreamFunction {
  return makeStubStreamFunction({
    steps: [
      {
        kind: "emit_tool_calls",
        calls: [
          {
            name: "write",
            arguments: { path: `${name.slice(7)}/value.txt`, content: `${name}\n` },
          },
        ],
      },
      { kind: "emit_text", text: "done" },
    ],
  });
}

function routedRegistry(streams: ReadonlyMap<string, StreamFunction>): ModelRegistry {
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  const base = makeStubModel();
  registry.registerProvider("stub", {
    api: "anthropic-messages",
    apiKey: "unused",
    baseUrl: base.baseUrl,
    streamSimple: ((model, context, options) => {
      const stream = streams.get(model.id);
      if (stream === undefined) throw new Error(`missing stream ${model.id}`);
      return stream(model, context, options);
    }) as StreamFunction,
    models: [...streams.keys()].map((id) => ({ ...base, id, name: id })),
  });
  return registry;
}

async function invoke(tool: Awaited<ReturnType<typeof createDelegateTool>>, args: DelegateArgs) {
  return tool.execute("call-four", args, undefined, undefined, {} as never);
}

function terminal(record: PersistedRecord): boolean {
  return record.type === "subagent_completed" || record.type === "subagent_failed";
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 80_000;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  if (!predicate()) throw new Error("timed out waiting for child terminals");
}
