import { describe, expect, it } from "vitest";
import { createInitialCheckpoint } from "../../src/core/reduce.js";
import type { MachineDefinition } from "../../src/core/types.js";
import { runLoop } from "../../src/host/loop.js";
import type { StubStep } from "../../src/host/stub-provider.js";
import { InMemoryRecordLog, StubHost } from "../../src/index.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

const DEF: MachineDefinition = Object.freeze({
  manifest_version: "1",
  orchestrator: "orchestrator",
  workers: Object.freeze(["worker"]),
  max_visits: Object.freeze({ worker: 2 }),
  end_request_roles: null,
});

function makeHost(steps: readonly StubStep[]) {
  const checkpoint = createInitialCheckpoint(DEF);
  const host = new StubHost({
    runId: checkpoint.run_id,
    log: new InMemoryRecordLog(),
    steps,
    agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-delegation-loop-"),
  });
  return { checkpoint, host };
}

describe("runLoop delegation settlement boundary", () => {
  it("keeps a handoff or end capture open while children are pending", async () => {
    const { checkpoint, host } = makeHost([
      { kind: "emit_end", reason: "premature" },
      { kind: "emit_end", reason: "complete" },
    ]);
    let pendingReads = 0;
    let settled = 0;
    const prompts: string[] = [];
    host.pendingDelegationTasks = () => (pendingReads++ === 0 ? ["child-a"] : []);
    host.settleDelegation = async () => {
      settled += 1;
    };
    const originalSpawn = host.spawnRole.bind(host);
    host.spawnRole = async (role, options) => {
      const session = await originalSpawn(role, options);
      const originalPrompt = session.prompt.bind(session);
      session.prompt = async (text) => {
        prompts.push(text);
        await originalPrompt(text);
      };
      return session;
    };

    const result = await runLoop({
      def: DEF,
      initialCheckpoint: checkpoint,
      host,
      initialGoal: "finish",
    });

    expect(result.exitReason).toBe("done");
    expect(settled).toBe(1);
    expect(prompts[1]).toContain("child-a");
    const records = host.log.records(checkpoint.run_id);
    expect(records.filter((record) => record.type === "transition_accepted")).toHaveLength(1);
    expect(records.some((record) => record.type === "session_failed")).toBe(false);
  });

  it("awaits child settlement before fallback disposal", async () => {
    const { checkpoint, host } = makeHost([{ kind: "emit_end", reason: "complete" }]);
    const events: string[] = [];
    let liveCap = 3;
    let observedCap: number | null | undefined;
    host.pendingDelegationTasks = () => [];
    host.settleDelegation = async () => {
      events.push("settle");
    };
    const originalSpawn = host.spawnRole.bind(host);
    host.spawnRole = async (role, options) => {
      events.push("spawn");
      observedCap = options?.getRunCostCap?.();
      const session = await originalSpawn(role, options);
      const originalDispose = session.dispose.bind(session);
      session.dispose = async () => {
        events.push("dispose");
        await originalDispose();
      };
      return session;
    };

    await runLoop({
      def: DEF,
      initialCheckpoint: checkpoint,
      host,
      initialGoal: "finish",
      getRunCostCap: () => liveCap,
    });

    expect(events).toEqual(["spawn", "settle", "dispose"]);
    expect(observedCap).toBe(3);
    liveCap = 5;
    expect(host.runCostSoFar()).toBe(0);
  });

  it("disposes the parent but rejects before persisting a transition when settlement fails", async () => {
    const { checkpoint, host } = makeHost([{ kind: "emit_end", reason: "complete" }]);
    let disposed = false;
    const originalSpawn = host.spawnRole.bind(host);
    host.spawnRole = async (role, options) => {
      const session = await originalSpawn(role, options);
      const originalDispose = session.dispose.bind(session);
      session.dispose = async () => {
        disposed = true;
        await originalDispose();
      };
      return session;
    };
    host.pendingDelegationTasks = () => [];
    host.settleDelegation = async () => {
      throw new Error("child cleanup failed");
    };

    await expect(
      runLoop({
        def: DEF,
        initialCheckpoint: checkpoint,
        host,
        initialGoal: "finish",
      }),
    ).rejects.toThrow("child cleanup failed");
    expect(disposed).toBe(true);
    const records = host.log.records(checkpoint.run_id);
    expect(records.some((record) => record.type === "transition_accepted")).toBe(false);
    expect(records.some((record) => record.type === "session_ended")).toBe(false);
  });

  it("settles delegated work before a forced cost-cap terminal", async () => {
    const { checkpoint, host } = makeHost([
      { kind: "emit_handoff", target_role: "worker", reason: "delegate first" },
    ]);
    let settled = false;
    let settledBeforeTerminal = false;
    const originalPersist = host.persistRecord.bind(host);
    host.persistRecord = (record) => {
      if (record.type === "session_ended") settledBeforeTerminal = settled;
      originalPersist(record);
    };
    host.pendingDelegationTasks = () => ["child-a"];
    host.settleDelegation = async () => {
      settled = true;
    };

    const result = await runLoop({
      def: DEF,
      initialCheckpoint: checkpoint,
      host,
      initialGoal: "finish",
      runCostCap: 0,
    });

    if (result.exitReason !== "done") console.log(host.log.records(checkpoint.run_id));
    expect(result.exitReason).toBe("done");
    expect(settledBeforeTerminal).toBe(true);
  });

  it("settles a capped worker before accepting its handoff to the forced end", async () => {
    const { checkpoint, host } = makeHost([
      { kind: "emit_handoff", target_role: "worker", reason: "delegate first" },
      { kind: "emit_handoff", target_role: "orchestrator", reason: "worker done" },
    ]);
    let cap: number | null = null;
    let pending = true;
    let settled = false;
    let currentRole = "orchestrator";
    let workerPrompts = 0;
    let settledBeforeWorkerAcceptance = false;
    let acceptedCount = 0;
    const originalSpawn = host.spawnRole.bind(host);
    host.spawnRole = async (role, options) => {
      currentRole = role;
      if (role === "worker") cap = 0;
      const session = await originalSpawn(role, options);
      const originalPrompt = session.prompt.bind(session);
      session.prompt = async (text) => {
        if (role === "worker") workerPrompts += 1;
        await originalPrompt(text);
      };
      return session;
    };
    host.pendingDelegationTasks = () => (currentRole === "worker" && pending ? ["child-a"] : []);
    host.settleDelegation = async () => {
      pending = false;
      settled = true;
    };
    const originalPersist = host.persistRecord.bind(host);
    host.persistRecord = (record) => {
      if (record.type === "transition_accepted" && acceptedCount === 1) {
        settledBeforeWorkerAcceptance = settled;
      }
      if (record.type === "transition_accepted") acceptedCount += 1;
      originalPersist(record);
    };

    const result = await runLoop({
      def: DEF,
      initialCheckpoint: checkpoint,
      host,
      initialGoal: "finish",
      getRunCostCap: () => cap,
    });

    expect(result.exitReason).toBe("done");
    expect(workerPrompts).toBe(1);
    expect(settledBeforeWorkerAcceptance).toBe(true);
    expect(
      host.log
        .records(checkpoint.run_id)
        .some(
          (record) =>
            record.type === "transition_accepted" && record.end_authority === "run_cost_cap",
        ),
    ).toBe(true);
  });
});
