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
import { formatRunMemorySeed } from "../../src/host/run-memory.js";
import {
  buildRunMemory,
  createInitialCheckpoint,
  InMemoryRecordLog,
  type MachineDefinition,
  StubHost,
} from "../../src/index.js";
import type {
  ContinuityLedger,
  ContinuitySeed,
  MaterializeContinuity,
  RenderContinuitySeed,
} from "../../src/persistence/continuity.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

function makeDef(): MachineDefinition {
  return Object.freeze({
    manifest_version: "1",
    orchestrator: "orchestrator",
    workers: Object.freeze(["worker"]),
    max_visits: Object.freeze({ worker: 3 }),
    end_request_roles: null,
    handoff_evidence: null,
  }) as MachineDefinition;
}

describe("Task 16.5 — orchestrator run-memory seed (§8.4)", () => {
  it("surfaces gated end authority and never suggests an illegal end", () => {
    const def: MachineDefinition = { ...makeDef(), end_request_roles: ["worker"] };
    const checkpoint = createInitialCheckpoint(def);
    const blockedSeed = formatRunMemorySeed(
      buildRunMemory(checkpoint, [], def, { goal: "x", runCostCap: null }),
    );
    expect(blockedSeed).toContain("end_request: (none)");
    expect(blockedSeed).toContain("can_end: false");
    expect(blockedSeed).toContain("Do not call end");

    const approvedSeed = formatRunMemorySeed(
      buildRunMemory(
        {
          ...checkpoint,
          end_request: { role: "worker", session_file: "/worker.jsonl" },
        },
        [],
        def,
        { goal: "x", runCostCap: null },
      ),
    );
    expect(approvedSeed).toContain("end_request: role: worker");
    expect(approvedSeed).toContain("can_end: true");
    expect(approvedSeed).toContain("call end only if the goal is complete");
  });

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
                status: "ready",
                objective: "Implement the approved plan.",
                summary: "The planner prepared the implementation work.",
                requested_action: "Implement the plan and report the changed files.",
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
      // Issue #70: keep the SDK extension runner out of the developer's real agent dir.
      agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-stub-host-run-memory-"),
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
      // Issue #70: keep the SDK extension runner out of the developer's real agent dir.
      agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-stub-host-run-memory-"),
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
    expect(seed).toContain("Top-level FSM handoff candidates: worker.");
    expect(seed).toContain("(no sessions yet)");
    expect(seed).toContain("(no role cost yet)");
    // §8.4 last_message: no prior transition on the first orchestrator turn.
    expect(seed).toContain("last_message:");
    expect(seed).toContain("(no prior worker message \u2014 this is the first orchestrator turn)");
    expect(seed).toContain("Continue toward the goal using the permitted routing above");
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
      // Issue #70: keep the SDK extension runner out of the developer's real agent dir.
      agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-stub-host-run-memory-"),
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
    expect(secondSeed).toContain("Top-level FSM handoff candidates: worker.");
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
      // Issue #70: keep the SDK extension runner out of the developer's real agent dir.
      agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-stub-host-run-memory-"),
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
      // Issue #70: keep the SDK extension runner out of the developer's real agent dir.
      agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-stub-host-run-memory-"),
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

  it("distinguishes top-level handoff candidates from delegation availability", () => {
    const def = makeDef();
    const checkpoint = createInitialCheckpoint(def);
    const seed = formatRunMemorySeed(
      buildRunMemory(checkpoint, [], def, { goal: "route work", runCostCap: null }),
    );

    expect(seed).toContain("Top-level FSM handoff candidates: worker.");
    expect(seed).toContain("This list does not determine delegate availability.");
    expect(seed).toContain("If delegate is available in your toolset, consult its interface");
    expect(seed).toContain("Delegate submits child work without changing the active FSM role.");
  });

  it("names the pinned assignment interface without promising availability", () => {
    const seed = formatRunMemorySeed(
      buildRunMemory(createInitialCheckpoint(makeDef()), [], makeDef(), {
        goal: "assign work",
        runCostCap: null,
      }),
      undefined,
      "assignments_v1",
    );

    expect(seed).toContain("Assignment delegation submits one pinned child task");
    expect(seed).toContain("use delegation_control for child status, result, wait, or cancel");
    expect(seed).not.toContain("If delegate is available in your toolset");
  });

  it("explains an empty list when no top-level workers are configured", () => {
    const def: MachineDefinition = {
      ...makeDef(),
      workers: [],
      max_visits: {},
    };
    const seed = formatRunMemorySeed(
      buildRunMemory(createInitialCheckpoint(def), [], def, {
        goal: "coordinate",
        runCostCap: null,
      }),
    );

    expect(seed).toContain("No top-level FSM workers are configured.");
    expect(seed).toContain("An empty handoff list does not mean the goal is complete.");
    expect(seed).not.toContain("all workers are visit-capped or the run budget is exhausted");
  });

  it("does not suggest delegation after the run budget is exhausted", () => {
    const checkpoint = createInitialCheckpoint(makeDef());
    const records = [
      {
        type: "session_ended" as const,
        run_id: checkpoint.run_id,
        role: "worker",
        visit_index: 1,
        state: "worker",
        model: null,
        session_file: "/worker.jsonl",
        parent_session: null,
        usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 1 },
        ts: 0,
      },
    ];
    const seed = formatRunMemorySeed(
      buildRunMemory(checkpoint, records, makeDef(), { goal: "route work", runCostCap: 1 }),
    );

    expect(seed).toContain("Do not use handoff or delegate to continue it.");
    expect(seed).not.toContain("If delegate is available in your toolset");
    expect(seed).toContain("Do not dispatch further work");
    expect(seed).not.toContain("Continue toward the goal");
  });

  it("uses a neutral empty-list explanation when legacy memory has no topology", () => {
    const { configured_workers: _topology, ...legacyMemory } = buildRunMemory(
      {
        ...createInitialCheckpoint(makeDef()),
        visit_count: { worker: 3 },
      },
      [],
      makeDef(),
      { goal: "route work", runCostCap: null },
    );
    const seed = formatRunMemorySeed(legacyMemory);

    expect(seed).toContain("worker topology is unavailable in this legacy memory");
    expect(seed).toContain("An empty handoff list does not mean the goal is complete.");
    expect(seed).not.toContain("All top-level FSM workers are visit-capped.");
  });

  it.each([
    {
      name: "all workers are visit-capped",
      checkpoint: {
        ...createInitialCheckpoint(makeDef()),
        visit_count: { worker: 3 },
      },
      records: [],
      options: { goal: "route work", runCostCap: null },
      expected: "All top-level FSM workers are visit-capped.",
    },
    {
      name: "the run budget is exhausted",
      checkpoint: createInitialCheckpoint(makeDef()),
      records: [
        {
          type: "session_ended" as const,
          run_id: "placeholder",
          role: "worker",
          visit_index: 1,
          state: "worker",
          model: null,
          session_file: "/worker.jsonl",
          parent_session: null,
          usage: {
            input: 0,
            output: 0,
            cache_read: 0,
            cache_write: 0,
            tokens: 0,
            cost: 1,
          },
          ts: 0,
        },
      ],
      options: { goal: "route work", runCostCap: 1 },
      expected: "The run budget is exhausted; no top-level FSM handoff is available.",
    },
    {
      name: "the run is terminal",
      checkpoint: {
        ...createInitialCheckpoint(makeDef()),
        current_role: "done" as const,
      },
      records: [],
      options: { goal: "route work", runCostCap: null },
      expected: "The top-level FSM run is terminal.",
    },
  ])("explains an empty list when $name", ({ checkpoint, records, options, expected }) => {
    const matchingRecords = records.map((record) => ({
      ...record,
      run_id: checkpoint.run_id,
    }));
    const seed = formatRunMemorySeed(
      buildRunMemory(checkpoint, matchingRecords, makeDef(), options),
    );

    expect(seed).toContain(expected);
    if (checkpoint.current_role !== "done") {
      expect(seed).toContain("An empty handoff list does not mean the goal is complete.");
    }
    if (checkpoint.current_role === "done") {
      expect(seed).toContain("Do not call handoff, delegate, or end.");
      expect(seed).not.toContain("gated run has no pending authorized end request");
      expect(seed).not.toContain("Continue toward the goal");
    }
  });
});

