/**
 * Focused tests for the chronological ledger materializer — spec §10, §11.
 *
 * Tests:
 * 1. Canonical record order: same records produce identical ledger
 * 2. Active/superseded state: supersession marks items correctly
 * 3. Byte-identical replay: repeated materialization is deterministic
 * 4. Reference rejection: forward, self, missing, and cyclic supersedes fail
 * 5. Malformed records: unsupported versions and bad schemas reject with stable diagnostics
 * 6. Empty ledger: zero continuity records produces valid empty ledger
 */

import { describe, expect, it } from "vitest";
import { stableJsonStringify } from "../../src/persistence/continuity.js";
import {
  ContinuityMaterializationException,
  materializeContinuity,
} from "../../src/persistence/continuity-materialization.js";

// ─── Helpers ───────────────────────────────────────────────────────────

function makeTransitionAccepted(recordId: string, runId: string, ts: number, continuity: unknown) {
  const accepted_handoff = continuity
    ? {
        schema_version: 1 as const,
        recipient_role: "implementer" as const,
        payload: { summary: "test", continuity },
        utf8_bytes: 12,
        continuity_evidence: [],
        continuity_packet_utf8_bytes: JSON.stringify(continuity).length,
      }
    : null;
  return {
    type: "transition_accepted" as const,
    run_id: runId,
    from: "orchestrator" as const,
    to: "implementer" as const,
    event: "handoff" as const,
    target_role: "implementer" as const,
    request_end: false,
    end_authority: null,
    end_requested_by: null,
    role: "orchestrator" as const,
    suggests_next: null,
    payload_summary: { field_names: ["summary"] },
    guard: null,
    effect: [],
    session_file: `session-${recordId}.jsonl`,
    ...(accepted_handoff !== null && { accepted_handoff }),
    ts,
  };
}

function makeSubagentCompleted(recordId: string, runId: string, ts: number, continuity: unknown) {
  const childRecord = {
    type: "subagent_completed" as const,
    run_id: runId,
    child_id: `child-${recordId}`,
    task_id: `task-${recordId}`,
    subagent: "coder",
    model: "test",
    status: "completed" as const,
    summary: "test child",
    branch: "main",
    worktree_path: "/tmp/test",
    base_commit: "0000000000000000000000000000000000000000",
    head_commit: "1111111111111111111111111111111111111111",
    session_file: `session-${recordId}.jsonl`,
    usage: { input: 100, output: 200, cache_read: 0, cache_write: 0, tokens: 300, cost: 0.01 },
    ts,
  };
  if (!continuity) return childRecord;
  return {
    ...childRecord,
    continuity: {
      packet: continuity as unknown as import("../../src/seam/continuity.js").ContinuityPacketV1,
      packet_utf8_bytes: JSON.stringify(continuity).length,
      evidence_resolutions: [],
    },
  };
}

function makeSubagentStarted(recordId: string, runId: string, ts: number) {
  return {
    type: "subagent_started" as const,
    run_id: runId,
    child_id: `child-${recordId}`,
    task_id: `task-${recordId}`,
    subagent: "coder",
    parent_role: "orchestrator",
    parent_visit_index: 2,
    model: "test",
    session_file: `session-${recordId}.jsonl`,
    worktree_path: "/tmp/test",
    branch: "main",
    base_commit: "0000000000000000000000000000000000000000",
    ts,
  };
}

function makePacket(
  summary: string,
  findings: Array<{ id: string; kind?: string; supersedes?: string[]; statement?: string }> = [],
  questions: Array<{ id: string; blocking?: boolean; supersedes?: string[] }> = [],
  nextSteps: Array<{ id: string; owner?: string; action?: string; supersedes?: string[] }> = [],
) {
  return {
    schema_version: 1,
    summary,
    findings: findings.map((f) => ({
      id: f.id,
      kind: f.kind ?? "fact",
      confidence: "observed" as const,
      statement: f.statement ?? "test finding",
      evidence: [],
      supersedes: f.supersedes ?? [],
    })),
    evaluations: [],
    open_questions: questions.map((q) => ({
      id: q.id,
      question: `question ${q.id}`,
      blocking: q.blocking ?? false,
      evidence: [],
      supersedes: q.supersedes ?? [],
    })),
    next_steps: nextSteps.map((ns) => ({
      id: ns.id,
      action: ns.action ?? "test action",
      owner: ns.owner ?? "recipient",
      evidence: [],
      supersedes: ns.supersedes ?? [],
    })),
    okf_candidate_ids: [],
  };
}

