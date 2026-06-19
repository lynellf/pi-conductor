/**
 * Task 19 stats + config tests — spec §11.6, §11.8.
 *
 * Covers Task 19's acceptance criteria:
 *  - `runStats` output reconciles with the sum of terminal `usage.cost`
 *    (per-run, per-role, per-model, orchestrator-overhead all reconcile).
 *  - `runStats` includes the ordered `transitionHistory` for every
 *    accepted/rejected transition.
 *  - `runConfig` changes the active cap mid-run (the loop's
 *    `getRunCostCap` reads from the shared container that
 *    `RunHandle.runConfig` writes to).
 *  - A `runConfig` override at or below current `run_cost_to_date`
 *    sets `immediateBreach: true` — the loop's existing run-cap
 *    check + §11.7 `pendingForcedEnd` handle the actual close on
 *    the next terminal.
 *  - A non-positive override throws `RunConfigError`.
 *
 * The `runStats` and `applyRunConfigOverride` functions are pure
 * and tested directly. The `RunHandle.runConfig` wiring is tested
 * by constructing a `RunHandle` with a `ConfigOverrideContainer`
 * and verifying the container is updated. Full integration with
 * the loop is covered by the existing Task 17 run-cap tests
 * (`tests/host/cost.test.ts`) — the `runConfig` just updates the
 * cap, which the loop's run-cap check reads on the next terminal.
 */

import { describe, expect, it } from "vitest";
import type { Checkpoint, MachineDefinition, UsageRecord } from "../../src/core/types.js";
import { applyRunConfigOverride, RunConfigError } from "../../src/host/config.js";
import {
  type ConfigOverrideContainer,
  type RunConfigOverride,
  RunHandle,
  type RunStats,
} from "../../src/host/run-handle.js";
import { runStats, type TransitionRecord } from "../../src/host/stats.js";
import type { PersistedRecord } from "../../src/persistence/log.js";
import { InMemoryRecordLog } from "../../src/persistence/log.js";

// ─── Test fixtures ──────────────────────────────────────────────────────

/** Build a `MachineDefinition` with a single orchestrator role. */
function makeDef(): MachineDefinition {
  return {
    manifest_version: "1",
    orchestrator: "orchestrator",
    workers: [],
    max_visits: {},
  };
}

/** Build a checkpoint snapshot for a run. */
function makeCheckpoint(opts: {
  runId: string;
  currentRole: Checkpoint["current_role"];
  visitCount?: Record<string, number>;
  ts?: number;
}): PersistedRecord {
  return {
    type: "checkpoint_snapshot",
    checkpoint: {
      run_id: opts.runId,
      manifest_version: "1",
      current_role: opts.currentRole,
      visit_count: opts.visitCount ?? {},
      active_role_session: null,
      updated_at: opts.ts ?? Date.now(),
    },
  };
}

/** Build a `session_ended` lifecycle record. */
function makeSessionEnded(opts: {
  runId: string;
  role: string;
  model: string | null;
  usage: UsageRecord;
  ts?: number;
}): PersistedRecord {
  return {
    type: "session_ended",
    run_id: opts.runId,
    role: opts.role as never,
    visit_index: 1,
    state: opts.role as never,
    model: opts.model,
    session_file: `/tmp/${opts.role}-${opts.runId}.jsonl`,
    parent_session: null,
    usage: opts.usage,
    ts: opts.ts ?? Date.now(),
  };
}

/** Build a `session_failed` lifecycle record. */
function makeSessionFailed(opts: {
  runId: string;
  role: string;
  model: string | null;
  usage: UsageRecord;
  failureReason: string;
  ts?: number;
}): PersistedRecord {
  return {
    type: "session_failed",
    run_id: opts.runId,
    role: opts.role as never,
    visit_index: 1,
    state: opts.role as never,
    model: opts.model,
    session_file: `/tmp/${opts.role}-${opts.runId}.jsonl`,
    parent_session: null,
    usage: opts.usage,
    failure_reason: opts.failureReason,
    ts: opts.ts ?? Date.now(),
  };
}

