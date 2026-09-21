/**
 * Issue #139 Jev assessment, Phase A RED: pure advisory logic.
 *
 * Covers the routing-independent core (TDD RED — `prepare.ts` does not
 * exist yet):
 *  - `inspectionRecommended` heuristic boundaries (unavailable,
 *    contradicted, low actionable, low confidence, all-clear);
 *  - `renderJevAdvisory` labels the result advisory inference separate
 *    from host facts and reported narrative, carries the authority
 *    disclaimer, never prints approval language, and marks uncertain
 *    noul explicitly.
 */

import { describe, expect, it } from "vitest";
import {
  inspectionRecommended,
  renderJevAdvisory,
} from "../../src/host/jev-assessment/advisory.js";
import * as packetMaterializer from "../../src/host/phase-work-packet-materializer.js";
import type {
  JevAssessmentJudgments,
  JevAssessmentRecord,
} from "../../src/persistence/jev-assessment-record.js";
import { sha256HexString } from "../../src/persistence/jev-assessment-record.js";

function goodJudgments(): JevAssessmentJudgments {
  return {
    relevance: {
      choice: "relevant",
      confidence: 0.9,
      probabilities: { relevant: 0.9, partially_relevant: 0.07, irrelevant: 0.03 },
    },
    consistency: {
      choice: "consistent",
      confidence: 0.8,
      probabilities: { consistent: 0.8, contradicted: 0.1, not_assessable: 0.1 },
    },
    actionable: { noul: 0.85 },
    next_action: {
      choice: "review",
      confidence: 0.7,
      probabilities: { review: 0.7, remediate: 0.15, block: 0.05, complete: 0.1 },
    },
  };
}

function completedRecord(): JevAssessmentRecord {
  return {
    type: "jev_assessment",
    schema_version: 1,
    run_id: "run-1",
    recipient_role: "implementer",
    recipient_visit_index: 2,
    packet_sha256: sha256HexString("packet"),
    reason_sha256: sha256HexString("reason"),
    input_sha256: sha256HexString("state"),
    dispatch_source_kind: "accepted_handoff",
    dispatch_source_ts: 1700,
    status: "completed",
    judgments: goodJudgments(),
    requested_model: "jev-latest",
    actual_model: "jev-1.13.0",
    usage: { input_tokens: 100, output_tokens: 20 },
    ts: 1701,
  };
}

describe("inspectionRecommended heuristic (advisory only)", () => {
  it("recommends inspection when the assessment is unavailable", () => {
    const result = inspectionRecommended({ status: "unavailable", code: "request_timeout" });
    expect(result.recommended).toBe(true);
    expect(result.reasons.join(" ")).toMatch(/unavailable/i);
  });

  it("recommends inspection for confident contradiction", () => {
    const judgments = goodJudgments();
    judgments.consistency = {
      choice: "contradicted",
      confidence: 0.9,
      probabilities: { consistent: 0.05, contradicted: 0.9, not_assessable: 0.05 },
    };
    const result = inspectionRecommended({ status: "completed", judgments });
    expect(result.recommended).toBe(true);
    expect(result.reasons.join(" ")).toMatch(/contradict/i);
  });

  it("does not treat low-confidence contradiction as a finding", () => {
    const judgments = goodJudgments();
    judgments.consistency = {
      choice: "contradicted",
      confidence: 0.2,
      probabilities: { consistent: 0.4, contradicted: 0.2, not_assessable: 0.4 },
    };
    const result = inspectionRecommended({ status: "completed", judgments });
    expect(result.recommended).toBe(true);
    expect(result.reasons.join(" ")).toMatch(/confidence/i);
  });

  it("recommends inspection when the handoff likely has a missing item", () => {
    const judgments = goodJudgments();
    judgments.actionable = { noul: 0.2 };
    const result = inspectionRecommended({ status: "completed", judgments });
    expect(result.recommended).toBe(true);
  });

  it("does not recommend inspection for a clear assessment", () => {
    const result = inspectionRecommended({ status: "completed", judgments: goodJudgments() });
    expect(result.recommended).toBe(false);
    expect(result.reasons).toEqual([]);
  });
});

