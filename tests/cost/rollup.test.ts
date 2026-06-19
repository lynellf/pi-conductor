/**
 * Tests for `rollup` — spec §11.6.
 *
 * The rollup aggregates persisted records into:
 *  - `perRun` — the headline total (one row)
 *  - `perRole` — totals per role, across all visits (including failed/retried)
 *  - `perModel` — totals per model (workers with fallbacks reveal load split)
 *  - `orchestratorOverhead` — orchestrator cost isolated as overhead
 *
 * Only records with usage contribute. session_started has no usage
 * (§11.4) and is excluded from the cost roll-up.
 *
 * Cache caveat (§11.6): the rollup exposes raw `cache_read` / `cache_write`
 * sums per dimension (NOT a "per-run cache hit rate" — that's provider-
 * dependent and unrepresentative). No `cacheHitRate` field is exposed.
 */

import { describe, expect, it } from "vitest";
import type { SessionLifecycleEvent, UsageRecord } from "../../src/core/types.js";
import { rollup } from "../../src/cost/rollup.js";
import type { PersistedRecord } from "../../src/persistence/log.js";

const RUN_A = "run-a";
const RUN_B = "run-b";

const TS = 1_700_000_000_000;

function mkUsage(
  input: number,
  output: number,
  cache_read: number,
  cache_write: number,
  cost: number,
): UsageRecord {
  return {
    input,
    output,
    cache_read,
    cache_write,
    tokens: input + output + cache_read + cache_write,
    cost,
  };
}

function ended(opts: {
  run_id?: string;
  role: string;
  model: string | null;
  usage: UsageRecord;
  ts?: number;
}): SessionLifecycleEvent {
  return {
    type: "session_ended",
    run_id: opts.run_id ?? RUN_A,
    role: opts.role,
    visit_index: 1,
    state: opts.role,
    model: opts.model,
    session_file: `/sessions/${opts.role}.jsonl`,
    parent_session: null,
    usage: opts.usage,
    ts: opts.ts ?? TS,
  };
}

function failed(opts: {
  run_id?: string;
  role: string;
  model: string | null;
  usage: UsageRecord;
  reason?: string;
  ts?: number;
}): SessionLifecycleEvent {
  return {
    type: "session_failed",
    run_id: opts.run_id ?? RUN_A,
    role: opts.role,
    visit_index: 1,
    state: opts.role,
    model: opts.model,
    session_file: `/sessions/${opts.role}.jsonl`,
    parent_session: null,
    usage: opts.usage,
    failure_reason: opts.reason ?? "model_error",
    ts: opts.ts ?? TS,
  };
}

function started(opts: { role: string; model: string | null }): SessionLifecycleEvent {
  return {
    type: "session_started",
    run_id: RUN_A,
    role: opts.role,
    visit_index: 1,
    state: opts.role,
    model: opts.model,
    session_file: `/sessions/${opts.role}.jsonl`,
    parent_session: null,
    ts: TS,
  };
}

// ─── Empty record set ──────────────────────────────────────────────────

describe("rollup: empty record set", () => {
  it("returns zeros for perRun and empty maps for perRole / perModel", () => {
    const result = rollup([], RUN_A, "orchestrator");
    expect(result.perRun).toEqual({
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
      tokens: 0,
      cost: 0,
      sessions: 0,
    });
    expect(Object.keys(result.perRole)).toHaveLength(0);
    expect(Object.keys(result.perModel)).toHaveLength(0);
    expect(result.orchestratorOverhead.cost).toBe(0);
    expect(result.orchestratorOverhead.sessions).toBe(0);
  });
});

// ─── Single-session rollup ─────────────────────────────────────────────

