import { describe, expect, it } from "vitest";
import { createInitialCheckpoint } from "../../src/core/reduce.js";
import type { RunMemory } from "../../src/core/run-memory.js";
import type { Checkpoint, MachineDefinition, Role, UsageRecord } from "../../src/core/types.js";
import type { EndGuardRunResult } from "../../src/host/end-guard-runner.js";
import type { Host, RoleSession, SpawnRoleOptions } from "../../src/host/host.js";
import { runLoop } from "../../src/host/loop.js";
import { RunControl } from "../../src/host/run-control.js";
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
  workers: Object.freeze(["worker"]),
  max_visits: Object.freeze({ worker: 2 }),
  end_request_roles: null,
});

class ScriptedSession {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly prompts: string[] = [];
  private readonly captures: EmissionCapture[] = [];

  constructor(
    readonly role: Role,
    private readonly emissions: readonly ("end" | "handoff")[],
  ) {
    this.sessionId = `${role}-session`;
    this.sessionFile = `/tmp/${this.sessionId}.jsonl`;
  }

  toRoleSession(): RoleSession {
    return {
      role: this.role,
      sessionId: this.sessionId,
      sessionFile: this.sessionFile,
      model: null,
      effort: "medium",
      readCaptureBuffer: () => [...this.captures],
      resetCaptureBuffer: () => this.captures.splice(0),
      subscribe: () => () => undefined,
      prompt: async (text) => {
        this.prompts.push(text);
        const emission = this.emissions[this.prompts.length - 1];
        if (emission === "end") this.captures.push({ toolName: "end", args: {} });
        if (emission === "handoff") {
          this.captures.push({
            toolName: "handoff",
            args: {
              target_role: "orchestrator",
              status: "complete",
              objective: "finish",
              summary: "finish",
              requested_action: "finish",
              request_end: false,
            },
          });
        }
      },
      dispose: async () => {},
    };
  }
}

class GuardHost implements Host {
  readonly log = new InMemoryRecordLog();
  readonly sessions: ScriptedSession[];
  readonly guardResults: EndGuardRunResult[];
  guardCalls = 0;
  private readonly roleSession: RoleSession;

  constructor(emissions: readonly ("end" | "handoff")[], guardResults: EndGuardRunResult[]) {
    const scripted = new ScriptedSession("orchestrator", emissions);
    this.sessions = [scripted];
    this.roleSession = scripted.toRoleSession();
    this.guardResults = guardResults;
  }

  async spawnRole(_role: Role, _options: SpawnRoleOptions = {}): Promise<RoleSession> {
    return this.roleSession;
  }
  captureUsage(): UsageRecord {
    return ZERO;
  }
  persistRecord(record: PersistedRecord): void {
    this.log.append(record);
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
    const result = this.guardResults[this.guardCalls - 1];
    if (result === undefined) throw new Error("unexpected guard call");
    return { ...result, attemptId: request.attemptId, roleSessionId: request.roleSessionId };
  }
}

function guardResult(outcome: EndGuardRunResult["outcome"], output: string): EndGuardRunResult {
  return {
    attemptId: "replaced-by-test",
    roleSessionId: "orchestrator-session",
    outcome,
    exitCode: outcome === "passed" ? 0 : null,
    signal: null,
    elapsedMs: 1,
    output,
    truncated: false,
    cleanup: outcome === "cleanup_unconfirmed" ? "unconfirmed" : "confirmed",
  };
}

function run(
  host: GuardHost,
  options: { readonly runCostCap?: number; readonly getRunCostCap?: () => number | null } = {},
  runControl?: RunControl,
) {
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
    ...(options.runCostCap === undefined ? {} : { runCostCap: options.runCostCap }),
    ...(options.getRunCostCap === undefined ? {} : { getRunCostCap: options.getRunCostCap }),
    ...(runControl === undefined ? {} : { runControl }),
    endGuard: {
      config: { command: "printf guard", timeout_seconds: 1 },
      records,
      requestId: () => "request-1",
    },
  });
}

