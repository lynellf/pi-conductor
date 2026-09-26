import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileRecordLog } from "../../src/host/log-file.js";
import { materializePacketRecord } from "../../src/host/phase-work-packet-materializer.js";
import type { PersistedRecord } from "../../src/persistence/log.js";
import {
  assertPhaseWorkPacketRecord,
  createPhaseWorkPacketRecord,
} from "../../src/persistence/phase-work-packet.js";

import { createReviewGatePinnedRecord } from "../../src/persistence/review.js";

const runId = "packet-budget-run";

function history(): PersistedRecord[] {
  return [
    ...Array.from(
      { length: 200 },
      (_, i): PersistedRecord => ({
        type: "session_started",
        run_id: runId,
        role: "hub",
        state: "hub",
        visit_index: i + 1,
        model: null,
        parent_session: null,
        session_file: `/sessions/hub-${i}.jsonl`,
        ts: i,
      }),
    ),
    {
      type: "transition_accepted",
      run_id: runId,
      from: "hub",
      to: "worker",
      event: "handoff",
      target_role: "worker",
      role: "hub",
      request_end: false,
      end_authority: null,
      end_requested_by: null,
      suggests_next: null,
      payload_summary: { field_names: [] },
      guard: null,
      effect: [],
      session_file: "/sessions/hub-199.jsonl",
      context_ref: null,
      ts: 201,
    },
  ];
}

function materialize(records: readonly PersistedRecord[]) {
  return materializePacketRecord({
    records,
    runId,
    recipientRole: "worker",
    recipientVisitIndex: 8,
    initialGoal: "complete bounded work",
  });
}

function observedPacket(maxBytes: number, paths: number) {
  return createPhaseWorkPacketRecord({
    run_id: runId,
    recipient_role: "worker",
    recipient_visit_index: 1,
    dispatch_source: { kind: "initial_run", run_id: runId, initial_goal: "goal", ts: 1 },
    cutoff_record_keys: ["handoff_evidence:0"],
    max_utf8_bytes: maxBytes,
    records: [
      {
        type: "handoff_evidence",
        schema_version: 1,
        run_id: runId,
        handoff_id: "handoff",
        ts: 1,
        worktree: {
          head: "a".repeat(40),
          dirty_paths: Array.from({ length: paths }, (_, i) => ({
            path: `src/private-${i}.ts`,
            preexisting: false,
          })),
        },
        commands: Array.from({ length: 16 }, (_, i) => ({
          command: `check-${i} ${"測".repeat(90)}`,
          host_exit_status: i % 2,
          elapsed_ms: 1,
          output_digest: "a".repeat(64),
          output_head: "",
        })),
        omitted: { dirty_paths: 0, commands: 0 },
      },
    ],
  });
}

