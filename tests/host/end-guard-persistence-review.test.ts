import { describe, expect, it } from "vitest";
import { createInitialCheckpoint } from "../../src/core/reduce.js";
import type { RunMemory } from "../../src/core/run-memory.js";
import type { Checkpoint, MachineDefinition, UsageRecord } from "../../src/core/types.js";
import type { EndGuardRunResult } from "../../src/host/end-guard-runner.js";
import type { Host, RoleSession, SpawnRoleOptions } from "../../src/host/host.js";
import { runLoop } from "../../src/host/loop.js";
import type { EndGuardRecord } from "../../src/persistence/end-guard.js";
import { InMemoryRecordLog, type PersistedRecord } from "../../src/persistence/log.js";
import type { EmissionCapture } from "../../src/seam/validate-emission.js";

const ZERO: UsageRecord = {
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  tokens: 0,
  cost: 0,
};
const DEF: MachineDefinition = Object.freeze({
  manifest_version: "1",
  orchestrator: "orchestrator",
  workers: Object.freeze([]),
  max_visits: Object.freeze({}),
  end_request_roles: null,
});

const session: RoleSession = {
  role: "orchestrator",
  sessionId: "orchestrator-session",
  sessionFile: "/tmp/orchestrator-session.jsonl",
  model: null,
  effort: "medium",
  readCaptureBuffer: () => [{ toolName: "end", args: {} } satisfies EmissionCapture],
  resetCaptureBuffer: () => undefined,
  subscribe: () => () => undefined,
  prompt: async () => undefined,
  dispose: async () => undefined,
};

class LoopHost implements Host {
  readonly log = new InMemoryRecordLog();
  guardCalls = 0;
  constructor(
    private readonly persistFailure:
      | "start-before"
      | "start-after"
      | "finish-before"
      | "finish-after"
      | null = null,
    private readonly identity: "valid" | "wrong-attempt" | "wrong-session" = "valid",
  ) {}

  async spawnRole(_role: string, _options: SpawnRoleOptions = {}): Promise<RoleSession> {
    return session;
  }
  captureUsage(): UsageRecord {
    return ZERO;
  }
  persistRecord(record: PersistedRecord): void {
    if (
      (this.persistFailure === "start-before" && record.type === "end_guard_started") ||
      (this.persistFailure === "finish-before" && record.type === "end_guard_finished")
    ) {
      throw new Error(
        `${record.type === "end_guard_started" ? "start" : "finish"} append ambiguous`,
      );
    }
    this.log.append(record);
    if (
      (this.persistFailure === "start-after" && record.type === "end_guard_started") ||
      (this.persistFailure === "finish-after" && record.type === "end_guard_finished")
    ) {
      throw new Error(
        `${record.type === "end_guard_started" ? "start" : "finish"} append ambiguous`,
      );
    }
  }
  seedRunMemory(args: {
    checkpoint: Checkpoint;
    def: MachineDefinition;
    goal: string;
    runCostCap: number | null;
  }): RunMemory {
    return {
      run_id: args.checkpoint.run_id,
      goal: args.goal,
      current_role: args.checkpoint.current_role,
      state: args.checkpoint.current_role,
      last_message: null,
      end_request: null,
      can_end: true,
      visit_history: [],
      run_cost_to_date: 0,
      run_cost_cap: args.runCostCap,
      remaining_budget: args.runCostCap,
      per_role_cost: {},
      next_candidates: [],
    };
  }
  async abortSession(): Promise<void> {}
  sealSession(): void {}
  sessionTerminalReason(): null {
    return null;
  }
  getNextModel(): null {
    return null;
  }
  runCostSoFar(): number {
    return 0;
  }
  nextVisitIndex(): number {
    return 1;
  }
  async runEndGuard(request: {
    attemptId: string;
    roleSessionId: string;
  }): Promise<EndGuardRunResult> {
    this.guardCalls += 1;
    return {
      attemptId: this.identity === "wrong-attempt" ? "other-attempt" : request.attemptId,
      roleSessionId: this.identity === "wrong-session" ? "other-session" : request.roleSessionId,
      outcome: "passed",
      exitCode: 0,
      signal: null,
      elapsedMs: 1,
      output: "ok",
      truncated: false,
      cleanup: "confirmed",
    };
  }
}

function run(host: LoopHost): ReturnType<typeof runLoop> {
  const records = (): readonly EndGuardRecord[] =>
    host.log
      .records(host.log.listRunIds()[0] ?? "")
      .filter(
        (record): record is EndGuardRecord =>
          record.type === "end_guard_started" ||
          record.type === "end_guard_finished" ||
          record.type === "end_guard_budget_reset",
      );
  return runLoop({
    def: DEF,
    initialCheckpoint: createInitialCheckpoint(DEF),
    host,
    initialGoal: "finish",
    endGuard: {
      config: { command: "printf guard", timeout_seconds: 1 },
      records,
      requestId: () => "request-1",
    },
  });
}

describe("run-loop end-guard durable append boundary", () => {
  it.each([
    ["start-before", 0, 0, 0],
    ["start-after", 0, 1, 0],
    ["finish-before", 1, 1, 0],
    ["finish-after", 1, 1, 1],
  ] as const)("fails closed when %s append is ambiguous", async (failure, expectedCalls, expectedStarts, expectedFinishes) => {
    const host = new LoopHost(failure);
    await expect(run(host)).rejects.toThrow(`${failure.split("-")[0]} append ambiguous`);
    expect(host.guardCalls).toBe(expectedCalls);
    const records = host.log.records(host.log.listRunIds()[0] ?? "");
    expect(records.filter((r) => r.type === "end_guard_started")).toHaveLength(expectedStarts);
    expect(records.filter((r) => r.type === "end_guard_finished")).toHaveLength(expectedFinishes);
    expect(records.filter((r) => r.type === "transition_accepted")).toHaveLength(0);
  });

  it.each([
    ["wrong-attempt"],
    ["wrong-session"],
  ] as const)("rejects runner identity mismatch: %s", async (identity) => {
    const host = new LoopHost(null, identity);
    await expect(run(host)).rejects.toThrow();
    expect(host.guardCalls).toBe(1);
    expect(
      host.log
        .records(host.log.listRunIds()[0] ?? "")
        .filter((r) => r.type === "transition_accepted"),
    ).toHaveLength(0);
  });
});
