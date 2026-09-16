/** Real per-child and global cancellation of production Bubblewrap delegation. */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StreamFunction } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createDelegateTool } from "../../src/host/delegation/delegate-tool-factory.js";
import { DelegationManager } from "../../src/host/delegation/manager.js";
import { readSandboxExecutionOutput } from "../../src/host/execution/sandbox/output-retrieval.js";
import {
  classifySandboxProcess,
  observeSandboxProcess,
} from "../../src/host/execution/sandbox/process-observation.js";
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

const fixtures: RealDelegationFixture[] = [];
afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())));

describe("production Bubblewrap delegated cancellation", () => {
  it("stops one owned child while its sibling completes", async () => {
    const test = await setup({
      alpha: longCommand("alpha"),
      beta: [call("bash", { command: releasableCommand("beta") }), text("beta complete")],
    });
    const invocation = submitBoth(test.tool);
    try {
      const [alphaId, betaId] = await waitForStarted(test.records);
      const [alphaTree, betaTree] = await Promise.all([
        waitForLiveTree(test, alphaId, "alpha"),
        waitForLiveTree(test, betaId, "beta"),
      ]);
      await test.manager.abort(alphaId);
      await expectSettled(alphaTree);
      expect(await classifySandboxProcess(betaTree[0])).toBe("alive");
      await writeFile(retainedPath(test, betaId, "beta/value.txt"), "release\n");
      const results = resultsFrom(await invocation);
      expect(results.map((result) => result.status)).toEqual(["cancelled", "completed"]);
      expect(await readFile(retainedPath(test, alphaId, "alpha/value.txt"), "utf8")).toBe(
        "partial-alpha\n",
      );
      expect(await readFile(join(results[1]?.worktree_path ?? "", "beta/value.txt"), "utf8")).toBe(
        "complete-beta\n",
      );
      expect(await retainedStdout(test, alphaId)).toContain("alpha-output");
      expect([readyCount(test.records, alphaId), readyCount(test.records, betaId)]).toEqual([1, 1]);
    } finally {
      await test.manager.abortAll();
      await invocation.catch(() => undefined);
    }
  }, 60_000);

  it("global abort stops both children and retains partial files and output without replay", async () => {
    const test = await setup({ alpha: longCommand("alpha"), beta: longCommand("beta") });
    const invocation = submitBoth(test.tool);
    try {
      const childIds = await waitForStarted(test.records);
      const trees = await Promise.all(
        childIds.map((id, index) => waitForLiveTree(test, id, index === 0 ? "alpha" : "beta")),
      );
      await test.manager.abortAll();
      await Promise.all(trees.map(expectSettled));
      const results = resultsFrom(await invocation);
      expect(results.map((result) => result.status)).toEqual(["cancelled", "cancelled"]);
      for (const [index, path] of ["alpha", "beta"].entries()) {
        const childId = childIds[index];
        if (childId === undefined) throw new Error("delegate omitted child ID");
        expect(await readFile(retainedPath(test, childId, `${path}/value.txt`), "utf8")).toBe(
          `partial-${path}\n`,
        );
        expect(await retainedStdout(test, childId)).toContain(`${path}-output`);
        expect(readyCount(test.records, childId)).toBe(1);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(childIds.map((id) => readyCount(test.records, id))).toEqual([1, 1]);
    } finally {
      await test.manager.abortAll();
      await invocation.catch(() => undefined);
    }
  }, 60_000);
});

interface TestContext {
  readonly fixture: RealDelegationFixture;
  readonly records: PersistedRecord[];
  readonly manager: DelegationManager;
  readonly tool: ToolDefinition;
}

async function setup(scripts: Record<"alpha" | "beta", readonly StubStep[]>): Promise<TestContext> {
  const fixture = await createRealDelegationFixture();
  fixtures.push(fixture);
  const records: PersistedRecord[] = [];
  const manager = new DelegationManager();
  const profiles = [profile("alpha"), profile("beta")];
  const tool = createDelegateTool({
    role: {
      name: "orchestrator",
      is_orchestrator: true,
      models: [{ model: "stub:alpha", effort: "medium" }],
      system_prompt: "worker.md",
      tools: ["delegate"],
      delegation: {
        allowed_subagents: profiles.map((entry) => entry.name),
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
    modelRegistry: registry(scripts),
    sessionDir: fixture.sessionDir,
    manager,
    sandboxAdmission: fixture.sandboxAdmission,
    sandboxHostApproval: fixture.hostApproval,
  });
  return { fixture, records, manager, tool };
}

function profile(path: "alpha" | "beta"): SubagentProfile {
  return {
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
    tool_execution: { timeout_seconds: 20, termination_grace_seconds: 1 },
  };
}

function registry(scripts: Record<"alpha" | "beta", readonly StubStep[]>): ModelRegistry {
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  const base = makeStubModel();
  const streams = {
    alpha: makeStubStreamFunction({ steps: scripts.alpha }),
    beta: makeStubStreamFunction({ steps: scripts.beta }),
  };
  const streamSimple: StreamFunction = (model, context, options) => {
    const stream = model.id === "alpha" ? streams.alpha : model.id === "beta" ? streams.beta : null;
    if (stream === null) throw new Error(`unexpected stub model '${model.id}'`);
    return stream(model, context, options);
  };
  registry.registerProvider("stub", {
    api: "anthropic-messages",
    apiKey: "stub-dummy-key-not-used",
    baseUrl: base.baseUrl,
    streamSimple,
    models: ["alpha", "beta"].map((id) => ({ ...base, id, name: id })),
  });
  return registry;
}

function longCommand(path: "alpha" | "beta"): readonly StubStep[] {
  return [
    call("bash", {
      command: `printf '${path}-output\\n'; printf 'partial-${path}\\n' > ${path}/value.txt; (trap '' TERM; while :; do :; done) & wait`,
    }),
    text("must not replay after cancellation"),
  ];
}
function releasableCommand(path: "alpha" | "beta"): string {
  return `printf '${path}-output\\n'; printf 'partial-${path}\\n' > ${path}/value.txt; while [[ $(<${path}/value.txt) != release ]]; do :; done; printf 'complete-${path}\\n' > ${path}/value.txt`;
}
function call(name: string, args: Record<string, unknown>): StubStep {
  return { kind: "emit_tool_calls", calls: [{ name, arguments: args }] };
}
function text(value: string): StubStep {
  return { kind: "emit_text", text: value };
}

type DelegateResponse = { readonly content: readonly [{ readonly text: string }] };
type DelegateResult = { readonly status: string; readonly worktree_path: string };
function submitBoth(tool: ToolDefinition): Promise<DelegateResponse> {
  return invoke(tool, "submit", {
    mode: "blocking",
    tasks: ["alpha", "beta"].map((path) => ({
      id: `task-${path}`,
      subagent: `worker-${path}`,
      objective: `run ${path}`,
      expected_output: `${path} result`,
      projection_paths: [`${path}/value.txt`],
    })),
  });
}
function resultsFrom(response: DelegateResponse): readonly DelegateResult[] {
  const parsed = JSON.parse(response.content[0].text) as { results?: readonly DelegateResult[] };
  if (parsed.results?.length !== 2)
    throw new Error(`delegate omitted child results: ${response.content[0].text}`);
  return parsed.results;
}
async function invoke(tool: ToolDefinition, id: string, args: unknown): Promise<DelegateResponse> {
  return await (
    tool.execute as unknown as (id: string, args: unknown) => Promise<DelegateResponse>
  )(id, args);
}

async function waitForStarted(records: PersistedRecord[]): Promise<readonly [string, string]> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const starts = records.filter((record) => record.type === "subagent_started");
    const alpha = starts.find((record) => record.subagent === "worker-alpha")?.child_id;
    const beta = starts.find((record) => record.subagent === "worker-beta")?.child_id;
    if (alpha !== undefined && beta !== undefined) return [alpha, beta];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("sandbox children did not durably start");
}

async function waitForLiveTree(test: TestContext, childId: string, path: "alpha" | "beta") {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (readyCount(test.records, childId) === 1) {
      const init = ready(test.records, childId).final_init;
      try {
        const partial = await readFile(retainedPath(test, childId, `${path}/value.txt`), "utf8");
        const children = (await readFile(`/proc/${init.pid}/task/${init.pid}/children`, "utf8"))
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map(Number);
        if (partial === `partial-${path}\n` && children.length > 0) {
          expect(await classifySandboxProcess(init)).toBe("alive");
          return [init, await observeSandboxProcess(children[0] ?? 0)] as const;
        }
      } catch {
        /* READY can precede the first byte and descendant spawn. */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`sandbox child ${childId} did not expose its exact live tree`);
}
async function expectSettled(identities: readonly { pid: number; startTime: string }[]) {
  for (const identity of identities)
    expect(["settled", "missing"]).toContain(await classifySandboxProcess(identity));
}
function readyCount(records: readonly PersistedRecord[], childId: string): number {
  return records.filter(
    (record) =>
      record.type === "tool_execution_sandbox_ready" &&
      record.schema_version === 1 &&
      record.sandbox.child_id === childId,
  ).length;
}
function ready(records: readonly PersistedRecord[], childId: string) {
  const value = records.find(
    (record) =>
      record.type === "tool_execution_sandbox_ready" &&
      record.schema_version === 1 &&
      record.sandbox.child_id === childId,
  );
  if (value?.type !== "tool_execution_sandbox_ready" || value.schema_version !== 1)
    throw new Error(`sandbox READY missing for ${childId}`);
  return value;
}
function terminal(records: readonly PersistedRecord[], childId: string) {
  const value = [...records]
    .reverse()
    .find(
      (record) => record.type === "tool_execution_finished" && record.role_session_id === childId,
    );
  if (
    value?.type !== "tool_execution_finished" ||
    value.schema_version !== 1 ||
    value.sandbox === undefined
  )
    throw new Error(`sandbox terminal missing for ${childId}`);
  return value;
}
function retainedPath(test: TestContext, childId: string, path: string): string {
  return join(
    test.fixture.runStateDir,
    "sandboxes",
    ready(test.records, childId).sandbox.descriptor.materialization_id,
    "project/writable",
    path,
  );
}
async function retainedStdout(test: TestContext, childId: string): Promise<string> {
  const value = terminal(test.records, childId);
  const outputRef = value.sandbox?.output_ref;
  if (outputRef === undefined) throw new Error(`sandbox output reference missing for ${childId}`);
  const chunk = await readSandboxExecutionOutput({
    runStateDir: test.fixture.runStateDir,
    expectedRunId: "real-delegate",
    expectedChildId: childId,
    expectedExecutionId: value.execution_id,
    outputRef,
    stream: "stdout",
    offset: 0,
    maxBytes: 4096,
  });
  if (chunk.encoding !== "utf8") throw new Error("expected UTF-8 retained output");
  return chunk.data;
}
