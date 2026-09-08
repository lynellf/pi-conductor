import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreparedDelegateChild } from "../../src/host/delegation/admission.js";
import type { DelegateToolFactoryOptions } from "../../src/host/delegation/delegate-tool-factory.js";
import type { PoolChildResult } from "../../src/host/delegation/pool.js";
import type { RoleSession } from "../../src/host/host.js";
import type { RecordLog } from "../../src/persistence/log.js";
import type { DelegateSubmissionArgs } from "../../src/seam/schema.js";
import { child, completed, deferred } from "./delegation-scheduler-review-fixture.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";

const directories: string[] = [];

afterEach(async () => {
  vi.doUnmock("../../src/host/delegation/admission.js");
  vi.doUnmock("../../src/host/delegation/factory-scheduler.js");
  vi.doUnmock("../../src/host/delegation/delegate-tool.js");
  vi.doUnmock("../../src/host/shared-sdk-role-spawn.js");
  vi.resetModules();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function task(id: string) {
  return { id, subagent: "child", objective: `objective ${id}`, expected_output: "done" };
}

function invoke(tool: ToolDefinition, id: string, args: unknown): Promise<unknown> {
  return (tool.execute as unknown as (toolCallId: string, params: unknown) => Promise<unknown>)(
    id,
    args,
  );
}

interface ProductionFixture {
  readonly host: import("../../src/host/production-host.js").ProductionHost;
  readonly session: RoleSession;
  readonly log: RecordLog;
  readonly gates: Map<string, ReturnType<typeof deferred<PoolChildResult>>>;
  readonly starts: string[];
  readonly getDelegateTool: () => ToolDefinition;
  readonly getFactoryOptions: () => DelegateToolFactoryOptions;
  readonly createParent: (modelIndex?: number) => Promise<RoleSession>;
}

async function productionFixture(): Promise<ProductionFixture> {
  const gates = new Map<string, ReturnType<typeof deferred<PoolChildResult>>>();
  const starts: string[] = [];
  let delegateTool: ToolDefinition | undefined;
  let factoryOptions: DelegateToolFactoryOptions | undefined;
  let runLog: RecordLog | undefined;
  await import("../../src/host/production-host.js");
  vi.resetModules();
  vi.doMock("../../src/host/delegation/admission.js", async () => {
    const actual = await vi.importActual<typeof import("../../src/host/delegation/admission.js")>(
      "../../src/host/delegation/admission.js",
    );
    return {
      ...actual,
      prepareDelegateSubmission: async (args: {
        readonly args: DelegateSubmissionArgs;
      }): Promise<{
        readonly baseCommit: string;
        readonly materializedParentPaths: readonly string[];
        readonly tasks: readonly PreparedDelegateChild[];
      }> => ({
        baseCommit: "base",
        materializedParentPaths: [],
        tasks: args.args.tasks.map((item) => child(item.id)),
      }),
    };
  });
  vi.doMock("../../src/host/delegation/factory-scheduler.js", async () => {
    const actual = await vi.importActual<
      typeof import("../../src/host/delegation/factory-scheduler.js")
    >("../../src/host/delegation/factory-scheduler.js");
    return {
      ...actual,
      createDelegateScheduler: (options: DelegateToolFactoryOptions, logicalParentId: string) => {
        factoryOptions = options;
        return actual.createDelegateScheduler(options, logicalParentId);
      },
    };
  });
  vi.doMock("../../src/host/delegation/delegate-tool.js", async () => {
    const actual = await vi.importActual<
      typeof import("../../src/host/delegation/delegate-tool.js")
    >("../../src/host/delegation/delegate-tool.js");
    return {
      ...actual,
      runPreparedChild: async ({ prepared }: { readonly prepared: PreparedDelegateChild }) => {
        starts.push(prepared.taskId);
        runLog?.append({
          type: "subagent_started",
          run_id: "production-mode-run",
          child_id: prepared.childId,
          task_id: prepared.taskId,
          subagent: prepared.profile.name,
          parent_role: "orchestrator",
          parent_visit_index: 1,
          model: prepared.profile.models[0]?.model ?? "stub:child",
          session_file: `/tmp/${prepared.childId}.jsonl`,
          worktree_path: prepared.worktreePath,
          branch: prepared.branch,
          base_commit: prepared.baseCommit,
          ts: Date.now(),
        });
        const gate = deferred<PoolChildResult>();
        gates.set(prepared.childId, gate);
        return gate.promise;
      },
    };
  });
  vi.doMock("../../src/host/shared-sdk-role-spawn.js", () => ({
    spawnSharedSdkRoleSession: async (
      options: Parameters<
        typeof import("../../src/host/shared-sdk-role-spawn.js")["spawnSharedSdkRoleSession"]
      >[0],
    ): Promise<RoleSession> => {
      delegateTool = options.delegateTool ?? undefined;
      const session: RoleSession = {
        role: options.role,
        sessionId: `parent-${options.executionVisitIndex ?? 1}-${options.logicalModel ?? "primary"}`,
        sessionFile: "/tmp/parent-production.jsonl",
        model: null,
        effort: options.effort,
        readCaptureBuffer: () => [],
        resetCaptureBuffer: () => {},
        subscribe: () => () => {},
        prompt: async () => {},
        dispose: async () => {},
        steer: async () => {},
        isSealed: () => false,
      };
      const { SessionState } = await import("../../src/host/cost.js");
      options.sessionStates.set(session.sessionId, new SessionState({ cap: null, model: null }));
      options.agentsBySessionId.set(session.sessionId, {
        subscribe: () => () => {},
        abort: async () => {},
      });
      return session;
    },
  }));
  const [{ ProductionHost }, { loadManifestFromString }, { InMemoryRecordLog }] = await Promise.all(
    [
      import("../../src/host/production-host.js"),
      import("../../src/host/manifest.js"),
      import("../../src/persistence/in-memory-log.js"),
    ],
  );
  const cwd = await mkdtemp(join(tmpdir(), "pi-conductor-production-mode-"));
  directories.push(cwd);
  const loadedManifest = loadManifestFromString(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [stub:primary, stub:fallback]
    tools: [handoff, end, delegate]
    delegation:
      mode: nonblocking
      allowed_subagents: [child]
      max_children_per_session: 3
      max_parallel: 2
subagents:
  - name: child
    models: [stub:child]
    max_session_cost_usd: 1
    system_prompt: child.md
`);
  const log = new InMemoryRecordLog();
  runLog = log;
  const host = new ProductionHost({
    cwd,
    agentDir: join(cwd, "agent"),
    runId: "production-mode-run",
    log,
    modelRegistry: makeModelRegistryWithStub([], ["primary", "fallback", "child"]),
    loadedManifest,
  });
  const createParent = async (modelIndex?: number): Promise<RoleSession> => {
    const session = await host.spawnRole("orchestrator", {
      visitIndex: 1,
      executionVisitIndex: 1,
      ...(modelIndex === undefined ? {} : { modelIndex }),
    });
    return session;
  };
  const session = await createParent();
  const getDelegateTool = (): ToolDefinition => {
    if (delegateTool === undefined) throw new Error("delegate tool was not wired");
    return delegateTool;
  };
  const getFactoryOptions = (): DelegateToolFactoryOptions => {
    if (factoryOptions === undefined) throw new Error("delegate factory was not wired");
    return factoryOptions;
  };
  return { host, session, log, gates, starts, getDelegateTool, getFactoryOptions, createParent };
}

describe("Issue #86 production delegation mode", () => {
  it("uses manifest nonblocking mode with omitted call mode and preserves controls", async () => {
    const fixture = await productionFixture();
    const tool = fixture.getDelegateTool();
    expect(fixture.getFactoryOptions().role.delegation?.mode).toBe("nonblocking");

    const a = await invoke(tool, "call-a", { tasks: [task("a")] });
    const b = await invoke(tool, "call-b", { tasks: [task("b")] });
    expect(a).toMatchObject({ content: [{ text: JSON.stringify({ child_ids: ["child-a"] }) }] });
    expect(b).toMatchObject({ content: [{ text: JSON.stringify({ child_ids: ["child-b"] }) }] });
    expect(fixture.starts).toEqual(["a", "b"]);

    const gateB = fixture.gates.get("child-b");
    if (gateB === undefined) throw new Error("B did not start");
    gateB.resolve(completed(child("b")));
    await invoke(tool, "call-wait-b", { operation: "wait", child_ids: ["child-b"] });
    const c = await invoke(tool, "call-c", { tasks: [task("c")] });
    expect(c).toMatchObject({ content: [{ text: JSON.stringify({ child_ids: ["child-c"] }) }] });
    expect(fixture.starts).toEqual(["a", "b", "c"]);

    const statuses = await invoke(tool, "call-status", {
      operation: "status",
      child_ids: ["child-a", "child-c"],
    });
    expect(statuses).toMatchObject({ details: { operation: "status" } });
    const statusText = (statuses as { content: readonly [{ text: string }] }).content[0].text;
    expect(JSON.parse(statusText)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ child_id: "child-a", status: "running" }),
        expect.objectContaining({ child_id: "child-c", status: "running" }),
      ]),
    );
    const gateA = fixture.gates.get("child-a");
    const gateC = fixture.gates.get("child-c");
    if (gateA === undefined || gateC === undefined) throw new Error("A/C did not start");
    gateA.resolve(completed(child("a")));
    gateC.resolve(completed(child("c")));
    await fixture.host.settleDelegation(fixture.session, "test cleanup");
    expect(fixture.log.records("production-mode-run")).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "delegation_submission_accepted" })]),
    );
  });

  it("replays spent allowance across a same-visit fallback parent", async () => {
    const fixture = await productionFixture();
    const firstTool = fixture.getDelegateTool();
    await invoke(firstTool, "fallback-a", { tasks: [task("a")] });
    await invoke(firstTool, "fallback-b", { tasks: [task("b")] });
    const gateA = fixture.gates.get("child-a");
    const gateB = fixture.gates.get("child-b");
    if (gateA === undefined || gateB === undefined)
      throw new Error("initial children did not start");
    gateA.resolve(completed(child("a")));
    gateB.resolve(completed(child("b")));
    await fixture.host.settleDelegation(fixture.session, "fallback");

    const replacement = await fixture.createParent(1);
    const fallbackTool = fixture.getDelegateTool();
    const c = await invoke(fallbackTool, "fallback-c", { tasks: [task("c")] });
    expect(c).toMatchObject({ content: [{ text: JSON.stringify({ child_ids: ["child-c"] }) }] });
    const fourth = await invoke(fallbackTool, "fallback-d", { tasks: [task("d")] });
    expect(fourth).toMatchObject({ isError: true });
    expect((fourth as { content: readonly [{ text: string }] }).content[0].text).toContain(
      "admission allowance exhausted",
    );
    expect(fixture.starts).not.toContain("d");
    expect(fixture.log.records("production-mode-run")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "delegation_submission_accepted",
          tool_call_id: "fallback-c",
        }),
      ]),
    );
    const gateC = fixture.gates.get("child-c");
    if (gateC === undefined) throw new Error("fallback child C did not start");
    gateC.resolve(completed(child("c")));
    await fixture.host.settleDelegation(replacement, "test cleanup");
  });
});
