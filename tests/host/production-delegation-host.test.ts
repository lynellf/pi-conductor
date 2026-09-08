/** Real ProductionHost wiring with only physical SDK spawning replaced. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import type { DelegateToolFactoryOptions } from "../../src/host/delegation/delegate-tool-factory.js";
import type { PoolChildResult } from "../../src/host/delegation/pool.js";
import type { RoleSession } from "../../src/host/host.js";
import type { spawnSharedSdkRoleSession } from "../../src/host/shared-sdk-role-spawn.js";

const directories: string[] = [];
afterEach(async () => {
  vi.doUnmock("../../src/host/shared-sdk-role-spawn.js");
  vi.doUnmock("../../src/host/delegation/factory-scheduler.js");
  vi.resetModules();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  // Warm the real import graph before replacing physical boundaries (isolate:false).
  await import("../../src/host/production-host.js");
  vi.resetModules();
  const captured: DelegateToolFactoryOptions[] = [];
  const schedulers: import("../../src/host/delegation/scheduler.js").DelegationScheduler[] = [];
  const parents: Array<{
    session: RoleSession;
    abort: ReturnType<typeof vi.fn>;
    steer: ReturnType<typeof vi.fn>;
    seal: () => void;
  }> = [];
  vi.doMock("../../src/host/delegation/factory-scheduler.js", async () => {
    const actual = await vi.importActual<
      typeof import("../../src/host/delegation/factory-scheduler.js")
    >("../../src/host/delegation/factory-scheduler.js");
    return {
      ...actual,
      createDelegateScheduler: (options: DelegateToolFactoryOptions, id: string) => {
        captured.push(options);
        const scheduler = actual.createDelegateScheduler(options, id);
        schedulers.push(scheduler);
        return scheduler;
      },
    };
  });
  vi.doMock("../../src/host/shared-sdk-role-spawn.js", () => ({
    spawnSharedSdkRoleSession: async (options: Parameters<typeof spawnSharedSdkRoleSession>[0]) => {
      const { SessionState } = await import("../../src/host/cost.js");
      let sealed = false;
      const abort = vi.fn(async () => {});
      const steer = vi.fn(async (_text: string) => {});
      const session: RoleSession = {
        role: options.role,
        sessionId: `parent-${parents.length}`,
        sessionFile: "/tmp/parent.jsonl",
        model: null,
        effort: "medium",
        readCaptureBuffer: () => [],
        resetCaptureBuffer: () => {},
        subscribe: () => () => {},
        prompt: async () => {},
        dispose: async () => {},
        steer,
        isSealed: () => sealed,
      };
      options.sessionStates.set(session.sessionId, new SessionState({ cap: null, model: null }));
      options.agentsBySessionId.set(session.sessionId, { subscribe: () => () => {}, abort });
      parents.push({
        session,
        abort,
        steer,
        seal: () => {
          sealed = true;
        },
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
  const cwd = await mkdtemp(join(tmpdir(), "conduct-delegation-host-"));
  directories.push(cwd);
  const host = new ProductionHost({
    cwd,
    agentDir: join(cwd, "agent"),
    runId: "run-host",
    log: new InMemoryRecordLog(),
    modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
    loadedManifest: loadManifestFromString(`version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end, delegate]
    delegation:
      allowed_subagents: [child]
      max_children_per_session: 2
      max_parallel: 1
subagents:
  - name: child
    models: [stub:model]
    max_session_cost_usd: 1
    system_prompt: child.md
`),
  });
  return { host, captured, parents, schedulers };
}

const notice = { childId: "child-a", status: "completed" } as PoolChildResult;

it("routes a background delegation fatal to the actual parent abort and preserves diagnosis", async () => {
  const f = await fixture();
  const session = await f.host.spawnRole("orchestrator", { visitIndex: 1, executionVisitIndex: 1 });
  const cause = new Error("first append failed ".repeat(50));
  f.captured[0]?.onFatal?.(cause);
  await Promise.resolve();
  expect(f.parents[0]?.abort).toHaveBeenCalledOnce();
  expect(f.host.sessionTerminalReason(session)).toBe("delegation_failed");
  expect(f.host.sessionFailureDetail(session)).toBe(cause.message.slice(0, 512));
  f.captured[0]?.onFatal?.(new Error("later failure"));
  expect(f.host.sessionFailureDetail(session)).toBe(cause.message.slice(0, 512));
});

it("uses live parent usage in the production scheduler budget", async () => {
  const f = await fixture();
  let cost = 0;
  let cap = 2;
  const session = await f.host.spawnRole("orchestrator", {
    visitIndex: 1,
    executionVisitIndex: 1,
    getRunCostCap: () => cap,
    getCurrentParentUsage: () => cost,
  });
  expect(f.captured[0]?.isBudgetExhausted?.()).toBe(false);
  cost = 2;
  expect(f.captured[0]?.isBudgetExhausted?.()).toBe(true);
  cap = 3;
  expect(f.captured[0]?.isBudgetExhausted?.()).toBe(false);
  await f.host.settleDelegation(session, "test cleanup");
});

it("queues advisory steering only for an active unsealed parent and catches delivery rejection", async () => {
  const f = await fixture();
  const session = await f.host.spawnRole("orchestrator", { visitIndex: 1, executionVisitIndex: 1 });
  const parent = f.parents[0];
  if (parent === undefined) throw new Error("missing parent");
  parent.steer.mockRejectedValueOnce(new Error("closed queue"));
  f.captured[0]?.onTaskTerminal?.(notice);
  await Promise.resolve();
  expect(parent.steer).toHaveBeenCalledWith(
    "Delegated child child-a finished with status completed.",
  );
  parent.seal();
  f.captured[0]?.onTaskTerminal?.(notice);
  expect(parent.steer).toHaveBeenCalledOnce();
  await f.host.settleDelegation(session, "test cleanup");
});

it("drops notifications to a settled parent even if its seam was never sealed", async () => {
  const f = await fixture();
  const session = await f.host.spawnRole("orchestrator", { visitIndex: 1, executionVisitIndex: 1 });
  await f.host.settleDelegation(session, "parent failed");
  f.captured[0]?.onTaskTerminal?.(notice);
  expect(f.parents[0]?.steer).not.toHaveBeenCalled();
});

it("retains ownership and failure diagnosis across concurrent and failed settlement", async () => {
  const f = await fixture();
  const session = await f.host.spawnRole("orchestrator", { visitIndex: 1, executionVisitIndex: 1 });
  const scheduler = f.schedulers[0];
  if (scheduler === undefined) throw new Error("missing scheduler");
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const error = new Error("cleanup unknown");
  vi.spyOn(scheduler, "close").mockImplementation(async () => {
    await gate;
    throw error;
  });
  f.captured[0]?.onFatal?.(error);
  const first = f.host.settleDelegation(session, "failure").catch((cause: unknown) => cause);
  let secondSettled = false;
  const second = f.host.settleDelegation(session, "repeat").then(
    () => {
      secondSettled = true;
      return null;
    },
    (cause: unknown) => {
      secondSettled = true;
      return cause;
    },
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(secondSettled).toBe(false);
  release();
  expect(await first).toBe(error);
  expect(await second).toBe(error);
  expect(f.host.sessionTerminalReason(session)).toBe("delegation_failed");
  expect(f.host.sessionFailureDetail(session)).toBe(error.message);
  await expect(f.host.settleDelegation(session, "retry")).rejects.toBe(error);
});

it("awaits child cleanup even if parent abort rejects early, preserving the child failure", async () => {
  const f = await fixture();
  const session = await f.host.spawnRole("orchestrator", { visitIndex: 1, executionVisitIndex: 1 });
  const scheduler = f.schedulers[0];
  const parent = f.parents[0];
  if (scheduler === undefined || parent === undefined) throw new Error("missing ownership");
  const childError = new Error("child cleanup unknown");
  const parentError = new Error("parent abort failed");
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(scheduler, "close").mockImplementation(async () => {
    await gate;
    throw childError;
  });
  parent.abort.mockRejectedValue(parentError);
  let settled = false;
  const abort = f.host.abortSession(session, "operator abort").then(
    () => {
      settled = true;
      return null;
    },
    (cause: unknown) => {
      settled = true;
      return cause;
    },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(parent.abort).toHaveBeenCalledOnce();
  expect(settled).toBe(false);
  release();
  expect(await abort).toBe(childError);
  await expect(f.host.settleDelegation(session, "retry")).rejects.toBe(childError);
});