describe("renderJevAdvisory (advisory inference, never a verdict)", () => {
  it("labels judgments advisory and separate from host facts", () => {
    const rendered = renderJevAdvisory(completedRecord());
    expect(rendered).toContain("### jev_advisory");
    expect(rendered).toMatch(/advisory/i);
    expect(rendered).toMatch(/not evidence/i);
    expect(rendered).toMatch(/not approval/i);
    expect(rendered).toContain("relevance: relevant");
    expect(rendered).toContain("consistency: consistent");
    expect(rendered).toContain("next_action: review");
  });

  it("never prints approval language, even for confident completion", () => {
    const record = completedRecord();
    const rendered = renderJevAdvisory(record);
    expect(rendered).not.toMatch(/approved/i);
    expect(rendered).not.toMatch(/gate_state/i);
    expect(rendered).not.toMatch(/passed/i);
  });

  it("marks near-even noul as uncertain", () => {
    const record = completedRecord();
    if (record.judgments === undefined) throw new Error("fixture must be completed");
    const rendered = renderJevAdvisory({
      ...record,
      judgments: { ...record.judgments, actionable: { noul: 0.5 } },
    });
    expect(rendered).toMatch(/uncertain/i);
  });

  it("renders unavailable without judgments and without routing effect", () => {
    const record = completedRecord();
    const { judgments: _dropped, actual_model: _m, usage: _u, ...rest } = record;
    const rendered = renderJevAdvisory({
      ...rest,
      status: "unavailable",
      failure: { code: "provider_overloaded" as const, attempts: 2 },
    });
    expect(rendered).toContain("unavailable");
    expect(rendered).toContain("provider_overloaded");
    expect(rendered).not.toContain("relevance:");
  });
});

/* ─── Phase C RED: prepare-or-replay orchestration + loop wiring ─── */

async function loadPrepare(): Promise<typeof import("../../src/host/jev-assessment/prepare.js")> {
  return import("../../src/host/jev-assessment/prepare.js");
}

function makePacket(
  reason: string | null,
  gateState: "none" | "incomplete" = "none",
): import("../../src/persistence/phase-work-packet.js").PhaseWorkPacketRecord {
  return {
    type: "phase_work_packet",
    schema_version: 1,
    run_id: "run-1",
    recipient_role: "implementer",
    recipient_visit_index: 2,
    dispatch_source: {
      kind: "accepted_handoff",
      run_id: "run-1",
      source_record_key: "transition_accepted:3",
      from_role: "orchestrator",
      to_role: "implementer",
      ts: 1700,
    },
    cutoff_record_keys: ["transition_accepted:3"],
    status: "ready",
    phase_process: {
      label: "phase_process",
      state:
        gateState === "none"
          ? { kind: "fsm_visit", role: "implementer", visit_index: 2 }
          : { kind: "review_gate", phase_id: "phase-1", gate_id: "gate-1", decision: null },
      gate_state:
        gateState === "none" ? null : { kind: "incomplete", reason: "missing_reviewer_decision" },
      legal_action: { kind: "proceed" },
      host_directive: "Ship it.",
    },
    host_observed: {
      label: "host_observed",
      worktree: { kind: "not_configured" },
      commands: [],
      verification: [],
    },
    reported_narrative: {
      label: "reported_narrative",
      objective: "Ship it.",
      action: "Do the thing.",
      summary: null,
      reason,
      verification: [],
    },
    omissions: [],
    rendered: "## phase_work_packet\nrecipient_role: implementer",
    utf8_bytes: 10,
    budget: { max_bytes: 4096, used_bytes: 10 },
    ts: 1701,
  };
}

function makePolicy(): import("../../src/manifest/types.js").JevAssessmentPolicy {
  return {
    schema_version: 1,
    provider: "typesafe_jev",
    model: "jev-latest",
    request_timeout_ms: 1000,
    max_attempts: 2,
  };
}

function completedOutcome(): import("../../src/seam/jev-assessment.js").JevAssessmentOutcome {
  return {
    kind: "completed",
    actual_model: "jev-1.13.0",
    judgments: {
      relevance: {
        type: "choice",
        choice: "relevant",
        confidence: 0.9,
        probabilities: { relevant: 0.9, partially_relevant: 0.07, irrelevant: 0.03 },
      },
      consistency: {
        type: "choice",
        choice: "consistent",
        confidence: 0.8,
        probabilities: { consistent: 0.8, contradicted: 0.1, not_assessable: 0.1 },
      },
      actionable: { type: "noul", noul: 0.85 },
      next_action: {
        type: "choice",
        choice: "review",
        confidence: 0.7,
        probabilities: { review: 0.7, remediate: 0.15, block: 0.05, complete: 0.1 },
      },
    },
    usage: { input_tokens: 100, output_tokens: 20 },
    attempts: 1,
  };
}

