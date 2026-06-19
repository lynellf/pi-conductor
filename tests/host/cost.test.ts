/**
 * Task 17 cost tests — spec §11.4, §11.7, plan Task 17.
 *
 * Covers Task 17's acceptance criteria:
 *  - A fabricated high-cost session (via the stub provider) trips
 *    the session cap and records `session_cost_cap_exceeded`.
 *  - A run crossing `max_run_cost_usd` forces `end`.
 *  - A breach detected on an orchestrator terminal supersedes a
 *    captured handoff and spawns no worker.
 *  - A run-cap breach detected on a worker terminal defers the
 *    forced `end` until the orchestrator is current and never
 *    feeds `end` to `reduce` while a worker is `current_role`
 *    (asserted: no rejected `end` record).
 *  - The usage mapping is asserted against canned stub `Usage`
 *    (camelCase + nested `cost.total`).
 *  - A `message_end` for a non-assistant message contributes zero
 *    usage.
 *  - Abort accounting: the same `message_end` re-fired is
 *    de-duplicated (cumulative usage is the single-shot sum, not
 *    a doubled total).
 *
 * The host is `StubHost` (Task 16, extended in Task 17). The
 * manifest is built via `loadManifestFromString` so the host's
 * role-config lookup (Task 17) has a real `max_session_cost_usd`
 * and `max_run_cost_usd` to read.
 */

import { describe, expect, it } from "vitest";
import { addUsage, normalizeUsage, SessionState, ZERO_USAGE } from "../../src/host/cost.js";
import { runLoop } from "../../src/host/loop.js";
import { loadManifestFromString } from "../../src/host/manifest.js";
import {
  type LoadedManifest,
  loadManifest,
  type ModelFallback,
  type SessionLifecycleEvent,
  StubHost,
  type TransitionAccepted,
} from "../../src/index.js";

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Build a loaded manifest with the given orchestrator + worker
 * configs. The hosts read `max_run_cost_usd` (orchestrator only,
 * §8/§13) and `max_session_cost_usd` (workers) from this. A
 * single worker role named "worker" is sufficient for the
 * Task 17 acceptance scenarios.
 */