// ─── Test suite ────────────────────────────────────────────────────────

describe("continuity-materialization-order", () => {
  describe("canonical record order", () => {
    it("produces identical ledger from same records in same order", () => {
      const packet1 = makePacket("first packet", [{ id: "finding-1" }]);
      const packet2 = makePacket("second packet", [{ id: "finding-2" }]);

      const records1 = [
        makeTransitionAccepted("rec-1", "run-1", 1000, packet1),
        makeTransitionAccepted("rec-2", "run-1", 2000, packet2),
      ];

      const records2 = [
        makeTransitionAccepted("rec-1", "run-1", 1000, packet1),
        makeTransitionAccepted("rec-2", "run-1", 2000, packet2),
      ];

      const ledger1 = materializeContinuity(records1, { run_id: "run-1" });
      const ledger2 = materializeContinuity(records2, { run_id: "run-1" });

      expect(stableJsonStringify(ledger1)).toBe(stableJsonStringify(ledger2));
    });

    it("preserves immutable append order even when timestamps regress", () => {
      const packet1 = makePacket("first", [{ id: "finding-1" }]);
      const packet2 = makePacket("second", [{ id: "finding-2" }]);
      const packet3 = makePacket("third", [{ id: "finding-3" }]);

      const records = [
        makeTransitionAccepted("rec-1", "run-1", 1000, packet1),
        makeTransitionAccepted("rec-3", "run-1", 3000, packet3),
        makeTransitionAccepted("rec-2", "run-1", 2000, packet2),
      ];

      const ledger = materializeContinuity(records, { run_id: "run-1" });

      expect(ledger.envelopes.map((envelope) => envelope.packet.summary)).toEqual([
        "first",
        "third",
        "second",
      ]);
    });
  });

  describe("active / superseded state", () => {
    it("items without supersedes are active", () => {
      const packet = makePacket("test", [{ id: "f-1" }, { id: "f-2" }]);
      const records = [makeTransitionAccepted("rec-1", "run-1", 1000, packet)];
      const ledger = materializeContinuity(records, { run_id: "run-1" });

      const active = ledger.findings.filter((f) => f.superseded_by.length === 0);
      expect(active).toHaveLength(2);
      expect(ledger.counts.active_finding_count).toBe(2);
      expect(ledger.counts.superseded_finding_count).toBe(0);
    });

    it("newer item supersedes earlier item listed in its supersedes", () => {
      const packet1 = makePacket("first", [{ id: "f-1", kind: "fact", statement: "old finding" }]);
      const packet2 = makePacket("second", [
        { id: "f-2", kind: "fact", statement: "new finding", supersedes: ["f-1"] },
      ]);

      const records = [
        makeTransitionAccepted("rec-1", "run-1", 1000, packet1),
        makeTransitionAccepted("rec-2", "run-1", 2000, packet2),
      ];

      const ledger = materializeContinuity(records, { run_id: "run-1" });

      // f-1 is superseded by f-2
      const f1 = ledger.findings.find((f) => f.item.id === "f-1");
      expect(f1).toBeDefined();
      expect(f1?.superseded_by).toEqual(["f-2"]);

      // f-2 is active (not superseded)
      const f2 = ledger.findings.find((f) => f.item.id === "f-2");
      expect(f2).toBeDefined();
      expect(f2?.superseded_by).toEqual([]);

      expect(ledger.counts.active_finding_count).toBe(1);
      expect(ledger.counts.superseded_finding_count).toBe(1);
    });

    it("superseded items are retained in the ledger (not removed)", () => {
      const packet1 = makePacket("first", [{ id: "f-1" }]);
      const packet2 = makePacket("second", [{ id: "f-2", supersedes: ["f-1"] }]);

      const records = [
        makeTransitionAccepted("rec-1", "run-1", 1000, packet1),
        makeTransitionAccepted("rec-2", "run-1", 2000, packet2),
      ];

      const ledger = materializeContinuity(records, { run_id: "run-1" });

      // Both items present
      const allFindingIds = ledger.findings.map((f) => f.item.id);
      expect(allFindingIds).toContain("f-1");
      expect(allFindingIds).toContain("f-2");
    });
  });

  describe("reference rejection", () => {
    it("rejects self-reference supersedes", () => {
      const packet = makePacket("test", [{ id: "f-1", supersedes: ["f-1"] }]);
      const records = [makeTransitionAccepted("rec-1", "run-1", 1000, packet)];

      expect(() => materializeContinuity(records, { run_id: "run-1" })).toThrow(
        ContinuityMaterializationException,
      );
    });

    it("rejects missing (unknown) supersedes target", () => {
      const packet = makePacket("test", [{ id: "f-2", supersedes: ["f-nonexistent"] }]);
      const records = [makeTransitionAccepted("rec-1", "run-1", 1000, packet)];

      expect(() => materializeContinuity(records, { run_id: "run-1" })).toThrow(
        ContinuityMaterializationException,
      );
    });

    it("rejects forward reference (same-envelope later item)", () => {
      // Within one packet, item order matters: an item can't supersede a later item
      // in the same packet because the later item hasn't been seen yet.
      const packet = makePacket("test", [
        { id: "f-1", supersedes: ["f-2"] }, // f-1 tries to supersede f-2 which comes after
        { id: "f-2" },
      ]);
      const records = [makeTransitionAccepted("rec-1", "run-1", 1000, packet)];

      expect(() => materializeContinuity(records, { run_id: "run-1" })).toThrow(
        ContinuityMaterializationException,
      );
    });

    it("records stable diagnostic with record identity on rejection", () => {
      const packet = makePacket("test", [{ id: "f-1", supersedes: ["f-1"] }]);
      const records = [makeTransitionAccepted("rec-synthetic-42", "run-1", 1000, packet)];

      try {
        materializeContinuity(records, { run_id: "run-1" });
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ContinuityMaterializationException);
        const exc = error as ContinuityMaterializationException;
        expect(exc.record_id).toContain("rec-synthetic-42");
        expect(exc.code).toBe("continuity_malformed_record");
        expect(exc.message).toContain("f-1");
      }
    });
  });

  describe("malformed records", () => {
    it("rejects record with unsupported schema version", () => {
      const packet = { ...makePacket("test"), schema_version: 99 };
      const records = [makeTransitionAccepted("rec-1", "run-1", 1000, packet)];

      expect(() => materializeContinuity(records, { run_id: "run-1" })).toThrow(
        ContinuityMaterializationException,
      );
    });

    it("rejects record with non-object packet", () => {
      const records = [makeTransitionAccepted("rec-1", "run-1", 1000, "not-an-object")];
      expect(() => materializeContinuity(records, { run_id: "run-1" })).toThrow(
        ContinuityMaterializationException,
      );
    });

    it("skips records without continuity (legacy accepted_handoff)", () => {
      const records = [
        makeTransitionAccepted("rec-1", "run-1", 1000, null), // no continuity
      ];

      const ledger = materializeContinuity(records, { run_id: "run-1" });
      expect(ledger.envelopes).toHaveLength(0);
    });
  });

  describe("byte-identical replay", () => {
    it("three repeated materializations produce byte-identical JSON", () => {
      const packet = makePacket("stable packet", [
        { id: "f-1", statement: "stable finding" },
        { id: "f-2", statement: "another finding" },
      ]);
      const records = [makeTransitionAccepted("rec-1", "run-1", 1000, packet)];

      const ledger1 = materializeContinuity(records, { run_id: "run-1" });
      const ledger2 = materializeContinuity(records, { run_id: "run-1" });
      const ledger3 = materializeContinuity(records, { run_id: "run-1" });

      const json1 = stableJsonStringify(ledger1);
      const json2 = stableJsonStringify(ledger2);
      const json3 = stableJsonStringify(ledger3);

      expect(json1).toBe(json2);
      expect(json2).toBe(json3);
    });

    it("ledger envelope order is stable across replays", () => {
      const packet1 = makePacket("A", [{ id: "a" }]);
      const packet2 = makePacket("B", [{ id: "b" }]);
      const packet3 = makePacket("C", [{ id: "c" }]);

      const records = [
        makeTransitionAccepted("rec-3", "run-1", 3000, packet3),
        makeTransitionAccepted("rec-1", "run-1", 1000, packet1),
        makeTransitionAccepted("rec-2", "run-1", 2000, packet2),
      ];

      const ledger1 = materializeContinuity(records, { run_id: "run-1" });
      const ledger2 = materializeContinuity(records, { run_id: "run-1" });

      expect(ledger1.envelopes.map((e) => e.packet.summary)).toEqual(
        ledger2.envelopes.map((e) => e.packet.summary),
      );
    });
  });

  describe("empty ledger", () => {
    it("no continuity records produces valid empty ledger", () => {
      const records = [makeTransitionAccepted("rec-1", "run-1", 1000, null)];

      const ledger = materializeContinuity(records, { run_id: "run-1" });

      expect(ledger.envelopes).toHaveLength(0);
      expect(ledger.findings).toHaveLength(0);
      expect(ledger.evaluations).toHaveLength(0);
      expect(ledger.open_questions).toHaveLength(0);
      expect(ledger.next_steps).toHaveLength(0);
      expect(ledger.okf_candidates).toHaveLength(0);
      expect(ledger.counts.envelope_count).toBe(0);
    });

    it("mixed records with only legacy ones produces empty ledger", () => {
      const records = [
        makeTransitionAccepted("rec-1", "run-1", 1000, null),
        {
          type: "session_started" as const,
          run_id: "run-1",
          role: "orchestrator" as const,
          visit_index: 1,
          state: "orchestrator" as const,
          model: "test",
          session_file: "s1",
          parent_session: null,
          ts: 500,
        },
      ];

      const ledger = materializeContinuity(records, { run_id: "run-1" });
      expect(ledger.envelopes).toHaveLength(0);
    });
  });

  it("replays one handoff and one child result after a restart", () => {
    const handoffPacket = makePacket("handoff", [{ id: "h-1", statement: "handoff finding" }]);
    const childPacket = makePacket("child", [{ id: "c-1", statement: "child finding" }]);
    const records = [
      makeTransitionAccepted("handoff", "run-1", 1000, handoffPacket),
      makeSubagentStarted("child-e2e", "run-1", 1500),
      makeSubagentCompleted("child-e2e", "run-1", 2000, childPacket),
    ];

    const restarted = materializeContinuity(JSON.parse(JSON.stringify(records)), {
      run_id: "run-1",
    });

    expect(restarted.envelopes.map((envelope) => envelope.source)).toEqual([
      "handoff",
      "delegated_result",
    ]);
    expect(restarted.findings.map((finding) => finding.item.id)).toEqual(["h-1", "c-1"]);
  });

  describe("delegated result envelopes", () => {
    it("extracts continuity from subagent_completed records", () => {
      const packet = makePacket("child result", [{ id: "cf-1", statement: "child finding" }]);
      const records = [
        makeSubagentStarted("child-1", "run-1", 1000),
        makeSubagentCompleted("child-1", "run-1", 2000, packet),
      ];

      const ledger = materializeContinuity(records, { run_id: "run-1" });

      expect(ledger.envelopes).toHaveLength(1);
      const envelope = ledger.envelopes[0];
      expect(envelope).toBeDefined();
      expect(envelope?.source).toBe("delegated_result");
      expect(envelope?.child?.child_id).toBe("child-child-1");
      expect(envelope?.role).toBe("orchestrator");
      expect(envelope?.visit).toBe(2);
    });
  });
});