// ─── Durable continuity §8 + §11 — bounded seed formatting ──────────────

function emptyLedger(runId: string): ContinuityLedger {
  return Object.freeze({
    run_id: runId,
    generated_at: "2026-09-18T00:00:00.000Z",
    envelopes: Object.freeze([]),
    findings: Object.freeze([]),
    evaluations: Object.freeze([]),
    open_questions: Object.freeze([]),
    next_steps: Object.freeze([]),
    evidence_resolutions: Object.freeze([]),
    okf_candidates: Object.freeze([]),
    counts: Object.freeze({
      envelope_count: 0,
      byte_count: 0,
      active_finding_count: 0,
      superseded_finding_count: 0,
      active_question_count: 0,
      superseded_question_count: 0,
      active_next_step_count: 0,
      superseded_next_step_count: 0,
      okf_candidate_count: 0,
    }),
  }) as ContinuityLedger;
}

function fixedSeed(rendered: string, omitted = 0): ContinuitySeed {
  return Object.freeze({
    schema_version: 1,
    run_id: "run-1",
    budget: Object.freeze({ max_bytes: 32_768, used_bytes: rendered.length }),
    omitted: Object.freeze({ items: omitted, packets: 0 }),
    rendered,
    sections: Object.freeze({
      blocking_questions: Object.freeze([]),
      recipient_next_steps: Object.freeze([]),
      risks_and_decisions: Object.freeze([]),
      other_active_findings: Object.freeze([]),
      evaluations: Object.freeze([]),
      packet_summaries: Object.freeze([]),
    }),
  }) as ContinuitySeed;
}