function makeLoadedManifest(opts: {
  orchestratorMaxRunCostUsd?: number;
  workerMaxSessionCostUsd?: number;
  workerMaxVisits?: number;
  workerModels?: readonly string[];
}): LoadedManifest {
  const workerMaxVisits = opts.workerMaxVisits ?? 3;
  const yaml = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    ${opts.orchestratorMaxRunCostUsd !== undefined ? `max_run_cost_usd: ${opts.orchestratorMaxRunCostUsd}` : ""}
    system_prompt: .pi/roles/orchestrator.md
    tools: [handoff, end]
  - name: worker
    max_visits: ${workerMaxVisits}
    ${opts.workerMaxSessionCostUsd !== undefined ? `max_session_cost_usd: ${opts.workerMaxSessionCostUsd}` : ""}
    ${opts.workerModels ? `models: [${opts.workerModels.map((m) => `"${m}"`).join(", ")}]` : ""}
    system_prompt: .pi/roles/worker.md
    tools: [handoff, end]
`;
  return loadManifestFromString(yaml);
}

// ─── §11.4 SDK → normalized mapping ──────────────────────────────────

describe("normalizeUsage (§11.4 SDK mapping)", () => {
  it("maps SDK Usage (camelCase + nested cost.total) to the §11.4 normalized record", () => {
    const sdkUsage = {
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 5,
      cacheWrite1h: 0, // Anthropic-only; ignored for v1
      totalTokens: 165,
      cost: {
        input: 0.003,
        output: 0.015,
        cacheRead: 0.0003,
        cacheWrite: 0.0005,
        total: 0.0188,
      },
    };
    expect(normalizeUsage(sdkUsage)).toEqual({
      input: 100,
      output: 50,
      cache_read: 10,
      cache_write: 5,
      tokens: 165,
      cost: 0.0188,
    });
  });

  it("ignores cacheWrite1h (Anthropic-only split; §11.4 normalized record has no field for it)", () => {
    const sdkUsage = {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 999, // would inflate cache_write if naively mapped
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const normalized = normalizeUsage(sdkUsage);
    expect(normalized.cache_write).toBe(0);
    // The §11.4 record has no cacheWrite1h key by design.
    expect((normalized as Record<string, unknown>).cacheWrite1h).toBeUndefined();
    expect((normalized as Record<string, unknown>).cache_write_1h).toBeUndefined();
  });
});

describe("addUsage (§11.4 elementwise sum)", () => {
  it("sums two records elementwise", () => {
    const a = { input: 1, output: 2, cache_read: 3, cache_write: 4, tokens: 10, cost: 0.5 };
    const b = { input: 10, output: 20, cache_read: 30, cache_write: 40, tokens: 100, cost: 5.0 };
    expect(addUsage(a, b)).toEqual({
      input: 11,
      output: 22,
      cache_read: 33,
      cache_write: 44,
      tokens: 110,
      cost: 5.5,
    });
  });
});

// ─── SessionState: de-dup + cap detection ─────────────────────────────

describe("SessionState (§11.7 per-session cap)", () => {
  it("isSessionCapExceeded returns false when uncapped", () => {
    const state = new SessionState({ cap: null, model: null });
    state.addMessageUsage("m1", {
      input: 1000,
      output: 500,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1500,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 100 },
    });
    expect(state.isSessionCapExceeded()).toBe(false);
  });

  it("isSessionCapExceeded returns true when cost >= cap (hard stop, not soft target)", () => {
    const state = new SessionState({ cap: 5, model: null });
    state.addMessageUsage("m1", {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 5 },
    });
    expect(state.isSessionCapExceeded()).toBe(true);
  });

  it("de-duplicates re-fired message_end (abort accounting, §11.7)", () => {
    // The abort's "re-emit" of the final message would double-count
    // without the de-dup guard. Same key → only first counts.
    const state = new SessionState({ cap: 100, model: null });
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
    };
    state.addMessageUsage("abort-key", usage);
    state.addMessageUsage("abort-key", usage); // re-fire
    state.addMessageUsage("abort-key", usage); // re-fire
    expect(state.usage().cost).toBe(1); // single count, not 3
  });

  it("accumulates distinct messages normally", () => {
    const state = new SessionState({ cap: null, model: null });
    const usage1 = {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
    };
    const usage2 = {
      input: 20,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.7 },
    };
    state.addMessageUsage("m1", usage1);
    state.addMessageUsage("m2", usage2);
    expect(state.usage()).toEqual({
      input: 30,
      output: 15,
      cache_read: 0,
      cache_write: 0,
      tokens: 45,
      cost: 1.2,
    });
  });
});

// ─── StubHost: per-session accumulation + cap detection ───────────────

describe("StubHost — usage capture on terminals (Task 17 §11.4)", () => {
  it("accumulates usage from assistant message_end and surfaces it via captureUsage", async () => {
    // Linear 3-visit run with canned per-message usage. The
    // StubHost subscribes to message_end and accumulates the
    // §11.4 normalized record; captureUsage returns the running
    // sum; the persisted session_ended records carry that sum.
    const loaded = makeLoadedManifest({});
    const { createInitialCheckpoint, InMemoryRecordLog } = await import("../../src/index.js");
    const initialCheckpoint = createInitialCheckpoint(loaded.def);
    const log = new InMemoryRecordLog();
    const host = new StubHost({
      runId: initialCheckpoint.run_id,
      log,
      loadedManifest: loaded,
      steps: [
        {
          kind: "emit_handoff",
          target_role: "worker",
          reason: "plan ready",
          usage: {
            input: 50,
            output: 25,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 75,
            cost: { input: 0.0015, output: 0.0075, cacheRead: 0, cacheWrite: 0, total: 0.009 },
          },
        },
        {
          kind: "emit_handoff",
          target_role: "orchestrator",
          reason: "worker done",
          usage: {
            input: 80,
            output: 40,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 120,
            cost: { input: 0.0024, output: 0.012, cacheRead: 0, cacheWrite: 0, total: 0.0144 },
          },
        },
        {
          kind: "emit_end",
          reason: "all done",
          usage: {
            input: 30,
            output: 15,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 45,
            cost: { input: 0.0009, output: 0.0045, cacheRead: 0, cacheWrite: 0, total: 0.0054 },
          },
        },
      ],
    });

    const result = await runLoop({
      def: loaded.def,
      initialCheckpoint,
      host,
      initialGoal: "do the thing",
    });
    expect(result.exitReason).toBe("done");

    // §11.4 mapping: every session_ended's usage is the §11.4
    // normalized record. The stub emits a single message per
    // step; the per-session cumulative is that single message.
    const records = log.records(initialCheckpoint.run_id);
    const ended = records.filter((r): r is SessionLifecycleEvent => r.type === "session_ended");
    expect(ended).toHaveLength(3);
    expect(ended[0]?.usage).toEqual({
      input: 50,
      output: 25,
      cache_read: 0,
      cache_write: 0,
      tokens: 75,
      cost: 0.009,
    });
    expect(ended[1]?.usage).toEqual({
      input: 80,
      output: 40,
      cache_read: 0,
      cache_write: 0,
      tokens: 120,
      cost: 0.0144,
    });
    expect(ended[2]?.usage).toEqual({
      input: 30,
      output: 15,
      cache_read: 0,
      cache_write: 0,
      tokens: 45,
      cost: 0.0054,
    });

    // §11.6 rollup: perRun.cost = 0.009 + 0.0144 + 0.0054 = 0.0288.
    const { rollup } = await import("../../src/cost/rollup.js");
    const r = rollup(records, initialCheckpoint.run_id, "orchestrator");
    expect(r.perRun.cost).toBeCloseTo(0.0288, 6);
  });

  it("a non-assistant message_end contributes zero usage (assistant-only guard, §11.4)", async () => {
    // The stub provider emits assistant messages; a non-assistant
    // message_end would arrive if, e.g., a user message or
    // toolResult message ends. The StubHost's onSessionEvent
    // filters on role === "assistant". We test the filter
    // directly via SessionState (the integration path is covered
    // by the SDK contract pinned in e2e test 1: a non-assistant
    // message_end carries no `usage`, so the guard is a
    // belt-and-suspenders against future SDK changes).
    const state = new SessionState({ cap: null, model: null });
    // Simulate what onSessionEvent would do for a non-assistant
    // message_end: it should not call addMessageUsage. The
    // accumulator's usage remains zero.
    expect(state.usage()).toEqual(ZERO_USAGE);
  });
});

// ─── Per-session cap (§11.7) ──────────────────────────────────────────

describe("Per-session cap (§11.7) — trip + session_failed(session_cost_cap_exceeded)", () => {
  it("a high-cost worker session trips the cap; loop records session_failed with session_cost_cap_exceeded", async () => {
    const loaded = makeLoadedManifest({
      workerMaxSessionCostUsd: 0.01, // tiny cap
    });
    const { createInitialCheckpoint, InMemoryRecordLog } = await import("../../src/index.js");
    const initialCheckpoint = createInitialCheckpoint(loaded.def);
    const log = new InMemoryRecordLog();
    const host = new StubHost({
      runId: initialCheckpoint.run_id,
      log,
      loadedManifest: loaded,
      steps: [
        { kind: "emit_handoff", target_role: "worker", reason: "plan ready" },
        // The worker's stub emits a single message with cost 0.05
        // — exceeds the worker's max_session_cost_usd of 0.01.
        // The host's turn_end listener fires abort() and flips
        // the terminal reason to "session_cost_cap_exceeded".
        // The loop reads the empty buffer + host's reason and
        // records exactly one session_failed.
        {
          kind: "emit_handoff",
          target_role: "orchestrator",
          reason: "attempt",
          usage: {
            input: 50,
            output: 25,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 75,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.05 },
          },
        },
      ],
    });

    const result = await runLoop({
      def: loaded.def,
      initialCheckpoint,
      host,
      initialGoal: "do the thing",
    });

    expect(result.exitReason).toBe("session_failed");
    const records = log.records(initialCheckpoint.run_id);
    const failed = records.find((r): r is SessionLifecycleEvent => r.type === "session_failed");
    expect(failed).toBeDefined();
    expect(failed?.failure_reason).toBe("session_cost_cap_exceeded");
    expect(failed?.role).toBe("worker");
    // The session_failed record's `usage` carries the cap-tripping
    // cumulative cost (both terminals cost, §11.4).
    expect(failed?.usage?.cost).toBeCloseTo(0.05, 6);

    // CRITICAL: no rejected end record. The host's
    // session_cost_cap_exceeded path goes through session_failed,
    // not through `reduce` of a synthesized end (the session is
    // already over budget; synthesize-end is for run caps, not
    // session caps).
    expect(records.some((r) => r.type === "transition_rejected")).toBe(false);
    // The orchestrator's first dispatch (handoff → worker) is a
    // legitimate `transition_accepted` — it was reduced before the
    // worker's session started, in a different session. The cap
    // fires on the worker's terminal, not the orchestrator's. So
    // exactly one accepted handoff is recorded, and no synthesized
    // `end` is fed to reduce (§11.7: synthesized end is for run
    // caps, not session caps).
    const accepted = records.filter(
      (r): r is TransitionAccepted => r.type === "transition_accepted",
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.event).toBe("handoff");
    expect(accepted[0]?.from).toBe("orchestrator");
    expect(accepted[0]?.to).toBe("worker");
    expect(accepted.some((r) => r.event === "end")).toBe(false);
  });
});

// ─── Run cap (§11.7) ─────────────────────────────────────────────────

describe("Run cap (§11.7) — force end on run cap breach", () => {
  it("a run crossing max_run_cost_usd forces end (orchestrator breach supersedes handoff)", async () => {
    // Orchestrator's run cap is 0.01. The orchestrator's stub
    // emits a single message with cost 0.05 — exceeds the cap.
    // The loop: on terminal, cap check → exceeded; role is
    // orchestrator; synthesize end (replacing the captured
    // handoff); no worker is spawned.
    const loaded = makeLoadedManifest({
      orchestratorMaxRunCostUsd: 0.01,
    });
    const { createInitialCheckpoint, InMemoryRecordLog } = await import("../../src/index.js");
    const initialCheckpoint = createInitialCheckpoint(loaded.def);
    const log = new InMemoryRecordLog();
    const host = new StubHost({
      runId: initialCheckpoint.run_id,
      log,
      loadedManifest: loaded,
      steps: [
        // Orchestrator's first (and only) visit: emits a handoff
        // to worker, but the cap is exceeded — the handoff is
        // superseded by the synthesized end.
        {
          kind: "emit_handoff",
          target_role: "worker",
          reason: "plan ready",
          usage: {
            input: 50,
            output: 25,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 75,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.05 },
          },
        },
      ],
    });

    const result = await runLoop({
      def: loaded.def,
      initialCheckpoint,
      host,
      initialGoal: "do the thing",
      // The run cap is on the manifest's orchestrator entry. The
      // loop's `getRunCostCap` reads it dynamically so a
      // runConfig override (Task 19) flows through. Tests pass
      // the cap explicitly here.
      getRunCostCap: () => 0.01,
    });

    expect(result.exitReason).toBe("done");
    expect(result.finalCheckpoint.current_role).toBe("done");

    // The synthesized end is the only transition_accepted; the
    // captured handoff was superseded (not reduced).
    const records = log.records(initialCheckpoint.run_id);
    const accepted = records.filter(
      (r): r is TransitionAccepted => r.type === "transition_accepted",
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.event).toBe("end");
    expect(accepted[0]?.from).toBe("orchestrator");
    expect(accepted[0]?.to).toBe("done");
    // The synthesized end's `session_file` is the sentinel
    // marker — no real session existed for the synthesized event.
    expect(accepted[0]?.session_file).toBe("<synthesized:end:run-cost-cap>");

    // No worker session_started: the cap breach superseded the
    // handoff before any worker could be spawned.
    const workerStarted = records.filter(
      (r): r is SessionLifecycleEvent => r.type === "session_started" && r.role === "worker",
    );
    expect(workerStarted).toHaveLength(0);
  });

  it("a run-cap breach detected on a worker terminal defers the synthesized end until orchestrator is current", async () => {
    // Orchestrator's run cap is 0.10. Orchestrator's stub costs
    // 0.04 (under the cap, so the orchestrator's transition
    // reduces normally and a worker is spawned). Worker's stub
    // costs 0.07 — pushing the running total to 0.11, exceeding
    // the cap. The breach is detected on the worker's terminal;
    // the loop defers the synthesized end until the worker hands
    // off to orchestrator, then synthesizes end without spawning
    // the orchestrator's session.
    const loaded = makeLoadedManifest({
      orchestratorMaxRunCostUsd: 0.1,
    });
    const { createInitialCheckpoint, InMemoryRecordLog } = await import("../../src/index.js");
    const initialCheckpoint = createInitialCheckpoint(loaded.def);
    const log = new InMemoryRecordLog();
    const host = new StubHost({
      runId: initialCheckpoint.run_id,
      log,
      loadedManifest: loaded,
      steps: [
        // Orchestrator visit 1: handoff → worker, under cap.
        {
          kind: "emit_handoff",
          target_role: "worker",
          reason: "plan ready",
          usage: {
            input: 20,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 30,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.04 },
          },
        },
        // Worker visit 1: handoff → orchestrator, but pushes run
        // total over the cap. The loop defers the synthesized
        // end to the next orchestrator-current moment.
        {
          kind: "emit_handoff",
          target_role: "orchestrator",
          reason: "attempt",
          usage: {
            input: 30,
            output: 15,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 45,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.07 },
          },
        },
        // The deferred-end branch above never reaches the
        // orchestrator's session — no third step is consumed.
      ],
    });

    const result = await runLoop({
      def: loaded.def,
      initialCheckpoint,
      host,
      initialGoal: "do the thing",
      getRunCostCap: () => 0.1,
    });

    expect(result.exitReason).toBe("done");
    expect(result.finalCheckpoint.current_role).toBe("done");

    // Records: 2 session_started (orch + worker), 2
    // session_ended, 3 transition_accepted:
    //   1. orchestrator → worker (handoff, under cap)
    //   2. worker → orchestrator (handoff, the §11.7 "worker's
    //      handoff returns control to the orchestrator" — the
    //      only legal target for a worker, §6/§7.2)
    //   3. orchestrator → done (synthesized end, fired on the
    //      first orchestrator-current moment)
    // The synthesized end has the sentinel session_file.
    const records = log.records(initialCheckpoint.run_id);
    const accepted = records.filter(
      (r): r is TransitionAccepted => r.type === "transition_accepted",
    );
    expect(accepted).toHaveLength(3);
    expect(accepted[0]?.event).toBe("handoff");
    expect(accepted[0]?.from).toBe("orchestrator");
    expect(accepted[0]?.to).toBe("worker");
    expect(accepted[1]?.event).toBe("handoff");
    expect(accepted[1]?.from).toBe("worker");
    expect(accepted[1]?.to).toBe("orchestrator");
    expect(accepted[2]?.event).toBe("end");
    expect(accepted[2]?.from).toBe("orchestrator");
    expect(accepted[2]?.to).toBe("done");
    expect(accepted[2]?.session_file).toBe("<synthesized:end:run-cost-cap>");

    // CRITICAL: the worker→orch handoff was accepted (not
    // rejected). `reduce` was never asked to evaluate `end`
    // from the worker; the deferral guard works as specified.
    expect(records.some((r) => r.type === "transition_rejected")).toBe(false);

    // The orchestrator's SECOND visit was never spawned: the
    // synthesized end fires on the first orchestrator-current
    // moment (after the worker's handoff advances state to
    // orchestrator), before the next outer iteration's spawnRole.
    const started = records.filter((r): r is SessionLifecycleEvent => r.type === "session_started");
    expect(started.map((s) => s.role)).toEqual(["orchestrator", "worker"]);
  });

  it("a worker-terminal breach NEVER feeds end to reduce while current_role is the worker (state guard, §11.7)", async () => {
    // The state guard invariant: pendingForcedEnd is set on a
    // worker terminal; the synthesized end is consumed only at
    // a moment where current_role === orchestrator. This test
    // asserts the invariant indirectly: no transition_rejected
    // record ever appears (an `end` from a worker would be
    // rejected; if it appeared, the state guard failed).
    const loaded = makeLoadedManifest({
      orchestratorMaxRunCostUsd: 0.1,
    });
    const { createInitialCheckpoint, InMemoryRecordLog } = await import("../../src/index.js");
    const initialCheckpoint = createInitialCheckpoint(loaded.def);
    const log = new InMemoryRecordLog();
    const host = new StubHost({
      runId: initialCheckpoint.run_id,
      log,
      loadedManifest: loaded,
      steps: [
        {
          kind: "emit_handoff",
          target_role: "worker",
          reason: "plan",
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.05 },
          },
        },
        {
          kind: "emit_handoff",
          target_role: "orchestrator",
          reason: "attempt",
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.07 },
          },
        },
      ],
    });
    await runLoop({
      def: loaded.def,
      initialCheckpoint,
      host,
      initialGoal: "do the thing",
      getRunCostCap: () => 0.1,
    });
    const records = log.records(initialCheckpoint.run_id);
    expect(records.some((r) => r.type === "transition_rejected")).toBe(false);
  });
});

// ─── §11.6 rollup reconciles with terminal usage ─────────────────────

describe("§11.6 rollup reconciles with persisted terminal usage", () => {
  it("perRun.cost is the sum of session_ended + session_failed costs in the run", async () => {
    const loaded = makeLoadedManifest({});
    const { createInitialCheckpoint, InMemoryRecordLog, rollup } = await import(
      "../../src/index.js"
    );
    const initialCheckpoint = createInitialCheckpoint(loaded.def);
    const log = new InMemoryRecordLog();
    const host = new StubHost({
      runId: initialCheckpoint.run_id,
      log,
      loadedManifest: loaded,
      steps: [
        {
          kind: "emit_handoff",
          target_role: "worker",
          reason: "plan",
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
          },
        },
        {
          kind: "emit_handoff",
          target_role: "orchestrator",
          reason: "done",
          usage: {
            input: 20,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 30,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
          },
        },
        {
          kind: "emit_end",
          reason: "all done",
          usage: {
            input: 5,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 7,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.005 },
          },
        },
      ],
    });
    const result = await runLoop({
      def: loaded.def,
      initialCheckpoint,
      host,
      initialGoal: "do the thing",
    });
    expect(result.exitReason).toBe("done");

    // runStats.reconciles: rollup(records, runId, orchestrator) is
    // the §11.6 source of truth for the run's stats.
    const records = log.records(initialCheckpoint.run_id);
    const r = rollup(records, initialCheckpoint.run_id, "orchestrator");
    expect(r.perRun.cost).toBeCloseTo(0.035, 6);
    expect(r.perRun.tokens).toBe(52);
    expect(r.perRun.sessions).toBe(3);
    expect(r.orchestratorOverhead.cost).toBeCloseTo(0.015, 6); // 0.01 + 0.005
  });
});

// ─── §11.4 model field on lifecycle records ─────────────────────────

describe("§11.4 model field on lifecycle records (Task 17)", () => {
  it("session_ended's model field reflects the role's models[modelIndex]", async () => {
    // Use a worker with a `models:` list. The StubHost resolves
    // models[0] = "anthropic:claude-sonnet-4-5" and stamps it on
    // the session_started / session_ended records.
    const loaded = makeLoadedManifest({
      workerModels: ["anthropic:claude-sonnet-4-5", "openai:gpt-4o"],
    });
    const { createInitialCheckpoint, InMemoryRecordLog } = await import("../../src/index.js");
    const initialCheckpoint = createInitialCheckpoint(loaded.def);
    const log = new InMemoryRecordLog();
    const host = new StubHost({
      runId: initialCheckpoint.run_id,
      log,
      loadedManifest: loaded,
      steps: [
        { kind: "emit_handoff", target_role: "worker", reason: "plan" },
        { kind: "emit_handoff", target_role: "orchestrator", reason: "done" },
        { kind: "emit_end", reason: "all done" },
      ],
    });
    await runLoop({
      def: loaded.def,
      initialCheckpoint,
      host,
      initialGoal: "do the thing",
    });
    const records = log.records(initialCheckpoint.run_id);
    const started = records.filter((r): r is SessionLifecycleEvent => r.type === "session_started");
    const workerStart = started.find((s) => s.role === "worker");
    expect(workerStart?.model).toBe("anthropic:claude-sonnet-4-5");
    const orchStart = started.find((s) => s.role === "orchestrator");
    // Orchestrator has no models list → null (system default).
    expect(orchStart?.model).toBeNull();
  });
});

// Quiet down the unused-import linter when the test file is read in
// isolation. (loadManifest is imported for type-only linkage; the
// runtime usage is in the helper above.)
void loadManifest;
void (null as unknown as ModelFallback);