/** Build a `transition_accepted` record. */
function makeTransitionAccepted(opts: {
  runId: string;
  from: string;
  to: string;
  event: "handoff" | "end";
  targetRole: string | null;
  role: string;
  ts?: number;
}): PersistedRecord {
  return {
    type: "transition_accepted",
    run_id: opts.runId,
    from: opts.from as never,
    to: opts.to as never,
    event: opts.event,
    target_role: opts.targetRole as never,
    role: opts.role as never,
    suggests_next: null,
    payload_summary: { kind: "none" },
    guard: null,
    effect: [],
    session_file: "/tmp/test.jsonl",
    ts: opts.ts ?? Date.now(),
  };
}

// ─── runStats: cost reconciliation (§11.6) ─────────────────────────────

describe("runStats (§11.6) — perRun.cost reconciles with terminal usage.cost", () => {
  it("sums session_ended and session_failed usage.cost into perRun.cost", () => {
    const runId = "r1";
    const def = makeDef();
    const records: PersistedRecord[] = [
      makeCheckpoint({ runId, currentRole: "orchestrator" }),
      makeSessionEnded({
        runId,
        role: "orchestrator",
        model: "stub:primary",
        usage: { input: 10, output: 5, cache_read: 0, cache_write: 0, tokens: 15, cost: 0.5 },
      }),
      makeSessionEnded({
        runId,
        role: "worker",
        model: "stub:primary",
        usage: { input: 20, output: 10, cache_read: 0, cache_write: 0, tokens: 30, cost: 1.0 },
      }),
      makeSessionFailed({
        runId,
        role: "worker",
        model: "stub:fallback",
        usage: { input: 5, output: 2, cache_read: 0, cache_write: 0, tokens: 7, cost: 0.25 },
        failureReason: "model_error",
      }),
    ];
    const stats = runStats(records, runId, def, "session_failed");
    // 0.5 + 1.0 + 0.25 = 1.75
    expect(stats.costRollup.perRun.cost).toBeCloseTo(1.75, 6);
    // 15 + 30 + 7 = 52
    expect(stats.costRollup.perRun.tokens).toBe(52);
    expect(stats.costRollup.perRun.sessions).toBe(3);
  });

  it("perRole cost sums across all visits for that role", () => {
    const runId = "r1";
    const def = makeDef();
    const records: PersistedRecord[] = [
      makeCheckpoint({ runId, currentRole: "orchestrator" }),
      makeSessionEnded({
        runId,
        role: "orchestrator",
        model: "stub:primary",
        usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0.3 },
      }),
      makeSessionEnded({
        runId,
        role: "orchestrator",
        model: "stub:primary",
        usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0.2 },
      }),
      makeSessionEnded({
        runId,
        role: "worker",
        model: "stub:primary",
        usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0.8 },
      }),
    ];
    const stats = runStats(records, runId, def, "done");
    expect(stats.costRollup.perRole.orchestrator?.cost).toBeCloseTo(0.5, 6);
    expect(stats.costRollup.perRole.worker?.cost).toBeCloseTo(0.8, 6);
  });

  it("perModel cost reveals load split when a role has fallbacks", () => {
    const runId = "r1";
    const def = makeDef();
    const records: PersistedRecord[] = [
      makeCheckpoint({ runId, currentRole: "orchestrator" }),
      makeSessionEnded({
        runId,
        role: "worker",
        model: "stub:primary",
        usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0.6 },
      }),
      makeSessionEnded({
        runId,
        role: "worker",
        model: "stub:fallback",
        usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0.4 },
      }),
    ];
    const stats = runStats(records, runId, def, "done");
    expect(stats.costRollup.perModel["stub:primary"]?.cost).toBeCloseTo(0.6, 6);
    expect(stats.costRollup.perModel["stub:fallback"]?.cost).toBeCloseTo(0.4, 6);
  });

  it("orchestratorOverhead equals perRole[orchestrator] (same numbers, isolated label)", () => {
    const runId = "r1";
    const def = makeDef();
    const records: PersistedRecord[] = [
      makeCheckpoint({ runId, currentRole: "orchestrator" }),
      makeSessionEnded({
        runId,
        role: "orchestrator",
        model: "stub:primary",
        usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0.25 },
      }),
      makeSessionEnded({
        runId,
        role: "worker",
        model: "stub:primary",
        usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0.75 },
      }),
    ];
    const stats = runStats(records, runId, def, "done");
    expect(stats.costRollup.orchestratorOverhead.cost).toBeCloseTo(0.25, 6);
    expect(stats.costRollup.orchestratorOverhead.cost).toBe(
      stats.costRollup.perRole.orchestrator?.cost ?? -1,
    );
  });

  it("does NOT synthesize a per-run cache hit rate (§11.6 cache caveat)", () => {
    // The rollup exposes raw cache_read / cache_write token sums per
    // dimension. A "per-run hit rate" is a per-session ratio and is
    // not exposed (provider-dependent across sessions).
    const runId = "r1";
    const def = makeDef();
    const records: PersistedRecord[] = [
      makeCheckpoint({ runId, currentRole: "orchestrator" }),
      makeSessionEnded({
        runId,
        role: "worker",
        model: "stub:primary",
        usage: { input: 0, output: 0, cache_read: 100, cache_write: 50, tokens: 150, cost: 1.0 },
      }),
    ];
    const stats = runStats(records, runId, def, "done");
    expect(stats.costRollup.perRun.cache_read).toBe(100);
    expect(stats.costRollup.perRun.cache_write).toBe(50);
    // No synthesized hit rate field — cache caveat §11.6.
    const rollup = stats.costRollup.perRun as Record<string, unknown>;
    expect(rollup.hit_rate).toBeUndefined();
    expect(rollup.cache_hit_rate).toBeUndefined();
  });
});