function policy() {
  return {
    schema_version: 1 as const,
    require_handoff: false,
    require_delegated_result: false,
    seed_max_utf8_bytes: 32_768,
  };
}

describe("formatRunMemorySeed — continuity seed section (spec §8 + §11)", () => {
  it("omits the continuity_seed section when the run memory has no seed (legacy preservation)", () => {
    const def = makeDef();
    const cp = createInitialCheckpoint(def);
    const mem = buildRunMemory(cp, [], def, { goal: "x", runCostCap: null });
    const seed = formatRunMemorySeed(mem);
    expect(seed).not.toContain("continuity_seed:");
  });

  it("includes the bounded seed verbatim when one is materialized (raw prose never duplicated)", () => {
    const def = makeDef();
    const cp = createInitialCheckpoint(def);
    const materializer: MaterializeContinuity = (_records) => emptyLedger(cp.run_id);
    const renderer: RenderContinuitySeed = () => fixedSeed("RAW-CONTINUITY-PROSE-12345", 2);
    const mem = buildRunMemory(cp, [], def, {
      goal: "x",
      runCostCap: null,
      continuityPolicy: policy(),
      materializeContinuity: materializer,
      renderContinuitySeed: renderer,
    });
    const seed = formatRunMemorySeed(mem);
    expect(seed).toContain("continuity_seed:");
    expect(seed).toContain("RAW-CONTINUITY-PROSE-12345");
    expect(seed).toContain("budget: 26/32768 UTF-8 bytes");
    expect(seed).toContain("omitted: 2 item(s), 0 packet(s)");
  });

  it("renders omission counts verbatim from the materializer (no host reformatting)", () => {
    const def = makeDef();
    const cp = createInitialCheckpoint(def);
    const omittedSeed: ContinuitySeed = {
      ...fixedSeed("seed", 0),
      omitted: Object.freeze({ items: 5, packets: 2 }) as ContinuitySeed["omitted"],
    };
    const mem = buildRunMemory(cp, [], def, {
      goal: "x",
      runCostCap: null,
      continuityPolicy: policy(),
      materializeContinuity: () => emptyLedger(cp.run_id),
      renderContinuitySeed: () => omittedSeed,
    });
    const seed = formatRunMemorySeed(mem);
    expect(seed).toContain("omitted: 5 item(s), 2 packet(s)");
  });

  it("produces a byte-stable seed when the same ledger is materialized twice", () => {
    const def = makeDef();
    const cp = createInitialCheckpoint(def);
    const renderer: RenderContinuitySeed = () => fixedSeed("seed-text", 1);
    const materializer: MaterializeContinuity = () => emptyLedger(cp.run_id);
    const first = formatRunMemorySeed(
      buildRunMemory(cp, [], def, {
        goal: "x",
        runCostCap: null,
        continuityPolicy: policy(),
        materializeContinuity: materializer,
        renderContinuitySeed: renderer,
      }),
    );
    const second = formatRunMemorySeed(
      buildRunMemory(cp, [], def, {
        goal: "x",
        runCostCap: null,
        continuityPolicy: policy(),
        materializeContinuity: materializer,
        renderContinuitySeed: renderer,
      }),
    );
    expect(first).toBe(second);
  });

  it("omits the section when the renderer returns null (no continuity in scope)", () => {
    const def = makeDef();
    const cp = createInitialCheckpoint(def);
    const mem = buildRunMemory(cp, [], def, {
      goal: "x",
      runCostCap: null,
      continuityPolicy: policy(),
      materializeContinuity: () => emptyLedger(cp.run_id),
      renderContinuitySeed: () => null as unknown as ContinuitySeed,
    });
    const seed = formatRunMemorySeed(mem);
    expect(seed).not.toContain("continuity_seed:");
  });
});
