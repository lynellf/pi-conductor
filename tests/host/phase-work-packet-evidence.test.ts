import { describe, expect, it } from "vitest";
import { materializePacketRecord } from "../../src/host/phase-work-packet-materializer.js";
import type { PersistedRecord } from "../../src/persistence/log.js";

const runId = "run-143";
const sessionFile = "/sessions/worker.jsonl";
const start = {
  type: "session_started",
  run_id: runId,
  role: "worker",
  visit_index: 1,
  state: "worker",
  model: null,
  session_file: sessionFile,
  role_session_id: "role-1",
  parent_session: null,
  ts: 1,
} as const satisfies PersistedRecord;
const handoff = {
  type: "transition_accepted",
  run_id: runId,
  from: "worker",
  to: "orchestrator",
  role: "worker",
  event: "handoff",
  session_file: sessionFile,
  ts: 10,
  accepted_control: {
    schema_version: 2,
    direction: "return",
    task: {},
    reported_hints: { summary: "tests passed", verification: ["all tests passed"] },
    ignored_hint_fields: [],
    utf8_bytes: 0,
  },
} as unknown as PersistedRecord;

function packet(records: PersistedRecord[], maxUtf8Bytes?: number) {
  return materializePacketRecord({
    records,
    runId,
    recipientRole: "orchestrator",
    recipientVisitIndex: 2,
    initialGoal: "goal",
    ...(maxUtf8Bytes === undefined ? {} : { maxUtf8Bytes }),
  }).record;
}

describe("issue #143 predecessor host evidence", () => {
  it("exposes correlated terminal, artifact and mutation references without promoting claims", () => {
    const records: PersistedRecord[] = [
      start,
      {
        type: "tool_execution_finished",
        schema_version: 1,
        run_id: runId,
        execution_id: "exec-1",
        supervision_id: "sup-1",
        logical_session_id: "logical-1",
        role_session_id: "role-1",
        tool_call_id: "call-1",
        tool_name: "bash",
        elapsed_ms: 1,
        recovery_count: 0,
        outcome: "completed",
        cleanup: "confirmed",
        ts: 2,
      },
      {
        type: "artifact_collected",
        run_id: runId,
        role: "worker",
        visit_index: 1,
        session_id: "role-1",
        source_path: "result.patch",
        stored_path: "/artifacts/result.patch",
        kind: "auto_patch",
        bytes: 20,
        sha256: "a".repeat(64),
        ts: 3,
      },
      {
        type: "file_mutation",
        run_id: runId,
        role: "worker",
        session_id: "role-1",
        session_file: sessionFile,
        tool_name: "edit",
        files: [{ path: "src/app.ts", additions: 1 }],
        ts: 4,
      },
      handoff,
    ];
    const result = packet(records);
    expect(result.host_observed.evidence_refs).toEqual([
      {
        source_key: "tool_execution_finished:1",
        kind: "tool_outcome",
        ref: "exec-1",
        outcome: "completed",
      },
      {
        source_key: "artifact_collected:2",
        kind: "artifact",
        ref: "a".repeat(64),
        outcome: "auto_patch",
      },
      {
        source_key: "file_mutation:3",
        kind: "file_mutation",
        ref: expect.stringMatching(/^[a-f0-9]{12}$/),
        outcome: "edit",
      },
    ]);
    expect(result.host_observed.verification).toEqual([]);
    expect(result.rendered).toContain("[tool_execution_finished:1]");
    expect(result.rendered).not.toContain("src/app.ts");
  });

  it("does not claim observed evidence for unrelated sessions or records after dispatch", () => {
    const records: PersistedRecord[] = [
      start,
      {
        type: "file_mutation",
        run_id: runId,
        role: "worker",
        session_id: "other",
        session_file: "/sessions/other",
        tool_name: "write",
        files: [{ path: "secret" }],
        ts: 2,
      },
      handoff,
      {
        type: "file_mutation",
        run_id: runId,
        role: "worker",
        session_id: "role-1",
        session_file: sessionFile,
        tool_name: "edit",
        files: [{ path: "late" }],
        ts: 11,
      },
    ];
    const result = packet(records);
    expect(result.host_observed.evidence_refs).toEqual([]);
    expect(result.host_observed.verification).toEqual([]);
    expect(result.omissions).toContainEqual({ kind: "predecessor_evidence_unavailable" });
  });

  it("does not promote reported verification without a predecessor session record", () => {
    const result = packet([handoff]);
    expect(result.host_observed.verification).toEqual([]);
    expect(result.host_observed.evidence_refs).toEqual([]);
    expect(result.omissions).toContainEqual({ kind: "predecessor_evidence_unavailable" });
  });

  it("references artifacts collected after acceptance for the same predecessor visit", () => {
    const records: PersistedRecord[] = [
      start,
      handoff,
      {
        type: "artifact_collected",
        run_id: runId,
        role: "worker",
        visit_index: 1,
        session_id: "role-1",
        source_path: "patch",
        stored_path: "/artifacts/patch",
        kind: "auto_patch",
        bytes: 2,
        sha256: "b".repeat(64),
        ts: 11,
      },
      {
        type: "artifact_collected",
        run_id: runId,
        role: "worker",
        visit_index: 2,
        session_id: "other",
        source_path: "wrong",
        stored_path: "/artifacts/wrong",
        kind: "declared",
        bytes: 2,
        sha256: "c".repeat(64),
        ts: 12,
      },
    ];
    expect(packet(records).host_observed.evidence_refs).toEqual([
      {
        source_key: "artifact_collected:2",
        kind: "artifact",
        ref: "b".repeat(64),
        outcome: "auto_patch",
      },
    ]);
  });

  it("reports evidence records excluded from the source cutoff", () => {
    const records: PersistedRecord[] = [
      start,
      ...Array.from(
        { length: 80 },
        (_, i): PersistedRecord => ({
          type: "file_mutation",
          run_id: runId,
          role: "worker",
          session_id: "role-1",
          session_file: sessionFile,
          tool_name: "edit",
          files: [{ path: `src/${i}.ts` }],
          ts: 2,
        }),
      ),
      handoff,
    ];
    expect(packet(records).omissions).toContainEqual({
      kind: "evidence_cutoff_dropped",
      count: 16,
    });
  });

  it("drops optional references with a typed count when the packet budget is tight", () => {
    const records: PersistedRecord[] = [
      start,
      ...Array.from(
        { length: 30 },
        (_, i): PersistedRecord => ({
          type: "file_mutation",
          run_id: runId,
          role: "worker",
          session_id: "role-1",
          session_file: sessionFile,
          tool_name: "edit",
          files: [{ path: `src/${i}.ts` }],
          ts: 2,
        }),
      ),
      handoff,
    ];
    const result = packet(records, 1900);
    expect(result.utf8_bytes).toBeLessThanOrEqual(1900);
    expect(result.omissions).toContainEqual(
      expect.objectContaining({ kind: "evidence_refs_dropped", count: expect.any(Number) }),
    );
  });
});