// ─── runStats: transition history ──────────────────────────────────────

describe("runStats (§11.6) — transitionHistory covers every accepted/rejected transition", () => {
  it("includes all accepted transitions in append order", () => {
    const runId = "r1";
    const def = makeDef();
    const records: PersistedRecord[] = [
      makeCheckpoint({ runId, currentRole: "orchestrator" }),
      makeTransitionAccepted({
        runId,
        from: "orchestrator",
        to: "worker",
        event: "handoff",
        targetRole: "worker",
        role: "orchestrator",
        ts: 100,
      }),
      makeTransitionAccepted({
        runId,
        from: "worker",
        to: "orchestrator",
        event: "handoff",
        targetRole: "orchestrator",
        role: "worker",
        ts: 200,
      }),
      makeTransitionAccepted({
        runId,
        from: "orchestrator",
        to: "done",
        event: "end",
        targetRole: null,
        role: "orchestrator",
        ts: 300,
      }),
    ];
    const stats = runStats(records, runId, def, "done");
    expect(stats.transitionHistory).toHaveLength(3);
    expect(stats.transitionHistory[0]?.event).toBe("handoff");
    expect(stats.transitionHistory[0]?.from).toBe("orchestrator");
    expect(stats.transitionHistory[0]?.to).toBe("worker");
    expect(stats.transitionHistory[1]?.event).toBe("handoff");
    expect(stats.transitionHistory[1]?.from).toBe("worker");
    expect(stats.transitionHistory[1]?.to).toBe("orchestrator");
    expect(stats.transitionHistory[2]?.event).toBe("end");
    expect(stats.transitionHistory[2]?.from).toBe("orchestrator");
    expect(stats.transitionHistory[2]?.to).toBe("done");
  });

  it("includes rejected transitions with the unchanged state", () => {
    const runId = "r1";
    const def = makeDef();
    const records: PersistedRecord[] = [
      makeCheckpoint({ runId, currentRole: "orchestrator" }),
      {
        type: "transition_rejected",
        run_id: runId,
        state: "orchestrator",
        event: "handoff",
        target_role: "unknown",
        reason: "illegal_event",
        legal_targets: { handoff: ["worker"], end: true },
        role: "orchestrator",
        session_file: "/tmp/test.jsonl",
        ts: 100,
      },
    ];
    const stats = runStats(records, runId, def, "running");
    expect(stats.transitionHistory).toHaveLength(1);
    const r = stats.transitionHistory[0] as TransitionRecord;
    expect(r.type).toBe("transition_rejected");
    expect(r.from).toBe("orchestrator");
    expect(r.to).toBe("orchestrator"); // unchanged state
  });

  it("filters out records from other run_ids", () => {
    const runId = "r1";
    const def = makeDef();
    const records: PersistedRecord[] = [
      makeCheckpoint({ runId, currentRole: "orchestrator" }),
      makeTransitionAccepted({
        runId: "r1",
        from: "orchestrator",
        to: "done",
        event: "end",
        targetRole: null,
        role: "orchestrator",
        ts: 100,
      }),
      makeTransitionAccepted({
        runId: "r2",
        from: "orchestrator",
        to: "done",
        event: "end",
        targetRole: null,
        role: "orchestrator",
        ts: 200,
      }),
    ];
    const stats = runStats(records, runId, def, "done");
    expect(stats.transitionHistory).toHaveLength(1);
  });
});

