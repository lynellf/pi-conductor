/**
 * Issue #139 Phase 3 RED: role-prompt integration.
 *
 * The delivered fresh prompt must name the host packet first, retain the
 * requirement to read AGENTS.md and the named plan, and permit a broad
 * scan only after a precise omission or contradiction is identified. It
 * must not forbid necessary investigation.
 */

import { describe, expect, it } from "vitest";
import { createInitialCheckpoint } from "../../src/core/reduce.js";
import type { SessionTerminalReason } from "../../src/host/host.js";
import { runLoop } from "../../src/host/loop.js";
import * as packetMaterializer from "../../src/host/phase-work-packet-materializer.js";
import type {
  Checkpoint,
  Host,
  MachineDefinition,
  PersistedRecord,
  Role,
  RoleSession,
  RunMemory,
  SpawnRoleOptions,
  UsageRecord,
} from "../../src/index.js";
import { InMemoryRecordLog } from "../../src/index.js";
import type { EmissionCapture } from "../../src/seam/validate-emission.js";

class PromptFakeSession {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly role: Role;
  prompts: string[] = [];
  captureBuffer: EmissionCapture[] = [];
  signals: readonly { readonly tool: string; readonly command?: string }[] = [];

  constructor(role: Role, sessionId: string) {
    this.role = role;
    this.sessionId = sessionId;
    this.sessionFile = `/tmp/rpi-${sessionId}.jsonl`;
  }

  toRoleSession(): RoleSession {
    return {
      role: this.role,
      sessionId: this.sessionId,
      sessionFile: this.sessionFile,
      model: null,
      effort: "medium",
      readCaptureBuffer: () => Object.freeze([...this.captureBuffer]),
      resetCaptureBuffer: () => {
        this.captureBuffer.length = 0;
      },
      takeReconstructionSignals: () => this.signals,
      subscribe: () => () => {},
      prompt: async (text: string) => {
        this.prompts.push(text);
        this.captureBuffer.push({ toolName: "end", args: {} });
      },
      dispose: async () => {},
    } as unknown as RoleSession;
  }
}

class PromptFakeHost implements Host {
  readonly log: InMemoryRecordLog;
  readonly runId: string;
  readonly queue: PromptFakeSession[] = [];

  constructor(log: InMemoryRecordLog, runId: string) {
    this.log = log;
    this.runId = runId;
  }

  enqueue(session: PromptFakeSession): void {
    this.queue.push(session);
  }

  async spawnRole(role: Role): Promise<RoleSession> {
    const next = this.queue.shift();
    if (next === undefined) throw new Error(`queue exhausted for '${role}'`);
    return next.toRoleSession();
  }

  captureUsage(): UsageRecord {
    return { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 };
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
      run_id: this.runId,
      goal: args.goal,
      current_role: "orchestrator",
      state: "orchestrator",
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

  ensurePhaseWorkPacket(args: {
    readonly role: Role;
    readonly visitIndex: number;
    readonly seed: string;
    readonly initialGoal: string;
  }): {
    readonly seedWithPacket: string;
    readonly isNew: boolean;
    readonly packet: import("../../src/persistence/phase-work-packet.js").PhaseWorkPacketRecord;
  } {
    const records = this.log.records(this.runId);
    const { record, isNew } = packetMaterializer.materializePacketRecord({
      records,
      runId: this.runId,
      recipientRole: args.role,
      recipientVisitIndex: args.visitIndex,
      initialGoal: args.initialGoal,
    });
    if (isNew) this.persistRecord(record);
    return {
      seedWithPacket: packetMaterializer.composeSeedWithPacket(args.seed, record),
      isNew,
      packet: record,
    };
  }

  sessionTerminalReason(): SessionTerminalReason {
    return null;
  }

  async abortSession(): Promise<void> {
    return;
  }

  sealSession(): void {
    return;
  }

  runCostSoFar(): number {
    return 0;
  }

  getNextModel(): string | null {
    return null;
  }

  nextVisitIndex(role: Role): number {
    return (
      this.log.records(this.runId).filter((r) => r.type === "session_started" && r.role === role)
        .length + 1
    );
  }

  async spawnRoleWithOpts(role: Role, _opts: SpawnRoleOptions): Promise<RoleSession> {
    return this.spawnRole(role);
  }
}

function makeDef(): MachineDefinition {
  return Object.freeze({
    manifest_version: "1",
    orchestrator: "orchestrator",
    workers: Object.freeze([]),
    max_visits: Object.freeze({}),
    end_request_roles: null,
    handoff_evidence: null,
  }) as unknown as MachineDefinition;
}

describe("role prompt integration (issue #139 Phase 3)", () => {
  it("names the host packet first and retains the AGENTS.md requirement", async () => {
    const def = makeDef();
    const log = new InMemoryRecordLog();
    const initialCheckpoint = createInitialCheckpoint(def);
    const host = new PromptFakeHost(log, initialCheckpoint.run_id);
    const first = new PromptFakeSession("orchestrator", "sess-prompt-1");
    host.enqueue(first);

    await runLoop({ def, initialCheckpoint, host, initialGoal: "ship packets" });

    expect(first.prompts).toHaveLength(1);
    const prompt = first.prompts[0] ?? "";
    expect(prompt).toContain("## phase_work_packet");
    expect(prompt).toContain("recipient_guidance");
    expect(prompt).toContain("AGENTS.md");
    expect(prompt).toMatch(/broad.*scan.*only after/i);
  });

  it("emits bounded audit-only signals without affecting routing", async () => {
    const def = makeDef();
    const log = new InMemoryRecordLog();
    const initialCheckpoint = createInitialCheckpoint(def);
    const runId = initialCheckpoint.run_id;
    const host = new PromptFakeHost(log, runId);
    const first = new PromptFakeSession("orchestrator", "sess-signal-1");
    first.signals = [{ tool: "bash", command: "find . -name '*.ts'" }, { tool: "handoff_context" }];
    host.enqueue(first);

    const result = await runLoop({ def, initialCheckpoint, host, initialGoal: "ship packets" });

    // Routing is unaffected: the run still ends normally.
    expect(result.exitReason).toBe("done");
    const signals = log.records(runId).filter((r) => r.type === "reconstruction_signal");
    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({ kind: "broad_find" });
    expect(signals[1]).toMatchObject({ kind: "predecessor_context_read" });
    // No raw commands leak into the durable log.
    expect(JSON.stringify(signals[0])).not.toContain("find .");
  });
});