describe("rollup: single session", () => {
  it("aggregates one ended session into perRun / perRole / perModel", () => {
    const records: PersistedRecord[] = [
      started({ role: "orchestrator", model: "anthropic:claude-sonnet-4-5" }),
      ended({
        role: "orchestrator",
        model: "anthropic:claude-sonnet-4-5",
        usage: mkUsage(100, 50, 30, 10, 1.5),
      }),
    ];
    const result = rollup(records, RUN_A, "orchestrator");
    expect(result.perRun.cost).toBe(1.5);
    expect(result.perRun.tokens).toBe(190);
    expect(result.perRun.sessions).toBe(1);
    expect(result.perRole.orchestrator?.cost).toBe(1.5);
    expect(result.perModel["anthropic:claude-sonnet-4-5"]?.cost).toBe(1.5);
    expect(result.orchestratorOverhead.cost).toBe(1.5);
  });
});

// ─── Multi-session, multi-role, multi-model ────────────────────────────

describe("rollup: multi-session multi-role multi-model", () => {
  it("computes per-dimension totals that match hand-computed sums", () => {
    // Scenario:
    //   orchestrator session 1 (model A): cost 0.40, tokens 1000
    //   orchestrator session 2 (model A): cost 0.60, tokens 1500
    //   implementer session 1 (model B): cost 2.00, tokens 5000
    //   implementer session 2 (model C, fallback): cost 1.50, tokens 3000
    //   reviewer session 1 (model A): cost 0.20, tokens 500
    //   reviewer session 2 FAILED (model B): cost 0.10, tokens 200
    //
    // Hand-computed:
    //   perRun.cost = 0.40 + 0.60 + 2.00 + 1.50 + 0.20 + 0.10 = 4.80
    //   perRun.tokens = 1000 + 1500 + 5000 + 3000 + 500 + 200 = 11200
    //   perRun.sessions = 6 (each terminal counts)
    //   perRole.orchestrator = (1.00 cost, 2500 tokens, 2 sessions)
    //   perRole.implementer = (3.50 cost, 8000 tokens, 2 sessions)
    //   perRole.reviewer = (0.30 cost,  700 tokens, 2 sessions)
    //   perModel.A = 1.20 cost, 3000 tokens, 3 sessions
    //   perModel.B = 2.10 cost, 5200 tokens, 2 sessions
    //   perModel.C = 1.50 cost, 3000 tokens, 1 session
    //   orchestratorOverhead = (1.00 cost, 2500 tokens, 2 sessions)
    const records: PersistedRecord[] = [
      started({ role: "orchestrator", model: "anthropic:claude-sonnet-4-5" }),
      ended({
        role: "orchestrator",
        model: "anthropic:claude-sonnet-4-5",
        usage: mkUsage(300, 200, 400, 100, 0.4),
      }),
      started({ role: "orchestrator", model: "anthropic:claude-sonnet-4-5" }),
      ended({
        role: "orchestrator",
        model: "anthropic:claude-sonnet-4-5",
        usage: mkUsage(500, 300, 600, 100, 0.6),
      }),
      started({ role: "implementer", model: "anthropic:claude-opus-4-5" }),
      ended({
        role: "implementer",
        model: "anthropic:claude-opus-4-5",
        usage: mkUsage(2000, 1000, 1500, 500, 2.0),
      }),
      started({ role: "implementer", model: "openai:gpt-4o" }),
      ended({
        role: "implementer",
        model: "openai:gpt-4o",
        usage: mkUsage(1200, 600, 900, 300, 1.5),
      }),
      started({ role: "reviewer", model: "anthropic:claude-sonnet-4-5" }),
      ended({
        role: "reviewer",
        model: "anthropic:claude-sonnet-4-5",
        usage: mkUsage(200, 100, 150, 50, 0.2),
      }),
      started({ role: "reviewer", model: "anthropic:claude-opus-4-5" }),
      failed({
        role: "reviewer",
        model: "anthropic:claude-opus-4-5",
        usage: mkUsage(100, 50, 30, 20, 0.1),
      }),
    ];
    const result = rollup(records, RUN_A, "orchestrator");
    expect(result.perRun.cost).toBeCloseTo(4.8, 6);
    expect(result.perRun.tokens).toBe(11200);
    expect(result.perRun.sessions).toBe(6);
    expect(result.perRole.orchestrator?.cost).toBeCloseTo(1.0, 6);
    expect(result.perRole.orchestrator?.tokens).toBe(2500);
    expect(result.perRole.orchestrator?.sessions).toBe(2);
    expect(result.perRole.implementer?.cost).toBeCloseTo(3.5, 6);
    expect(result.perRole.implementer?.tokens).toBe(8000);
    expect(result.perRole.implementer?.sessions).toBe(2);
    expect(result.perRole.reviewer?.cost).toBeCloseTo(0.3, 6);
    expect(result.perRole.reviewer?.tokens).toBe(700);
    expect(result.perRole.reviewer?.sessions).toBe(2);
    expect(result.perModel["anthropic:claude-sonnet-4-5"]?.cost).toBeCloseTo(1.2, 6);
    expect(result.perModel["anthropic:claude-sonnet-4-5"]?.tokens).toBe(3000);
    expect(result.perModel["anthropic:claude-sonnet-4-5"]?.sessions).toBe(3);
    expect(result.perModel["anthropic:claude-opus-4-5"]?.cost).toBeCloseTo(2.1, 6);
    expect(result.perModel["anthropic:claude-opus-4-5"]?.tokens).toBe(5200);
    expect(result.perModel["anthropic:claude-opus-4-5"]?.sessions).toBe(2);
    expect(result.perModel["openai:gpt-4o"]?.cost).toBeCloseTo(1.5, 6);
    expect(result.perModel["openai:gpt-4o"]?.tokens).toBe(3000);
    expect(result.perModel["openai:gpt-4o"]?.sessions).toBe(1);
    expect(result.orchestratorOverhead.cost).toBeCloseTo(1.0, 6);
    expect(result.orchestratorOverhead.tokens).toBe(2500);
    expect(result.orchestratorOverhead.sessions).toBe(2);
  });
});

