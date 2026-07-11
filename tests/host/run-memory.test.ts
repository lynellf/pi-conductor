/**
 * Task 16.5 — orchestrator run-memory seeding per turn (§8.4).
 *
 * Covers Task 16.5's acceptance criteria:
 *   - An orchestrator session's first turn references current run
 *     cost and uncapped candidates.
 *   - A second orchestrator turn after a worker visit reflects
 *     the new `visit_history` entry.
 *
 * The test uses the e2e task's StubHost + scripted stub provider.
 * The orchestrator's prompts are captured by the FakeSession's
 * `prompts` array — we read them back to assert the seed shape.
 *
 * Single-writer rule (§8.4): only orchestrator sessions receive
 * the run-memory artifact. Worker sessions get the handoff payload
 * (Task 15's `formatHandoffSeed`) — also asserted here so the
 * single-writer rule is documented in code.
 */

import { describe, expect, it } from "vitest";
import { runLoop } from "../../src/host/loop.js";
import {
  createInitialCheckpoint,
  InMemoryRecordLog,
  type MachineDefinition,
  StubHost,
} from "../../src/index.js";

function makeDef(): MachineDefinition {
  return Object.freeze({
    manifest_version: "1",
    orchestrator: "orchestrator",
    workers: Object.freeze(["worker"]),
    max_visits: Object.freeze({ worker: 3 }),
  }) as MachineDefinition;
}

