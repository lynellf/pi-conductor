/** Credential-free production SDK delegation through real Bubblewrap and trusted Git. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { StreamFunction } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { createDelegateTool } from "../../src/host/delegation/delegate-tool-factory.js";
import { DelegationManager } from "../../src/host/delegation/manager.js";
import {
  makeStubModel,
  makeStubStreamFunction,
  type StubStep,
} from "../../src/host/stub-provider.js";
import type { SubagentProfile } from "../../src/manifest/types.js";
import type { PersistedRecord } from "../../src/persistence/log.js";
import {
  createRealDelegationFixture,
  type RealDelegationFixture,
} from "./fixtures/bubblewrap-delegation-fixture.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";

const fixtures: RealDelegationFixture[] = [];
afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())));

describe("production Bubblewrap delegated SDK sessions", () => {
  it("diagnoses a failed command, repairs privately, passes, and exposes the trusted patch", async () => {
    const fixture = await createRealDelegationFixture();
    fixtures.push(fixture);
    const records: PersistedRecord[] = [];
    const result = await executeChild(fixture, "alpha", "fixed", records);

    expect(result.status).toBe("completed");
    expect(result.completion_evidence.worktree_state).toBe("changed");
    expect(result.completion_evidence.changed_paths).toEqual(["alpha/value.txt"]);
    expect(await readFile(join(result.worktree_path, "alpha/value.txt"), "utf8")).toBe("fixed\n");
    expect(await readFile(join(fixture.checkout, "alpha/value.txt"), "utf8")).toBe("original\n");
    const terminal = records.filter((record) => record.type === "tool_execution_finished");
    expect(
      terminal.map(
        (record) => record.type === "tool_execution_finished" && record.sandbox?.normalized_status,
      ),
    ).toEqual([17, 0]);
  }, 45_000);

  it("runs two children concurrently with independent projections, outputs, and gates", async () => {
    const fixture = await createRealDelegationFixture();
    fixtures.push(fixture);
    const records: PersistedRecord[] = [];
    const diagnostics = new Set<string>();
    const streams = new Map([
      ["alpha", repairStream("alpha", "alpha-fixed", records, diagnostics)],
      ["beta", repairStream("beta", "beta-fixed", records, diagnostics)],
    ]);
    const profiles = [profile("alpha"), profile("beta")];
    const manager = new DelegationManager();
    const tool = delegate(fixture, profiles, records, manager, routedRegistry(streams));
    try {
      const raw = await invoke(tool, "pair", {
        mode: "blocking",
        tasks: profiles.map((item) => ({
          id: `task-${item.name}`,
          subagent: item.name,
          objective: `repair ${item.name}`,
          expected_output: "done",
          projection_paths: [`${item.name}/value.txt`],
        })),
      });
      const [alpha, beta] = (JSON.parse(raw.content[0].text) as { results: ChildJson[] }).results;
      if (alpha === undefined || beta === undefined) throw new Error("pair results missing");

      expect([
        alpha.completion_evidence.changed_paths,
        beta.completion_evidence.changed_paths,
      ]).toEqual([["alpha/value.txt"], ["beta/value.txt"]]);
      expect(await readFile(join(alpha.worktree_path, "alpha/value.txt"), "utf8")).toBe(
        "alpha-fixed\n",
      );
      expect(await readFile(join(beta.worktree_path, "beta/value.txt"), "utf8")).toBe(
        "beta-fixed\n",
      );
      expect(await readFile(join(fixture.checkout, "alpha/value.txt"), "utf8")).toBe("original\n");
      expect(await readFile(join(fixture.checkout, "beta/value.txt"), "utf8")).toBe("original\n");
      const refs = records
        .filter((record) => record.type === "tool_execution_finished")
        .map((record) =>
          record.type === "tool_execution_finished" ? record.sandbox?.output_ref : undefined,
        );
      expect(new Set(refs).size).toBe(4);
      const firstFinished = records.findIndex(
        (record) => record.type === "tool_execution_finished",
      );
      expect(
        records
          .slice(0, firstFinished)
          .filter((record) => record.type === "tool_execution_started"),
      ).toHaveLength(2);
      expect(diagnostics).toEqual(new Set(["alpha", "beta"]));
    } finally {
      await manager.abortAll();
    }
  }, 60_000);
});

async function executeChild(
  fixture: RealDelegationFixture,
  path: "alpha" | "beta",
  repaired: string,
  records: PersistedRecord[],
) {
  const outputArgs: Record<string, unknown> = {
    output_ref: "00000000-0000-4000-8000-000000000000",
    stream: "stderr",
    offset: 0,
    max_bytes: 4096,
  };
  const testCommand = `if [[ $(<${path}/value.txt) == ${repaired} ]]; then printf pass; else printf 'expected ${repaired}\\n' >&2; exit 17; fi`;
  const steps: StubStep[] = [
    call("write", { path: `${path}/value.txt`, content: "broken\n" }),
    call("bash", { command: testCommand }),
    call("read_execution_output", outputArgs),
    call("write", { path: `${path}/value.txt`, content: `${repaired}\n` }),
    call("bash", { command: testCommand }),
    { kind: "emit_text", text: `repaired ${path}` },
  ];
  const manager = new DelegationManager();
  let diagnosticsSeen = false;
  const registry = makeModelRegistryWithStub(steps, [path], (context) => {
    const failed = [...records]
      .reverse()
      .find(
        (record) =>
          record.type === "tool_execution_finished" && record.sandbox?.normalized_status === 17,
      );
    if (failed?.type === "tool_execution_finished" && failed.sandbox !== undefined)
      outputArgs.output_ref = failed.sandbox.output_ref;
    if (hasSuccessfulOutputResult(context, `expected ${repaired}`)) diagnosticsSeen = true;
  });
  const profile: SubagentProfile = {
    name: `worker-${path}`,
    models: [{ model: `stub:${path}`, effort: "medium" }],
    max_session_cost_usd: 1,
    system_prompt: "worker.md",
    completion_protocol: "minimal",
    execution: {
      backend: "bubblewrap",
      runtime_root: ".pi/runtime",
      writable_paths: [`${path}/value.txt`],
    },
    workspace: { projection: { required: true, allowed_paths: [`${path}/value.txt`] } },
    tool_execution: { timeout_seconds: 5, termination_grace_seconds: 1 },
  };
  const tool = createDelegateTool({
    role: {
      name: "orchestrator",
      is_orchestrator: true,
      models: [{ model: "stub:parent", effort: "medium" }],
      system_prompt: "worker.md",
      tools: ["delegate"],
      delegation: {
        allowed_subagents: [profile.name],
        max_children_per_session: 1,
        max_parallel: 1,
        mode: "blocking",
      },
    },
    subagents: [profile],
    remainingChildren: 1,
    runId: "real-delegate",
    parentRole: "orchestrator",
    parentVisitIndex: 1,
    primaryCheckout: fixture.checkout,
    runStateDir: fixture.runStateDir,
    persistRecord: (record) => records.push(record),
    agentDir: fixture.agentDir,
    systemPromptRoot: fixture.promptRoot,
    modelRegistry: registry,
    sessionDir: fixture.sessionDir,
    manager,
    sandboxAdmission: fixture.sandboxAdmission,
    sandboxHostApproval: fixture.hostApproval,
  });
  try {
    const raw = await (
      tool.execute as unknown as (
        id: string,
        args: unknown,
      ) => Promise<{ content: readonly [{ text: string }] }>
    )(`call-${path}`, {
      mode: "blocking",
      tasks: [
        {
          id: `task-${path}`,
          subagent: profile.name,
          objective: `repair ${path}`,
          expected_output: "repair complete",
          projection_paths: [`${path}/value.txt`],
        },
      ],
    });
    const parsed = JSON.parse(raw.content[0].text) as {
      results?: readonly [
        {
          status: string;
          worktree_path: string;
          completion_evidence: { worktree_state: string; changed_paths: string[] };
        },
      ];
    };
    const result = parsed.results?.[0];
    if (result === undefined)
      throw new Error(`delegate omitted child result: ${raw.content[0].text}`);
    if (!diagnosticsSeen)
      throw new Error("read_execution_output diagnostics were not returned to SDK");
    return result;
  } finally {
    await manager.abortAll();
  }
}

function call(name: string, args: Record<string, unknown>): StubStep {
  return { kind: "emit_tool_calls", calls: [{ name, arguments: args }] };
}

type ChildJson = {
  status: string;
  worktree_path: string;
  completion_evidence: { worktree_state: string; changed_paths: string[] };
};

function profile(path: "alpha" | "beta"): SubagentProfile {
  return {
    name: path,
    models: [{ model: `stub:${path}`, effort: "medium" }],
    max_session_cost_usd: 1,
    system_prompt: "worker.md",
    completion_protocol: "minimal",
    execution: {
      backend: "bubblewrap",
      runtime_root: ".pi/runtime",
      writable_paths: [`${path}/value.txt`],
    },
    workspace: { projection: { required: true, allowed_paths: [`${path}/value.txt`] } },
    tool_execution: { timeout_seconds: 5, termination_grace_seconds: 1 },
  };
}

function repairStream(
  path: "alpha" | "beta",
  repaired: string,
  records: PersistedRecord[],
  diagnostics: Set<string>,
): StreamFunction {
  const output: Record<string, unknown> = {
    output_ref: "00000000-0000-4000-8000-000000000000",
    stream: "stderr",
    offset: 0,
    max_bytes: 4096,
  };
  const command = `if [[ $(<${path}/value.txt) == ${repaired} ]]; then printf pass; else printf expected-${repaired} >&2; exit 17; fi`;
  return makeStubStreamFunction({
    steps: [
      call("write", { path: `${path}/value.txt`, content: "broken\n" }),
      call("bash", { command }),
      call("read_execution_output", output),
      call("write", { path: `${path}/value.txt`, content: `${repaired}\n` }),
      call("bash", { command }),
      { kind: "emit_text", text: "done" },
    ],
    onRequest: (context) => {
      const started = records.find(
        (record) => record.type === "subagent_started" && record.subagent === path,
      );
      const childId = started?.type === "subagent_started" ? started.child_id : undefined;
      const failed = [...records]
        .reverse()
        .find(
          (record) =>
            record.type === "tool_execution_finished" &&
            record.role_session_id === childId &&
            record.sandbox?.normalized_status === 17,
        );
      if (failed?.type === "tool_execution_finished" && failed.sandbox !== undefined)
        output.output_ref = failed.sandbox.output_ref;
      if (hasSuccessfulOutputResult(context, `expected-${repaired}`)) diagnostics.add(path);
    },
  });
}

function hasSuccessfulOutputResult(context: unknown, expected: string): boolean {
  const messages = Array.isArray(context)
    ? context
    : typeof context === "object" &&
        context !== null &&
        "messages" in context &&
        Array.isArray(context.messages)
      ? context.messages
      : [];
  return messages.some((message: unknown) => {
    if (typeof message !== "object" || message === null) return false;
    const candidate = message as {
      role?: unknown;
      toolName?: unknown;
      isError?: unknown;
      content?: unknown;
    };
    if (
      candidate.role !== "toolResult" ||
      candidate.toolName !== "read_execution_output" ||
      candidate.isError !== false ||
      !Array.isArray(candidate.content)
    )
      return false;
    return candidate.content.some(
      (part: unknown) =>
        typeof part === "object" &&
        part !== null &&
        "text" in part &&
        typeof part.text === "string" &&
        part.text.includes(expected),
    );
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

function delegate(
  fixture: RealDelegationFixture,
  profiles: SubagentProfile[],
  records: PersistedRecord[],
  manager: DelegationManager,
  modelRegistry: ModelRegistry,
) {
  return createDelegateTool({
    role: {
      name: "orchestrator",
      is_orchestrator: true,
      models: [{ model: "stub:alpha", effort: "medium" }],
      system_prompt: "worker.md",
      tools: ["delegate"],
      delegation: {
        allowed_subagents: profiles.map((item) => item.name),
        max_children_per_session: 2,
        max_parallel: 2,
        mode: "blocking",
      },
    },
    subagents: profiles,
    remainingChildren: 2,
    runId: "real-delegate",
    parentRole: "orchestrator",
    parentVisitIndex: 1,
    primaryCheckout: fixture.checkout,
    runStateDir: fixture.runStateDir,
    persistRecord: (record) => records.push(record),
    agentDir: fixture.agentDir,
    systemPromptRoot: fixture.promptRoot,
    modelRegistry,
    sessionDir: fixture.sessionDir,
    manager,
    sandboxAdmission: fixture.sandboxAdmission,
    sandboxHostApproval: fixture.hostApproval,
  });
}

function invoke(tool: ReturnType<typeof createDelegateTool>, id: string, args: unknown) {
  return (
    tool.execute as unknown as (
      id: string,
      args: unknown,
    ) => Promise<{ content: readonly [{ text: string }] }>
  )(id, args);
}