// ─── runStats: state and exitReason ─────────────────────────────────────

describe("runStats (§11.8) — state and exitReason are distinct fields", () => {
  it("state reflects the latest checkpoint's current_role", () => {
    const runId = "r1";
    const def = makeDef();
    const records: PersistedRecord[] = [
      makeCheckpoint({ runId, currentRole: "orchestrator" }),
      makeCheckpoint({ runId, currentRole: "worker", ts: 100 }),
    ];
    const stats = runStats(records, runId, def, "running");
    expect(stats.state).toBe("worker");
    expect(stats.latestCheckpoint?.current_role).toBe("worker");
  });

  it("state is 'done' when the latest checkpoint reaches done", () => {
    const runId = "r1";
    const def = makeDef();
    const records: PersistedRecord[] = [
      makeCheckpoint({ runId, currentRole: "orchestrator" }),
      makeCheckpoint({ runId, currentRole: "done", ts: 100 }),
    ];
    const stats = runStats(records, runId, def, "done");
    expect(stats.state).toBe("done");
    expect(stats.exitReason).toBe("done");
  });

  it("exitReason is passed through from the caller (not derived from records)", () => {
    const runId = "r1";
    const def = makeDef();
    const records: PersistedRecord[] = [makeCheckpoint({ runId, currentRole: "worker" })];
    // The `aborted` exitReason is host state — the records don't
    // tell us the run was aborted, only that the caller knows.
    const stats = runStats(records, runId, def, "aborted");
    expect(stats.exitReason).toBe("aborted");
    expect(stats.state).toBe("worker");
  });
});

// ─── applyRunConfigOverride: validation ─────────────────────────────────

describe("applyRunConfigOverride (§11.8) — non-positive override throws RunConfigError", () => {
  it("throws when maxRunCostUsd is undefined", () => {
    expect(() => applyRunConfigOverride({ runCostSoFar: 0 }, {} as RunConfigOverride)).toThrow(
      RunConfigError,
    );
  });

  it("throws when maxRunCostUsd is zero", () => {
    expect(() => applyRunConfigOverride({ runCostSoFar: 0 }, { maxRunCostUsd: 0 })).toThrow(
      RunConfigError,
    );
  });

  it("throws when maxRunCostUsd is negative", () => {
    expect(() => applyRunConfigOverride({ runCostSoFar: 0 }, { maxRunCostUsd: -1 })).toThrow(
      RunConfigError,
    );
  });

  it("throws when maxRunCostUsd is not a finite number", () => {
    expect(() =>
      applyRunConfigOverride({ runCostSoFar: 0 }, { maxRunCostUsd: Number.NaN }),
    ).toThrow(RunConfigError);
    expect(() =>
      applyRunConfigOverride({ runCostSoFar: 0 }, { maxRunCostUsd: Number.POSITIVE_INFINITY }),
    ).toThrow(RunConfigError);
  });

  it("accepts a positive override and returns newCap + immediateBreach=false when above current spend", () => {
    const result = applyRunConfigOverride({ runCostSoFar: 0.5 }, { maxRunCostUsd: 5 });
    expect(result.newCap).toBe(5);
    expect(result.immediateBreach).toBe(false);
  });

  it("accepts a positive override above current spend (raising the cap is always allowed)", () => {
    const result = applyRunConfigOverride({ runCostSoFar: 10 }, { maxRunCostUsd: 50 });
    expect(result.newCap).toBe(50);
    expect(result.immediateBreach).toBe(false);
  });
});

// ─── applyRunConfigOverride: lowering edge case (§11.8) ──────────────────