describe("end guard run-loop boundary", () => {
  it("executes only for a legal orchestrator end and persists before acceptance", async () => {
    const host = new GuardHost(["end"], [guardResult("passed", "ok")]);
    const result = await run(host);
    expect(result.exitReason).toBe("done");
    expect(host.guardCalls).toBe(1);
    const records = host.log.records(host.log.listRunIds()[0] ?? "");
    expect(records.map((record) => record.type)).toContain("end_guard_finished");
    expect(records.findIndex((record) => record.type === "end_guard_finished")).toBeLessThan(
      records.findIndex((record) => record.type === "transition_accepted"),
    );
  });

  it("retains the live checkpoint and exposes diagnostics across failed retries", async () => {
    const host = new GuardHost(
      ["end", "end"],
      [guardResult("failed", "repair this"), guardResult("passed", "ok")],
    );
    const result = await run(host);
    expect(result.exitReason).toBe("done");
    expect(host.guardCalls).toBe(2);
    expect(host.sessions[0]?.prompts[1]).toContain("repair this");
  });

  it("bypasses the guard for a forced cost-cap close and never runs a worker end guard", async () => {
    const forced = new GuardHost(["end"], [guardResult("failed", "must not run")]);
    expect((await run(forced, { runCostCap: 0 })).exitReason).toBe("done");
    expect(forced.guardCalls).toBe(0);

    const worker = new GuardHost(["end"], [guardResult("passed", "must not run")]);
    const workerCheckpoint = Object.freeze({
      ...createInitialCheckpoint(DEF),
      current_role: "worker",
    }) as Checkpoint;
    const workerResult = await runLoop({
      def: DEF,
      initialCheckpoint: workerCheckpoint,
      host: worker,
      initialGoal: "finish",
      endGuard: {
        config: { command: "printf guard", timeout_seconds: 1 },
        records: () => [],
        requestId: () => "request-1",
      },
    });
    expect(workerResult.exitReason).toBe("session_failed");
    expect(worker.guardCalls).toBe(0);
  });

  it("converts a cap that changes during the guard into a synthesized forced end", async () => {
    const host = new GuardHost(["end"], [guardResult("failed", "guard failed")]);
    let cap: number | null = null;
    const original = host.runEndGuard.bind(host);
    host.runEndGuard = async (request) => {
      cap = 0;
      return original(request);
    };
    const result = await run(host, { getRunCostCap: () => cap });
    expect(result.exitReason).toBe("done");
    const records = host.log.records(host.log.listRunIds()[0] ?? "");
    expect(
      records.some(
        (record) =>
          record.type === "transition_accepted" && record.end_authority === "run_cost_cap",
      ),
    ).toBe(true);
  });

  it("reruns after post-guard guidance and never caches a successful result", async () => {
    const host = new GuardHost(
      ["end", "end"],
      [guardResult("passed", "ok"), guardResult("passed", "ok")],
    );
    const control = new RunControl({
      runId: "guard-guidance",
      abortSession: async () => undefined,
    });
    const original = host.runEndGuard.bind(host);
    host.runEndGuard = async (request) => {
      if (host.guardCalls === 0) await control.followUp("inspect one more thing");
      return original(request);
    };
    expect((await run(host, {}, control)).exitReason).toBe("done");
    expect(host.guardCalls).toBe(2);
    expect(host.sessions[0]?.prompts[1]).toContain("inspect one more thing");
  });

  it("settles an operator abort during guard execution without accepting end", async () => {
    const host = new GuardHost(["end"], [guardResult("passed", "ok")]);
    const control = new RunControl({
      runId: "guard-abort",
      abortSession: async () => undefined,
    });
    const original = host.runEndGuard.bind(host);
    host.runEndGuard = async (request) => {
      await control.requestAbort("operator stop");
      return original(request);
    };
    const result = await run(host, {}, control);
    expect(result.exitReason).toBe("aborted");
    expect(
      host.log
        .records(host.log.listRunIds()[0] ?? "")
        .some((record) => record.type === "transition_accepted"),
    ).toBe(false);
  });
});