describe("Task 16.5 — orchestrator run-memory seed (§8.4)", () => {
  it("passes a trusted predecessor context reference in both handoff directions", async () => {
    const initialCheckpoint = createInitialCheckpoint(makeDef());
    const log = new InMemoryRecordLog();
    const host = new StubHost({
      runId: initialCheckpoint.run_id,
      log,
      steps: [
        {
          kind: "emit_tool_calls",
          calls: [
            {
              name: "handoff",
              arguments: {
                target_role: "worker",
                reason: "plan ready",
                context_ref: {
                  run_id: "attacker-run",
                  source_role: "attacker",
                  source_session_file: "/attacker/session.jsonl",
                },
              },
            },
          ],
        },
        { kind: "emit_handoff", target_role: "orchestrator", reason: "worker done" },
        { kind: "emit_end", reason: "all done" },
      ],
    });
    const spawned: Array<{ role: string; sessionFile: string; options: unknown }> = [];
    const prompts: Array<{ role: string; text: string }> = [];
    const originalSpawn = host.spawnRole.bind(host);
    host.spawnRole = async (role, options) => {
      const session = await originalSpawn(role, options);
      spawned.push({ role, sessionFile: session.sessionFile, options });
      const originalPrompt = session.prompt.bind(session);
      session.prompt = async (text) => {
        prompts.push({ role, text });
        await originalPrompt(text);
      };
      return session;
    };

    const result = await runLoop({
      def: makeDef(),
      initialCheckpoint,
      host,
      initialGoal: "context test",
      spawnDefaults: {
        handoffContextRef: {
          run_id: "attacker-run",
          source_role: "attacker",
          source_session_file: "/attacker/session.jsonl",
        },
      },
    });

    expect(result.exitReason).toBe("done");
    expect(spawned).toHaveLength(3);
    expect(spawned[0]?.options).not.toHaveProperty("handoffContextRef");
    expect(spawned[1]?.options).toMatchObject({
      handoffContextRef: {
        run_id: initialCheckpoint.run_id,
        source_role: "orchestrator",
        source_session_file: spawned[0]?.sessionFile,
      },
    });
    expect(spawned[2]?.options).toMatchObject({
      handoffContextRef: {
        run_id: initialCheckpoint.run_id,
        source_role: "worker",
        source_session_file: spawned[1]?.sessionFile,
      },
    });

    const workerPrompt = prompts.find((entry) => entry.role === "worker")?.text;
    expect(workerPrompt).toContain("source_role: orchestrator");
    expect(workerPrompt).toContain(spawned[0]?.sessionFile ?? "missing source session");
    expect(workerPrompt).not.toContain("/attacker/session.jsonl");
    const secondOrchestratorPrompt = prompts.filter((entry) => entry.role === "orchestrator")[1]
      ?.text;
    expect(secondOrchestratorPrompt).toContain("context_ref:");
    expect(secondOrchestratorPrompt).toContain("source_role: worker");
  });

  it("first orchestrator turn references current run cost and uncapped candidates", async () => {
    const initialCheckpoint = createInitialCheckpoint(makeDef());
    const log = new InMemoryRecordLog();
    const host = new StubHost({
      runId: initialCheckpoint.run_id,
      log,
      steps: [{ kind: "emit_handoff", target_role: "worker", reason: "plan ready" }],
    });

    // Spy on spawnRole by wrapping host.spawnRole to capture the
    // returned RoleSession. The StubHost already returns one with a
    // prompts array; we just need to surface it.
    const orchestratorPrompts: string[] = [];
    const origSpawn = host.spawnRole.bind(host);
    host.spawnRole = async (role, opts) => {
      const session = await origSpawn(role, opts);
      // After prompt, capture. We push after every prompt call.
      const origPrompt = session.prompt.bind(session);
      session.prompt = async (text) => {
        if (role === "orchestrator") {
          orchestratorPrompts.push(text);
        }
        await origPrompt(text);
      };
      return session;
    };

    const result = await runLoop({
      def: makeDef(),
      initialCheckpoint,
      host,
      initialGoal: "do the thing",
    });

    expect(result.exitReason).toBe("session_failed"); // script only has 1 step, no orch-handoff-back
    expect(orchestratorPrompts).toHaveLength(1);

    const seed = orchestratorPrompts[0];
    if (!seed) throw new Error("expected first orchestrator prompt");
    // §8.4 fields: run_id, goal, current_role, run_cost_to_date,
    // run_cost_cap, visit_history (empty), per_role_cost (empty),
    // next_candidates (the worker).
    expect(seed).toContain("[run memory]");
    expect(seed).toContain(`run_id: ${initialCheckpoint.run_id}`);
    expect(seed).toContain("goal: do the thing");
    expect(seed).toContain("current_role: orchestrator");
    expect(seed).toContain("run_cost_to_date: $0.0000");
    expect(seed).toContain("run_cost_cap: uncapped");
    expect(seed).toContain("Available workers (visit-capped AND run-budget-uncapped): worker.");
    expect(seed).toContain("(no sessions yet)");
    expect(seed).toContain("(no role cost yet)");
    // §8.4 last_message: no prior transition on the first orchestrator turn.
    expect(seed).toContain("last_message:");
    expect(seed).toContain("(no prior worker message \u2014 this is the first orchestrator turn)");
    expect(seed).toContain("Continue your orchestration");
  });

  it("second orchestrator turn reflects the new visit_history entry after a worker visit", async () => {
    const initialCheckpoint = createInitialCheckpoint(makeDef());
    const log = new InMemoryRecordLog();
    const host = new StubHost({
      runId: initialCheckpoint.run_id,
      log,
      // 3 visits: orchestrator → worker, worker → orchestrator, orchestrator → end.
      steps: [
        { kind: "emit_handoff", target_role: "worker", reason: "plan ready" },
        { kind: "emit_handoff", target_role: "orchestrator", reason: "worker done" },
        { kind: "emit_end", reason: "all done" },
      ],
    });

    const orchestratorPrompts: string[] = [];
    const origSpawn = host.spawnRole.bind(host);
    host.spawnRole = async (role, opts) => {
      const session = await origSpawn(role, opts);
      const origPrompt = session.prompt.bind(session);
      session.prompt = async (text) => {
        if (role === "orchestrator") {
          orchestratorPrompts.push(text);
        }
        await origPrompt(text);
      };
      return session;
    };

    const result = await runLoop({
      def: makeDef(),
      initialCheckpoint,
      host,
      initialGoal: "do the thing",
    });

    expect(result.exitReason).toBe("done");
    // Two orchestrator visits (initial + after worker handoff back).
    expect(orchestratorPrompts).toHaveLength(2);

    const secondSeed = orchestratorPrompts[1];
    if (!secondSeed) throw new Error("expected second orchestrator prompt");
    // After the worker visit, the run-memory records the worker's
    // session_ended in visit_history. The second orchestrator turn
    // sees this entry.
    expect(secondSeed).toContain("visit_history:");
    expect(secondSeed).toMatch(/worker \(visit 1, session_ended/);
    expect(secondSeed).toContain("per_role_cost:");
    expect(secondSeed).toMatch(/worker: \$0\.0000/);
    // current_role is still "orchestrator" — the orchestrator's
    // second visit hasn't transitioned yet.
    expect(secondSeed).toContain("current_role: orchestrator");
    // §8.4 last_message: the worker's handoff reason is delivered to
    // the second orchestrator turn so it can act on the worker's status
    // without reading transcripts.
    expect(secondSeed).toContain("last_message:");
    expect(secondSeed).toContain("from: worker");
    expect(secondSeed).toContain("text: worker done");
    // Worker is still a candidate (visit 1 of max 3).
    expect(secondSeed).toContain("Available workers");
  });

  it("single-writer rule: worker sessions do NOT receive the run-memory artifact", async () => {
    const initialCheckpoint = createInitialCheckpoint(makeDef());
    const log = new InMemoryRecordLog();
    const host = new StubHost({
      runId: initialCheckpoint.run_id,
      log,
      steps: [
        { kind: "emit_handoff", target_role: "worker", reason: "plan ready" },
        { kind: "emit_handoff", target_role: "orchestrator", reason: "worker done" },
        { kind: "emit_end", reason: "all done" },
      ],
    });

    const workerPrompts: string[] = [];
    const orchestratorPrompts: string[] = [];
    const origSpawn = host.spawnRole.bind(host);
    host.spawnRole = async (role, opts) => {
      const session = await origSpawn(role, opts);
      const origPrompt = session.prompt.bind(session);
      session.prompt = async (text) => {
        if (role === "worker") {
          workerPrompts.push(text);
        } else if (role === "orchestrator") {
          orchestratorPrompts.push(text);
        }
        await origPrompt(text);
      };
      return session;
    };

    const result = await runLoop({
      def: makeDef(),
      initialCheckpoint,
      host,
      initialGoal: "do the thing",
    });

    expect(result.exitReason).toBe("done");
    expect(workerPrompts).toHaveLength(1);
    expect(orchestratorPrompts).toHaveLength(2);

    // The worker's prompt is the handoff payload from Task 15
    // (formatHandoffSeed), NOT the run-memory artifact.
    const workerPrompt = workerPrompts[0];
    if (!workerPrompt) throw new Error("expected worker prompt");
    expect(workerPrompt).not.toContain("[run memory]");
    expect(workerPrompt).toContain("[handoff → worker]");
    expect(workerPrompt).toContain("plan ready");

    // Sanity: the orchestrator's prompts DO contain the run-memory
    // marker.
    expect(orchestratorPrompts[0]).toContain("[run memory]");
    expect(orchestratorPrompts[1]).toContain("[run memory]");
  });

  it("runCostCap option flows through to the run-memory seed", async () => {
    const initialCheckpoint = createInitialCheckpoint(makeDef());
    const log = new InMemoryRecordLog();
    const host = new StubHost({
      runId: initialCheckpoint.run_id,
      log,
      steps: [{ kind: "emit_handoff", target_role: "worker" }],
    });

    const orchestratorPrompts: string[] = [];
    const origSpawn = host.spawnRole.bind(host);
    host.spawnRole = async (role, opts) => {
      const session = await origSpawn(role, opts);
      const origPrompt = session.prompt.bind(session);
      session.prompt = async (text) => {
        if (role === "orchestrator") {
          orchestratorPrompts.push(text);
        }
        await origPrompt(text);
      };
      return session;
    };

    await runLoop({
      def: makeDef(),
      initialCheckpoint,
      host,
      initialGoal: "cap test",
      runCostCap: 5.0,
    });

    expect(orchestratorPrompts[0]).toContain("run_cost_cap: $5.0000");
    expect(orchestratorPrompts[0]).toContain("$5.0000 remaining");
  });
});