describe("applyRunConfigOverride (§11.8) — lowering edge case sets immediateBreach", () => {
  it("immediateBreach is true when override equals current spend", () => {
    const result = applyRunConfigOverride({ runCostSoFar: 5 }, { maxRunCostUsd: 5 });
    expect(result.newCap).toBe(5);
    expect(result.immediateBreach).toBe(true);
  });

  it("immediateBreach is true when override is below current spend", () => {
    const result = applyRunConfigOverride({ runCostSoFar: 5 }, { maxRunCostUsd: 3 });
    expect(result.newCap).toBe(3);
    expect(result.immediateBreach).toBe(true);
  });

  it("immediateBreach is false when override is just above current spend", () => {
    const result = applyRunConfigOverride({ runCostSoFar: 5 }, { maxRunCostUsd: 5.01 });
    expect(result.immediateBreach).toBe(false);
  });

  it("immediateBreach is false when current spend is zero (any positive override is above zero)", () => {
    const result = applyRunConfigOverride({ runCostSoFar: 0 }, { maxRunCostUsd: 0.01 });
    expect(result.immediateBreach).toBe(false);
  });
});

// ─── RunHandle.runConfig: container wiring ─────────────────────────────

describe("RunHandle.runConfig (§11.8) — updates the shared configOverride container", () => {
  /** Build a `RunHandle` directly (no file-backed log) for the wiring test. */
  function makeHandle(): {
    handle: RunHandle;
    container: ConfigOverrideContainer;
  } {
    const container: ConfigOverrideContainer = { current: {} };
    const handle = new RunHandle({
      runId: "r1",
      def: makeDef(),
      log: new InMemoryRecordLog(),
      configOverrideContainer: container,
      completionPromise: new Promise(() => {
        // never resolves — the test doesn't await `completion()`.
      }),
    });
    return { handle, container };
  }

  it("runConfig(override) writes the new cap to the shared container", () => {
    const { handle, container } = makeHandle();
    handle.runConfig({ maxRunCostUsd: 10 });
    expect(container.current).toEqual({ maxRunCostUsd: 10 });
  });

  it("currentConfigOverride() reflects the latest override", () => {
    const { handle } = makeHandle();
    expect(handle.currentConfigOverride()).toBeNull();
    handle.runConfig({ maxRunCostUsd: 5 });
    expect(handle.currentConfigOverride()).toEqual({ maxRunCostUsd: 5 });
    handle.runConfig({ maxRunCostUsd: 50 });
    expect(handle.currentConfigOverride()).toEqual({ maxRunCostUsd: 50 });
  });

  it("runConfig throws RunConfigError on non-positive override (container unchanged)", () => {
    const { handle, container } = makeHandle();
    handle.runConfig({ maxRunCostUsd: 5 });
    expect(() => handle.runConfig({ maxRunCostUsd: 0 })).toThrow(RunConfigError);
    expect(() => handle.runConfig({ maxRunCostUsd: -1 })).toThrow(RunConfigError);
    // The previous override is preserved — validation is
    // all-or-nothing.
    expect(container.current).toEqual({ maxRunCostUsd: 5 });
  });

  it("lowering override below current spend is accepted (the loop's run-cap check fires on the next terminal)", () => {
    // The RunHandle.runConfig just updates the cap. The loop's
    // run-cap check (Task 17) detects the breach on the next
    // terminal and sets `pendingForcedEnd`. The synthesized end
    // fires on the next orchestrator-current moment. This test
    // verifies the wiring: the override is stored, the cap is
    // lowered, and the container is updated.
    const { handle, container } = makeHandle();
    handle.runConfig({ maxRunCostUsd: 0.01 }); // tiny cap
    expect(container.current).toEqual({ maxRunCostUsd: 0.01 });
  });
});

// ─── recordsCount ───────────────────────────────────────────────────────

describe("runStats — recordsCount filters by run_id", () => {
  it("counts only records for the target run_id (including checkpoint_snapshot via wrapped checkpoint)", () => {
    const runId = "r1";
    const def = makeDef();
    const records: PersistedRecord[] = [
      makeCheckpoint({ runId, currentRole: "orchestrator" }),
      makeSessionEnded({
        runId,
        role: "orchestrator",
        model: null,
        usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 },
      }),
      makeSessionEnded({
        runId: "r2",
        role: "orchestrator",
        model: null,
        usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 },
      }),
    ];
    const stats: RunStats = runStats(records, runId, def, "done");
    expect(stats.recordsCount).toBe(2);
  });
});