describe("phase packet budget recovery", () => {
  it("bounds a long-history packet without dropping its durable source cutoff or identity", () => {
    const records = history();
    const before = JSON.stringify(records);
    const { record } = materialize(records);
    expect(record.utf8_bytes).toBeLessThanOrEqual(4096);
    assertPhaseWorkPacketRecord(record);
    expect(record.cutoff_record_keys).toEqual(records.map((r, i) => `${r.type}:${i}`));
    expect(record.dispatch_source).toMatchObject({
      source_record_key: "transition_accepted:200",
      to_role: "worker",
    });
    expect(record.rendered).toContain("transition_accepted:200");
    expect(record.rendered).toContain(
      createHash("sha256").update(JSON.stringify(record.cutoff_record_keys)).digest("hex"),
    );
    expect(record.omissions).toContainEqual({ kind: "cutoff_keys_summarized", count: 201 });
    expect(record.phase_process.state).toEqual({
      kind: "fsm_visit",
      role: "worker",
      visit_index: 8,
    });
    expect(JSON.stringify(records)).toBe(before);
    expect(materialize(records).record).toEqual(record);
  });

  it("appends, reopens and reuses the exact packet after a later optional record", () => {
    const dir = mkdtempSync(join(tmpdir(), "packet-budget-"));
    try {
      const records = history();
      const { record } = materialize(records);
      const writer = new FileRecordLog({ baseDir: dir });
      try {
        for (const source of records) writer.append(source);
        writer.append(record);
        writer.append({
          type: "file_mutation",
          run_id: runId,
          role: "hub",
          session_id: "later",
          session_file: "/sessions/later",
          tool_name: "write",
          files: [{ path: "late.ts" }],
          ts: 202,
        });
      } finally {
        writer.close();
      }
      const reader = new FileRecordLog({ baseDir: dir });
      try {
        const replay = materialize(reader.records(runId));
        expect(replay.isNew).toBe(false);
        expect(replay.record).toEqual(record);
      } finally {
        reader.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    1600, 2048, 3000, 4096,
  ])("includes all omission counters inside the %i-byte budget", (maxBytes) => {
    const record = observedPacket(maxBytes, 0);
    assertPhaseWorkPacketRecord(record);
    expect(record.utf8_bytes).toBe(Buffer.byteLength(record.rendered, "utf8"));
    expect(record.utf8_bytes).toBeLessThanOrEqual(maxBytes);
    const omitted = record.omissions.find((o) => o.kind === "commands_dropped");
    expect(omitted?.count).toBeGreaterThan(0);
    expect(record.rendered).toContain(`- commands_dropped (count=${omitted?.count})`);
    expect(record.host_observed.commands).toHaveLength(16);
  });

  it("omits optional dirty-path rows with counts but retains the revision and full structured evidence", () => {
    const record = observedPacket(2048, 64);
    assertPhaseWorkPacketRecord(record);
    expect(record.utf8_bytes).toBeLessThanOrEqual(2048);
    expect(record.host_observed.worktree).toMatchObject({
      head: "a".repeat(40),
      dirty_paths: expect.any(Array),
    });
    if (record.host_observed.worktree.kind !== "snapshot") throw Error("expected snapshot");
    expect(record.host_observed.worktree.dirty_paths).toHaveLength(64);
    const omitted = record.omissions.find((o) => o.kind === "dirty_paths_dropped");
    expect(omitted?.count).toBeGreaterThan(0);
    expect(record.rendered).toContain(`- dirty_paths_dropped (count=${omitted?.count})`);
    expect(record.rendered).toContain(`worktree.head: ${"a".repeat(40)}`);
    expect(record.rendered).not.toContain("src/private-");
  });

  it("keeps a missing-review blocker and process identity while counting omitted verification", () => {
    const record = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: "worker",
      recipient_visit_index: 1,
      dispatch_source: {
        kind: "review_route",
        run_id: runId,
        source_record_key: "review_route:1",
        route_role: "worker",
        advances_phase: false,
        ts: 2,
      },
      cutoff_record_keys: ["review_gate_pinned:0"],
      max_utf8_bytes: 2048,
      records: [
        createReviewGatePinnedRecord({
          run_id: runId,
          phase_id: "phase",
          gate_id: "gate",
          phase_owner_role: "worker",
          reviewer_role: "reviewer",
          reviewed_revision: "a".repeat(40),
          ts: 1,
          evidence: {
            revision: "a".repeat(40),
            checks: Array.from({ length: 16 }, (_, i) => ({
              name: `check-${i}-${"x".repeat(100)}`,
              outcome: "passed",
            })),
          },
        }),
      ],
    });
    assertPhaseWorkPacketRecord(record);
    expect(record.status).toBe("blocked");
    expect(record.phase_process.legal_action.kind).toBe("halt");
    expect(record.rendered).toContain("missing_reviewer_decision");
    expect(record.rendered).toContain("state.phase_id: phase");
    expect(record.rendered).toContain("state.gate_id: gate");
    const omitted = record.omissions.find((o) => o.kind === "verification_dropped");
    expect(omitted?.count).toBeGreaterThan(0);
    expect(record.rendered).toContain(`- verification_dropped (count=${omitted?.count})`);
  });

  it("still rejects an irreducible packet at the persistence boundary rather than raising its cap", () => {
    const record = observedPacket(1, 0);
    expect(record.budget.max_bytes).toBe(1);
    expect(() => assertPhaseWorkPacketRecord(record)).toThrow("exceeds the configured budget");
  });
});