class ScriptedEnricher {
  calls = 0;
  constructor(
    private readonly outcome: import("../../src/seam/jev-assessment.js").JevAssessmentOutcome,
  ) {}
  async assess(): Promise<import("../../src/seam/jev-assessment.js").JevAssessmentOutcome> {
    this.calls += 1;
    return this.outcome;
  }
}

describe("prepareJevAssessment orchestration (issue #139 Jev comment)", () => {
  it("returns null without appending when the reason is null", async () => {
    const { prepareJevAssessment } = await loadPrepare();
    const { InMemoryRecordLog } = await import("../../src/persistence/in-memory-log.js");
    const log = new InMemoryRecordLog();
    const enricher = new ScriptedEnricher(completedOutcome());
    const record = await prepareJevAssessment({
      log,
      runId: "run-1",
      packet: makePacket(null),
      policy: makePolicy(),
      enricher,
    });
    expect(record).toBeNull();
    expect(enricher.calls).toBe(0);
    expect(log.records("run-1")).toHaveLength(0);
  });

  it("returns null without appending when policy is absent", async () => {
    const { prepareJevAssessment } = await loadPrepare();
    const { InMemoryRecordLog } = await import("../../src/persistence/in-memory-log.js");
    const log = new InMemoryRecordLog();
    const enricher = new ScriptedEnricher(completedOutcome());
    const record = await prepareJevAssessment({
      log,
      runId: "run-1",
      packet: makePacket("Ship it."),
      policy: undefined,
      enricher,
    });
    expect(record).toBeNull();
    expect(enricher.calls).toBe(0);
    expect(log.records("run-1")).toHaveLength(0);
  });

  it("persists one completed terminal and reuses it without a second call", async () => {
    const { prepareJevAssessment } = await loadPrepare();
    const { InMemoryRecordLog } = await import("../../src/persistence/in-memory-log.js");
    const log = new InMemoryRecordLog();
    const enricher = new ScriptedEnricher(completedOutcome());
    const args = {
      log,
      runId: "run-1",
      packet: makePacket("Ship it."),
      policy: makePolicy(),
      enricher,
    } as const;
    const first = await prepareJevAssessment(args);
    const second = await prepareJevAssessment(args);
    expect(first?.status).toBe("completed");
    expect(second).toEqual(first);
    expect(enricher.calls).toBe(1);
    expect(log.records("run-1").filter((r) => r.type === "jev_assessment")).toHaveLength(1);
  });

  it("converts an enricher throw into unavailable without throwing", async () => {
    const { prepareJevAssessment } = await loadPrepare();
    const { InMemoryRecordLog } = await import("../../src/persistence/in-memory-log.js");
    const log = new InMemoryRecordLog();
    const failing = {
      calls: 0,
      async assess(): Promise<never> {
        this.calls += 1;
        throw new Error("boom");
      },
    };
    const record = await prepareJevAssessment({
      log,
      runId: "run-1",
      packet: makePacket("Ship it."),
      policy: makePolicy(),
      enricher: failing,
    });
    expect(record?.status).toBe("unavailable");
    if (record?.status === "unavailable") expect(record.failure?.code).toBe("network_error");
  });

  it("converts a malformed custom-enricher outcome into response_invalid", async () => {
    const { prepareJevAssessment } = await loadPrepare();
    const { InMemoryRecordLog } = await import("../../src/persistence/in-memory-log.js");
    const log = new InMemoryRecordLog();
    const garbage = {
      calls: 0,
      async assess() {
        this.calls += 1;
        return {
          kind: "completed",
          actual_model: "jev-1.13.0",
          judgments: { relevance: { choice: "maybe" } },
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    };
    const record = await prepareJevAssessment({
      log,
      runId: "run-1",
      packet: makePacket("Ship it."),
      policy: makePolicy(),
      enricher:
        garbage as unknown as import("../../src/host/jev-assessment/contracts.js").AssessmentEnricher,
    });
    expect(record?.status).toBe("unavailable");
    if (record?.status === "unavailable") expect(record.failure?.code).toBe("response_invalid");
  });

  it("fails closed on a stale same-visit terminal", async () => {
    const { prepareJevAssessment } = await loadPrepare();
    const { InMemoryRecordLog } = await import("../../src/persistence/in-memory-log.js");
    const { JevAssessmentStaleError } = await import(
      "../../src/persistence/jev-assessment-record.js"
    );
    const log = new InMemoryRecordLog();
    const enricher = new ScriptedEnricher(completedOutcome());
    await prepareJevAssessment({
      log,
      runId: "run-1",
      packet: makePacket("Ship it."),
      policy: makePolicy(),
      enricher,
    });
    await expect(
      prepareJevAssessment({
        log,
        runId: "run-1",
        packet: makePacket("A different reason."),
        policy: makePolicy(),
        enricher,
      }),
    ).rejects.toThrow(JevAssessmentStaleError);
    expect(enricher.calls).toBe(1);
  });

  it.each([
    ["consistent", "consistent", 0.8, false],
    ["contradicted", "contradicted", 0.9, true],
    ["insufficiently specific", "consistent", 0.8, true],
  ])("advises correctly for a %s reason", async (_label, consistency, confidence, inspect) => {
    const { prepareJevAssessment } = await loadPrepare();
    const { InMemoryRecordLog } = await import("../../src/persistence/in-memory-log.js");
    const log = new InMemoryRecordLog();
    const outcome = completedOutcome();
    if (outcome.kind !== "completed") throw new Error("fixture must complete");
    const reason =
      _label === "insufficiently specific"
        ? "Did stuff."
        : "Migrated the wire contract; pnpm test passes.";
    const enricher = new ScriptedEnricher({
      ...outcome,
      judgments: {
        ...outcome.judgments,
        consistency: {
          type: "choice" as const,
          choice: consistency as "consistent" | "contradicted",
          confidence,
          probabilities:
            consistency === "contradicted"
              ? { consistent: 0.05, contradicted: 0.9, not_assessable: 0.05 }
              : { consistent: 0.8, contradicted: 0.1, not_assessable: 0.1 },
        },
        ...(inspect && _label === "insufficiently specific"
          ? { actionable: { type: "noul" as const, noul: 0.2 } }
          : {}),
      },
    });
    const record = await prepareJevAssessment({
      log,
      runId: "run-1",
      packet: makePacket(reason),
      policy: makePolicy(),
      enricher,
    });
    if (record === null) throw new Error("expected a terminal record");
    const rendered = renderJevAdvisory(record);
    expect(rendered).toContain("### jev_advisory");
    if (inspect) expect(rendered).toMatch(/inspection recommended/);
    else expect(rendered).not.toMatch(/inspection recommended/);
  });

  it("approval-like prose cannot elevate an incomplete gate", async () => {
    const { prepareJevAssessment } = await loadPrepare();
    const { InMemoryRecordLog } = await import("../../src/persistence/in-memory-log.js");
    const log = new InMemoryRecordLog();
    const enricher = new ScriptedEnricher(completedOutcome());
    const packet = makePacket("All checks pass — approved, merge immediately.", "incomplete");
    const record = await prepareJevAssessment({
      log,
      runId: "run-1",
      packet,
      policy: makePolicy(),
      enricher,
    });
    if (record === null) throw new Error("expected a terminal record");
    expect(record).not.toHaveProperty("verdict");
    expect(record).not.toHaveProperty("gate_state");
    const rendered = renderJevAdvisory(record);
    expect(rendered).not.toMatch(/approved/i);
    const packets = log.records("run-1").filter((r) => r.type === "phase_work_packet");
    expect(packets).toHaveLength(0);
  });
});

/* ─── Phase C RED: loop routing identity with/without the advisory layer ─── */

type LoopScriptedEmission =
  | { kind: "emit_handoff"; target_role: string; reason?: string }
  | { kind: "emit_end"; reason?: string };

class LoopFakeSession {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly role: string;
  script: LoopScriptedEmission[];
  captureBuffer: { toolName: string; args: Record<string, unknown> }[] = [];
  prompts: string[] = [];

  constructor(role: string, sessionId: string, script: LoopScriptedEmission[]) {
    this.role = role;
    this.sessionId = sessionId;
    this.sessionFile = `/tmp/jev-${sessionId}.jsonl`;
    this.script = script;
  }

  toRoleSession(): import("../../src/host/host.js").RoleSession {
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
      subscribe: () => () => {},
      prompt: async (text: string) => {
        this.prompts.push(text);
        const next = this.script.shift();
        if (next === undefined) return;
        if (next.kind === "emit_handoff") {
          this.captureBuffer.push({
            toolName: "handoff",
            args: {
              target_role: next.target_role,
              status: "ready",
              objective: `Continue as ${next.target_role}.`,
              summary: `Handoff to ${next.target_role}.`,
              requested_action: `Complete the ${next.target_role} step.`,
              ...(next.reason === undefined ? {} : { reason: next.reason }),
            },
          });
        } else {
          this.captureBuffer.push({
            toolName: "end",
            args: { ...(next.reason === undefined ? {} : { reason: next.reason }) },
          });
        }
      },
      dispose: async () => {},
    } as unknown as import("../../src/host/host.js").RoleSession;
  }
}

class LoopFakeHost {
  readonly log: import("../../src/persistence/in-memory-log.js").InMemoryRecordLog;
  readonly queue: LoopFakeSession[] = [];
  readonly runId: string;
  readonly withHook: boolean;
  readonly enricher: {
    assess: () => Promise<import("../../src/seam/jev-assessment.js").JevAssessmentOutcome>;
  } | null;

  prepareJevAssessment?: (args: {
    readonly packet: import("../../src/persistence/phase-work-packet.js").PhaseWorkPacketRecord;
  }) => Promise<
    import("../../src/persistence/jev-assessment-record.js").JevAssessmentRecord | null
  >;

  constructor(
    log: import("../../src/persistence/in-memory-log.js").InMemoryRecordLog,
    runId: string,
    opts: {
      readonly hook: boolean;
      readonly enricher?: {
        assess: () => Promise<import("../../src/seam/jev-assessment.js").JevAssessmentOutcome>;
      };
    },
  ) {
    this.log = log;
    this.runId = runId;
    this.withHook = opts.hook;
    this.enricher = opts.enricher ?? null;
    if (opts.hook) {
      this.prepareJevAssessment = async (args) => {
        const { prepareJevAssessment } = await import("../../src/host/jev-assessment/prepare.js");
        const policy: import("../../src/manifest/types.js").JevAssessmentPolicy = {
          schema_version: 1,
          provider: "typesafe_jev",
          model: "jev-latest",
          request_timeout_ms: 1000,
          max_attempts: 1,
        };
        return prepareJevAssessment({
          log: this.log,
          runId: this.runId,
          packet: args.packet,
          policy,
          ...(this.enricher === null ? {} : { enricher: this.enricher }),
        });
      };
    }
  }

  enqueue(session: LoopFakeSession): void {
    this.queue.push(session);
  }

  async spawnRole(role: string): Promise<import("../../src/host/host.js").RoleSession> {
    const next = this.queue.shift();
    if (next === undefined) throw new Error(`queue exhausted for role '${role}'`);
    return next.toRoleSession();
  }

  captureUsage(): import("../../src/index.js").UsageRecord {
    return { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 };
  }

  persistRecord(record: import("../../src/index.js").PersistedRecord): void {
    this.log.append(record);
  }

  ensurePhaseWorkPacket(args: {
    readonly role: string;
    readonly visitIndex: number;
    readonly seed: string;
    readonly initialGoal: string;
  }): {
    readonly seedWithPacket: string;
    readonly isNew: boolean;
    readonly packet: import("../../src/persistence/phase-work-packet.js").PhaseWorkPacketRecord;
  } {
    const { materializePacketRecord, composeSeedWithPacket } = packetMaterializer;
    const records = this.log.records(this.runId);
    const { record, isNew } = materializePacketRecord({
      records,
      runId: this.runId,
      recipientRole: args.role as import("../../src/index.js").Role,
      recipientVisitIndex: args.visitIndex,
      initialGoal: args.initialGoal,
    });
    if (isNew) this.persistRecord(record);
    return { seedWithPacket: composeSeedWithPacket(args.seed, record), isNew, packet: record };
  }

  seedRunMemory(args: {
    checkpoint: import("../../src/index.js").Checkpoint;
    def: import("../../src/index.js").MachineDefinition;
    goal: string;
    runCostCap: number | null;
  }): import("../../src/index.js").RunMemory {
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

  sessionTerminalReason(): null {
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

  getNextModel(): null {
    return null;
  }

  nextVisitIndex(role: string): number {
    return (
      this.log.records(this.runId).filter((r) => r.type === "session_started" && r.role === role)
        .length + 1
    );
  }
}

function loopDef(): import("../../src/index.js").MachineDefinition {
  return Object.freeze({
    manifest_version: "1",
    orchestrator: "orchestrator",
    workers: Object.freeze(["worker"]),
    max_visits: Object.freeze({ worker: 5 }),
    end_request_roles: null,
    handoff_evidence: null,
  }) as unknown as import("../../src/index.js").MachineDefinition;
}

function transitionsOf(
  log: import("../../src/persistence/in-memory-log.js").InMemoryRecordLog,
  runId: string,
): readonly string[] {
  return log
    .records(runId)
    .filter((r) => r.type === "transition_accepted")
    .map((r) =>
      r.type === "transition_accepted" ? `${String(r.from)}->${String(r.to)}:${r.event}` : "?",
    );
}

describe("advisory layer routing identity (issue #139 Jev comment)", () => {
  async function runScenario(opts: {
    readonly hook: boolean;
    readonly enricher?: {
      assess: () => Promise<import("../../src/seam/jev-assessment.js").JevAssessmentOutcome>;
    };
  }): Promise<{
    exitReason: string;
    transitions: readonly string[];
    workerPrompt: string;
    assessments: number;
  }> {
    const { runLoop } = await import("../../src/host/loop.js");
    const { createInitialCheckpoint } = await import("../../src/core/reduce.js");
    const { InMemoryRecordLog } = await import("../../src/persistence/in-memory-log.js");
    const def = loopDef();
    const log = new InMemoryRecordLog();
    const initialCheckpoint = createInitialCheckpoint(def);
    const runId = initialCheckpoint.run_id;
    const host = new LoopFakeHost(log, runId, opts);
    const orchestrator = new LoopFakeSession("orchestrator", "sess-a1", [
      {
        kind: "emit_handoff",
        target_role: "worker",
        reason: "Worker work is complete and verified.",
      },
    ]);
    const worker = new LoopFakeSession("worker", "sess-a2", [
      { kind: "emit_handoff", target_role: "orchestrator" },
    ]);
    const fin = new LoopFakeSession("orchestrator", "sess-a3", [{ kind: "emit_end" }]);
    host.enqueue(orchestrator);
    host.enqueue(worker);
    host.enqueue(fin);
    const result = await runLoop({
      def,
      initialCheckpoint,
      host: host as unknown as import("../../src/host/host.js").Host,
      initialGoal: "ship it",
    });
    return {
      exitReason: result.exitReason,
      transitions: transitionsOf(log, runId),
      workerPrompt: worker.prompts[0] ?? "",
      assessments: log.records(runId).filter((r) => r.type === "jev_assessment").length,
    };
  }

  function completedEnricher(): {
    assess: () => Promise<import("../../src/seam/jev-assessment.js").JevAssessmentOutcome>;
  } {
    return {
      assess: async () => ({
        kind: "completed",
        actual_model: "jev-1.13.0",
        judgments: {
          relevance: {
            type: "choice",
            choice: "relevant",
            confidence: 0.9,
            probabilities: { relevant: 0.9, partially_relevant: 0.07, irrelevant: 0.03 },
          },
          consistency: {
            type: "choice",
            choice: "consistent",
            confidence: 0.8,
            probabilities: { consistent: 0.8, contradicted: 0.1, not_assessable: 0.1 },
          },
          actionable: { type: "noul", noul: 0.85 },
          next_action: {
            type: "choice",
            choice: "review",
            confidence: 0.7,
            probabilities: { review: 0.7, remediate: 0.15, block: 0.05, complete: 0.1 },
          },
        },
        usage: { input_tokens: 100, output_tokens: 20 },
        attempts: 1,
      }),
    };
  }

  it("routes identically with and without the advisory layer", async () => {
    const legacy = await runScenario({ hook: false });
    const advised = await runScenario({ hook: true, enricher: completedEnricher() });
    expect(advised.exitReason).toBe(legacy.exitReason);
    expect(advised.transitions).toEqual(legacy.transitions);
    expect(legacy.workerPrompt).not.toContain("jev_advisory");
    expect(advised.workerPrompt).toContain("### jev_advisory");
    expect(advised.assessments).toBe(1);
  });

  it("an unavailable assessment changes routing in no way", async () => {
    const legacy = await runScenario({ hook: false });
    const unavailable = await runScenario({
      hook: true,
      enricher: {
        assess: async () => ({ kind: "unavailable", code: "rate_limited", attempts: 2 }),
      },
    });
    expect(unavailable.exitReason).toBe(legacy.exitReason);
    expect(unavailable.transitions).toEqual(legacy.transitions);
    expect(unavailable.workerPrompt).toContain("unavailable");
  });
});