// ─── run_id filtering ──────────────────────────────────────────────────

describe("rollup: run_id filtering", () => {
  it("only aggregates records for the requested run_id", () => {
    const records: PersistedRecord[] = [
      ended({
        run_id: RUN_A,
        role: "implementer",
        model: "anthropic:claude-opus-4-5",
        usage: mkUsage(100, 50, 0, 0, 1.0),
      }),
      ended({
        run_id: RUN_B,
        role: "implementer",
        model: "anthropic:claude-opus-4-5",
        usage: mkUsage(500, 250, 0, 0, 5.0),
      }),
      ended({
        run_id: RUN_A,
        role: "reviewer",
        model: "anthropic:claude-sonnet-4-5",
        usage: mkUsage(50, 25, 0, 0, 0.5),
      }),
    ];
    const result = rollup(records, RUN_A, "orchestrator");
    expect(result.perRun.cost).toBeCloseTo(1.5, 6);
    expect(result.perRun.sessions).toBe(2);
    expect(result.perRole.implementer?.cost).toBeCloseTo(1.0, 6);
    expect(result.perRole.reviewer?.cost).toBeCloseTo(0.5, 6);
  });

  it("records from a different run are not in the perRole map", () => {
    const records: PersistedRecord[] = [
      ended({
        run_id: RUN_B,
        role: "ghost",
        model: "anthropic:claude-sonnet-4-5",
        usage: mkUsage(100, 50, 0, 0, 1.0),
      }),
    ];
    const result = rollup(records, RUN_A, "orchestrator");
    expect(result.perRun.cost).toBe(0);
    expect(result.perRole.ghost).toBeUndefined();
  });
});

// ─── session_started records (no usage) are excluded ───────────────────

