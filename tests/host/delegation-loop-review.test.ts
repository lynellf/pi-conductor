import { describe, expect, it } from "vitest";
import { createInitialCheckpoint } from "../../src/core/reduce.js";
import type { MachineDefinition } from "../../src/core/types.js";
import { runLoop } from "../../src/host/loop.js";
import { loadManifestFromString } from "../../src/host/manifest.js";
import type { StubStep } from "../../src/host/stub-provider.js";
import { InMemoryRecordLog, StubHost } from "../../src/index.js";
import { deferred, turn } from "./delegation-scheduler-review-fixture.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

const DEF: MachineDefinition = {
  manifest_version: "1",
  orchestrator: "orchestrator",
  workers: ["worker"],
  max_visits: { worker: 2 },
  end_request_roles: null,
};

describe("delegation cross-layer forced closure", () => {
  it.each([
    "end",
    "handoff",
  ] as const)("cost-cap supersedes %s and settles children before parent acceptance", async (emission) => {
    const checkpoint = createInitialCheckpoint(DEF);
    const log = new InMemoryRecordLog();
    const steps: StubStep[] = [
      emission === "end" ? { kind: "emit_end" } : { kind: "emit_handoff", target_role: "worker" },
    ];
    const host = new StubHost({
      runId: checkpoint.run_id,
      log,
      steps,
      agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-cap-child-review-"),
    });
    let settled = false;
    let prompts = 0;
    host.pendingDelegationTasks = () => (settled ? [] : ["active-child"]);
    host.settleDelegation = async () => {
      expect(
        log
          .records(checkpoint.run_id)
          .some(
            (record) => record.type === "session_ended" || record.type === "transition_accepted",
          ),
      ).toBe(false);
      settled = true;
    };
    const spawn = host.spawnRole.bind(host);
    host.spawnRole = async (role, options) => {
      const session = await spawn(role, options);
      const prompt = session.prompt.bind(session);
      session.prompt = async (seed) => {
        prompts += 1;
        await prompt(seed);
      };
      return session;
    };
    const result = await runLoop({
      def: DEF,
      initialCheckpoint: checkpoint,
      host,
      initialGoal: "finish",
      runCostCap: 0,
    });
    expect(result.exitReason).toBe("done");
    expect(prompts).toBe(1);
    expect(settled).toBe(true);
    expect(
      log.records(checkpoint.run_id).filter((record) => record.type === "transition_accepted"),
    ).toEqual([expect.objectContaining({ event: "end", end_authority: "run_cost_cap" })]);
  });
});

describe("delegation cross-layer model fallback", () => {
  it.each([
    false,
    true,
  ])("holds fallback behind actual cleanup (cleanup failure: %s)", async (cleanupFails) => {
    const loaded = loadManifestFromString(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: ["stub:primary", "stub:fallback"]
    system_prompt: .pi/roles/orchestrator.md
    tools: [handoff, end]
  - name: worker
    max_visits: 2
    system_prompt: .pi/roles/worker.md
    tools: [handoff, end]
`);
    const checkpoint = createInitialCheckpoint(loaded.def);
    const log = new InMemoryRecordLog();
    const host = new StubHost({
      runId: checkpoint.run_id,
      log,
      loadedManifest: loaded,
      steps: [{ kind: "fail", errorMessage: "primary unavailable" }, { kind: "emit_end" }],
      agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-fallback-child-review-"),
    });
    const cleanupEntered = deferred<void>();
    const cleanup = deferred<void>();
    const cleanupError = new Error("child cleanup unconfirmed");
    const events: string[] = [];
    let spawns = 0;
    const spawn = host.spawnRole.bind(host);
    host.spawnRole = async (role, options) => {
      spawns += 1;
      const ordinal = spawns;
      events.push(`spawn:${ordinal}`);
      const session = await spawn(role, options);
      const dispose = session.dispose.bind(session);
      session.dispose = async () => {
        events.push(`dispose:${ordinal}`);
        await dispose();
      };
      return session;
    };
    host.settleDelegation = async () => {
      if (spawns !== 1) return;
      cleanupEntered.resolve();
      await cleanup.promise;
      events.push("children-settled");
    };
    const persist = host.persistRecord.bind(host);
    host.persistRecord = (record) => {
      if (record.type === "session_failed") events.push("parent-failed");
      if (record.type === "model_fallback") events.push("model-fallback");
      persist(record);
    };
    const running = runLoop({
      def: loaded.def,
      initialCheckpoint: checkpoint,
      host,
      initialGoal: "finish",
    });
    const outcome = running.then(
      (result) => ({ result, error: null }),
      (error: unknown) => ({ result: null, error }),
    );
    await cleanupEntered.promise;
    await turn();
    expect(events).toEqual(["spawn:1"]);
    expect(log.records(checkpoint.run_id).some((r) => r.type === "session_failed")).toBe(false);

    if (cleanupFails) cleanup.reject(cleanupError);
    else cleanup.resolve();
    const settled = await outcome;
    if (cleanupFails) {
      expect(settled.error).toBe(cleanupError);
      expect(events).toEqual(["spawn:1", "dispose:1"]);
      expect(log.records(checkpoint.run_id).some((r) => r.type === "session_failed")).toBe(false);
    } else {
      expect(settled.error).toBeNull();
      expect(settled.result?.exitReason).toBe("done");
      expect(events).toEqual([
        "spawn:1",
        "children-settled",
        "parent-failed",
        "dispose:1",
        "model-fallback",
        "spawn:2",
        "dispose:2",
      ]);
      expect(log.records(checkpoint.run_id).find((r) => r.type === "session_failed")).toMatchObject(
        {
          failure_reason: "model_error",
          model: "stub:primary",
        },
      );
    }
  });
});