describe("rollup: session_started records (no usage) do not contribute", () => {
  it("perRun.cost and sessions do not count session_started events", () => {
    const records: PersistedRecord[] = [
      started({ role: "implementer", model: "anthropic:claude-opus-4-5" }),
      started({ role: "reviewer", model: "anthropic:claude-sonnet-4-5" }),
    ];
    const result = rollup(records, RUN_A, "orchestrator");
    expect(result.perRun.cost).toBe(0);
    expect(result.perRun.sessions).toBe(0);
    expect(Object.keys(result.perRole)).toHaveLength(0);
  });
});

// ─── Cache caveat (§11.6): no per-run cache hit rate exposed ───────────

describe("rollup: cache caveat (§11.6)", () => {
  it("exposes raw cache_read / cache_write sums; no cacheHitRate field exists", () => {
    const records: PersistedRecord[] = [
      ended({
        role: "implementer",
        model: "anthropic:claude-opus-4-5",
        usage: mkUsage(100, 50, 200, 50, 1.0),
      }),
    ];
    const result = rollup(records, RUN_A, "orchestrator");
    expect(result.perRun.cache_read).toBe(200);
    expect(result.perRun.cache_write).toBe(50);
    // No "hit rate" field. The structural type only exposes sums.
    expect((result.perRun as Record<string, unknown>).cacheHitRate).toBeUndefined();
    expect((result.perRun as Record<string, unknown>).cache_hit_rate).toBeUndefined();
    expect((result.perRun as Record<string, unknown>).hitRate).toBeUndefined();
  });

  it("perRole and perModel also expose raw cache_read / cache_write sums", () => {
    const records: PersistedRecord[] = [
      ended({
        role: "implementer",
        model: "anthropic:claude-opus-4-5",
        usage: mkUsage(100, 50, 200, 50, 1.0),
      }),
      ended({
        role: "implementer",
        model: "anthropic:claude-opus-4-5",
        usage: mkUsage(100, 50, 100, 25, 0.5),
      }),
    ];
    const result = rollup(records, RUN_A, "orchestrator");
    expect(result.perRole.implementer?.cache_read).toBe(300);
    expect(result.perRole.implementer?.cache_write).toBe(75);
    expect(result.perModel["anthropic:claude-opus-4-5"]?.cache_read).toBe(300);
    expect(result.perModel["anthropic:claude-opus-4-5"]?.cache_write).toBe(75);
  });
});

// ─── Both terminals contribute (§11.4: both terminals cost) ────────────

describe("rollup: both terminal types contribute (§11.4)", () => {
  it("session_failed cost is included in the roll-up", () => {
    const records: PersistedRecord[] = [
      failed({
        role: "implementer",
        model: "anthropic:claude-opus-4-5",
        usage: mkUsage(100, 50, 0, 0, 1.0),
        reason: "model_error",
      }),
      ended({
        role: "implementer",
        model: "openai:gpt-4o",
        usage: mkUsage(100, 50, 0, 0, 0.8),
      }),
    ];
    const result = rollup(records, RUN_A, "orchestrator");
    expect(result.perRun.cost).toBeCloseTo(1.8, 6);
    expect(result.perRun.sessions).toBe(2);
  });
});

// ─── System-default model (model: null) ─────────────────────────────────

describe("rollup: system-default model key", () => {
  it("null model maps to a stable sentinel key in perModel", () => {
    const records: PersistedRecord[] = [
      ended({
        role: "implementer",
        model: null, // system default, §8.1
        usage: mkUsage(100, 50, 0, 0, 1.0),
      }),
    ];
    const result = rollup(records, RUN_A, "orchestrator");
    // The sentinel key is documented on UsageAggregate. Pick one and pin it.
    // Using "<system-default>" — a string a real model never takes.
    const keys = Object.keys(result.perModel);
    expect(keys).toHaveLength(1);
    const key = keys[0];
    expect(key).toBeDefined();
    expect(result.perModel[key as string]?.cost).toBe(1.0);
  });
});
