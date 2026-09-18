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
import { renderLedgerJson, renderLedgerMarkdown } from "../../src/persistence/continuity-render.js";
import type { PersistedRecord } from "../../src/persistence/log.js";

// ─── Helpers ───────────────────────────────────────────────────────────

function makeTransitionAccepted(recordId: string, runId: string, ts: number, continuity: unknown) {
  const accepted_handoff = continuity
    ? {
        schema_version: 1 as const,
        recipient_role: "implementer" as const,
        payload: { summary: "test", continuity },
        utf8_bytes: 12,
        continuity_evidence: [] as import("../../src/core/types.js").ContinuityEvidenceResolution[],
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

function makeSubagentCompleted(
  recordId: string,
  runId: string,
  ts: number,
  continuity: unknown,
  childId = `child-${recordId}`,
  taskId = `task-${recordId}`,
) {
  const childRecord = {
    type: "subagent_completed" as const,
    run_id: runId,
    child_id: childId,
    task_id: taskId,
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

function makeSubagentStarted(
  recordId: string,
  runId: string,
  ts: number,
  childId = `child-${recordId}`,
  taskId = `task-${recordId}`,
) {
  return {
    type: "subagent_started" as const,
    run_id: runId,
    child_id: childId,
    task_id: taskId,
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
): import("../../src/seam/continuity.js").ContinuityPacketV1 {
  return {
    schema_version: 1,
    summary,
    findings: findings.map((f) => ({
      id: f.id,
      kind: (f.kind ?? "fact") as "fact" | "decision" | "negative_result" | "risk",
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
      owner: (ns.owner ?? "recipient") as "parent" | "recipient" | "reviewer" | "operator",
      evidence: [],
      supersedes: ns.supersedes ?? [],
    })),
    okf_candidate_ids: [],
  };
}

function makeChildExecution(childId: string, executionId: string, ts: number): PersistedRecord[] {
  const common = {
    schema_version: 1 as const,
    run_id: "run-1",
    execution_id: executionId,
    supervision_id: `supervision-${executionId}`,
    logical_session_id: `logical-${executionId}`,
    role_session_id: childId,
    tool_call_id: `call-${executionId}`,
    tool_name: "bash",
  };
  return [
    {
      type: "tool_execution_started" as const,
      ...common,
      timeout_ms: 10,
      recovery_count: 0,
      sandbox: {
        child_id: childId,
        descriptor: {
          backend: "bubblewrap" as const,
          execution_policy_digest: "a".repeat(64),
          runtime_digest: "b".repeat(64),
          materialization_id: "materialization",
        },
      },
      ts,
    },
    {
      type: "tool_execution_finished" as const,
      ...common,
      elapsed_ms: 1,
      recovery_count: 0,
      outcome: "interrupted" as const,
      cleanup: "confirmed" as const,
      sandbox: {
        category: "interrupted" as const,
        normalized_status: null,
        signal: "unknown" as const,
        termination_requested: false,
        cleanup: "confirmed" as const,
      },
      ts: ts + 1,
    },
  ];
}

function withLifecycles(records: readonly PersistedRecord[]): PersistedRecord[] {
  const seen = new Set<string>();
  const out: PersistedRecord[] = [];
  for (const record of records) {
    if (
      record.type === "transition_accepted" &&
      typeof record.session_file === "string" &&
      !seen.has(record.session_file)
    ) {
      seen.add(record.session_file);
      out.push({
        type: "session_started",
        run_id: record.run_id,
        role: record.role,
        visit_index: 1,
        state: record.role,
        model: "test",
        session_file: record.session_file,
        parent_session: null,
        ts: record.ts - 1,
      });
    }
    out.push(record);
  }
  return out;
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

      const ledger1 = materializeContinuity(withLifecycles(records1), { run_id: "run-1" });
      const ledger2 = materializeContinuity(withLifecycles(records2), { run_id: "run-1" });

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

      const ledger = materializeContinuity(withLifecycles(records), { run_id: "run-1" });

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
      const ledger = materializeContinuity(withLifecycles(records), { run_id: "run-1" });

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

      const ledger = materializeContinuity(withLifecycles(records), { run_id: "run-1" });

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

      const ledger = materializeContinuity(withLifecycles(records), { run_id: "run-1" });

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

      expect(() => materializeContinuity(withLifecycles(records), { run_id: "run-1" })).toThrow(
        ContinuityMaterializationException,
      );
    });

    it("rejects missing (unknown) supersedes target", () => {
      const packet = makePacket("test", [{ id: "f-2", supersedes: ["f-nonexistent"] }]);
      const records = [makeTransitionAccepted("rec-1", "run-1", 1000, packet)];

      expect(() => materializeContinuity(withLifecycles(records), { run_id: "run-1" })).toThrow(
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

      expect(() => materializeContinuity(withLifecycles(records), { run_id: "run-1" })).toThrow(
        ContinuityMaterializationException,
      );
    });

    it("records stable diagnostic with record identity on rejection", () => {
      const packet = makePacket("test", [{ id: "f-1", supersedes: ["f-1"] }]);
      const records = [makeTransitionAccepted("rec-synthetic-42", "run-1", 1000, packet)];

      try {
        materializeContinuity(withLifecycles(records), { run_id: "run-1" });
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

  describe("replay authority", () => {
    it("rejects a continuity handoff without its preceding role lifecycle", () => {
      const records = [
        makeTransitionAccepted("orphan", "run-1", 1000, makePacket("orphan", [{ id: "f-1" }])),
      ];
      expect(() => materializeContinuity(records, { run_id: "run-1" })).toThrow(
        ContinuityMaterializationException,
      );
    });

    it("rejects extra or wrong-kind evidence resolutions rather than verifying a finding", () => {
      const packet = {
        ...makePacket("evidence", [{ id: "f-1" }]),
        findings: [
          {
            id: "f-1",
            kind: "fact",
            confidence: "verified" as const,
            statement: "must bind evidence",
            evidence: [{ kind: "external" as const, url: "https://example.com", title: "source" }],
            supersedes: [],
          },
        ],
      };
      const record = makeTransitionAccepted("evidence", "run-1", 1000, packet);
      const handoff = record.accepted_handoff;
      expect(handoff).toBeDefined();
      if (handoff === undefined) throw new Error("test handoff missing");
      handoff.continuity_evidence = [
        { ref_key: "findings:f-1:0", kind: "repository", status: "verified" },
        { ref_key: "extra", kind: "external", status: "declared" },
      ] as const;
      expect(() => materializeContinuity(withLifecycles([record]), { run_id: "run-1" })).toThrow(
        ContinuityMaterializationException,
      );
    });

    it("rejects an external reference promoted to verified during replay", () => {
      const packet = {
        ...makePacket("external", [{ id: "f-1" }]),
        findings: [
          {
            id: "f-1",
            kind: "fact" as const,
            confidence: "verified" as const,
            statement: "external cannot be verified by v1",
            evidence: [{ kind: "external" as const, url: "https://example.com", title: "source" }],
            supersedes: [],
          },
        ],
      };
      const record = makeTransitionAccepted("external", "run-1", 1000, packet);
      if (record.accepted_handoff === undefined) throw new Error("test handoff missing");
      record.accepted_handoff.continuity_evidence = [
        { ref_key: "findings:f-1:0", kind: "external", status: "verified" },
      ] as const;
      expect(() => materializeContinuity(withLifecycles([record]), { run_id: "run-1" })).toThrow(
        ContinuityMaterializationException,
      );
    });

    it("rejects a child packet that promotes a sibling execution", () => {
      const packet = {
        ...makePacket("child authority", [{ id: "f-child" }]),
        findings: [
          {
            id: "f-child",
            kind: "fact" as const,
            confidence: "verified" as const,
            statement: "sibling execution must not verify this child",
            evidence: [{ kind: "tool_execution" as const, execution_id: "exec-sibling" }],
            supersedes: [],
          },
        ],
      };
      const completed = makeSubagentCompleted(
        "a",
        "run-1",
        10,
        packet,
      ) as import("../../src/persistence/log.js").SubagentCompletedRecord;
      if (completed.continuity === undefined) throw new Error("test child continuity missing");
      completed.continuity.evidence_resolutions = [
        { ref_key: "findings:f-child:0", kind: "tool_execution", status: "verified" },
      ] as const;
      const common = {
        schema_version: 1 as const,
        run_id: "run-1",
        execution_id: "exec-sibling",
        supervision_id: "supervision-sibling",
        logical_session_id: "logical-sibling",
        role_session_id: "role-sibling",
        tool_call_id: "call-sibling",
        tool_name: "bash",
      };
      const records = [
        makeSubagentStarted("a", "run-1", 1),
        makeSubagentStarted("b", "run-1", 2),
        {
          type: "tool_execution_started" as const,
          ...common,
          timeout_ms: 10,
          recovery_count: 0,
          sandbox: {
            child_id: "child-b",
            descriptor: {
              backend: "bubblewrap" as const,
              execution_policy_digest: "a".repeat(64),
              runtime_digest: "b".repeat(64),
              materialization_id: "m",
            },
          },
          ts: 3,
        },
        {
          type: "tool_execution_finished" as const,
          ...common,
          elapsed_ms: 1,
          recovery_count: 0,
          outcome: "completed" as const,
          cleanup: "confirmed" as const,
          sandbox: {
            category: "command_status" as const,
            normalized_status: 0,
            signal: "unknown" as const,
            termination_requested: false,
            cleanup: "confirmed" as const,
          },
          ts: 4,
        },
        completed,
      ];
      expect(() => materializeContinuity(withLifecycles(records), { run_id: "run-1" })).toThrow(
        ContinuityMaterializationException,
      );
    });

    it("binds child execution evidence to the recorded retry attempt", () => {
      const packet = makePacket("retry", [{ id: "f-retry" }]);
      packet.findings = [
        {
          id: "f-retry",
          kind: "fact",
          confidence: "verified",
          statement: "current retry execution",
          evidence: [{ kind: "tool_execution", execution_id: "exec-new" }],
          supersedes: [],
        },
      ];
      const completed = makeSubagentCompleted(
        "second",
        "run-1",
        20,
        packet,
        "child-retry",
        "task-retry",
      ) as import("../../src/persistence/log.js").SubagentCompletedRecord;
      if (completed.continuity === undefined) throw new Error("test child continuity missing");
      completed.continuity.evidence_resolutions = [
        { ref_key: "findings:f-retry:0", kind: "tool_execution", status: "verified" },
      ];
      const records = withLifecycles([
        makeSubagentStarted("first", "run-1", 1, "child-retry", "task-retry"),
        ...makeChildExecution("child-retry", "exec-old", 2),
        makeSubagentCompleted("first", "run-1", 4, null, "child-retry", "task-retry"),
        makeSubagentStarted("second", "run-1", 5, "child-retry", "task-retry"),
        ...makeChildExecution("child-retry", "exec-new", 6),
        completed,
      ]);

      const ledger = materializeContinuity(records, { run_id: "run-1" });
      expect(ledger.envelopes[0]?.child?.attempt).toBe(2);
      expect(ledger.findings[0]?.item.id).toBe("f-retry");

      const stalePacket = {
        ...packet,
        findings: packet.findings.map((finding) => ({
          ...finding,
          evidence: [{ kind: "tool_execution" as const, execution_id: "exec-old" }],
        })),
      };
      const staleCompleted = makeSubagentCompleted(
        "second",
        "run-1",
        20,
        stalePacket,
        "child-retry",
        "task-retry",
      ) as import("../../src/persistence/log.js").SubagentCompletedRecord;
      if (staleCompleted.continuity === undefined) throw new Error("test stale continuity missing");
      staleCompleted.continuity.evidence_resolutions = [
        { ref_key: "findings:f-retry:0", kind: "tool_execution", status: "verified" },
      ];
      expect(() =>
        materializeContinuity(
          withLifecycles([
            makeSubagentStarted("first", "run-1", 1, "child-retry", "task-retry"),
            ...makeChildExecution("child-retry", "exec-old", 2),
            makeSubagentCompleted("first", "run-1", 4, null, "child-retry", "task-retry"),
            makeSubagentStarted("second", "run-1", 5, "child-retry", "task-retry"),
            ...makeChildExecution("child-retry", "exec-new", 6),
            staleCompleted,
          ]),
          { run_id: "run-1" },
        ),
      ).toThrow(ContinuityMaterializationException);
    });

    it("folds evaluation supersession from older item to newer item", () => {
      const first = makePacket("first");
      first.evaluations = [{ id: "e-1", label: "old", execution_id: "exec-1", supersedes: [] }];
      const second = makePacket("second");
      second.evaluations = [
        { id: "e-2", label: "new", execution_id: "exec-1", supersedes: ["e-1"] },
      ];
      const start = {
        type: "tool_execution_started" as const,
        schema_version: 1 as const,
        run_id: "run-1",
        execution_id: "exec-1",
        supervision_id: "supervision-1",
        logical_session_id: "logical-1",
        role_session_id: "role-1",
        tool_call_id: "call-1",
        tool_name: "bash",
        timeout_ms: 100,
        recovery_count: 0,
        ts: 1,
      };
      const finished = {
        type: "tool_execution_finished" as const,
        schema_version: 1 as const,
        run_id: "run-1",
        execution_id: "exec-1",
        supervision_id: "supervision-1",
        logical_session_id: "logical-1",
        role_session_id: "role-1",
        tool_call_id: "call-1",
        tool_name: "bash",
        elapsed_ms: 1,
        recovery_count: 0,
        outcome: "completed" as const,
        cleanup: "confirmed" as const,
        ts: 2,
      };
      const ledger = materializeContinuity(
        withLifecycles([
          start,
          finished,
          makeTransitionAccepted("one", "run-1", 1000, first),
          makeTransitionAccepted("two", "run-1", 2000, second),
        ]),
        { run_id: "run-1" },
      );
      expect(
        ledger.evaluations.find((evaluation) => evaluation.id === "e-1")?.superseded_by,
      ).toEqual(["e-2"]);
      expect(
        ledger.evaluations.find((evaluation) => evaluation.id === "e-2")?.superseded_by,
      ).toEqual([]);
      const json = JSON.parse(renderLedgerJson(ledger)) as {
        evaluations: Array<{
          exit_summary: string;
          cleanup_disposition: string;
          command_digest: string | null;
        }>;
      };
      expect(json.evaluations[0]).toMatchObject({
        exit_summary: "completed",
        cleanup_disposition: "confirmed",
        command_digest: null,
      });
      const markdown = renderLedgerMarkdown(ledger);
      expect(markdown).toContain("Exit summary:");
      expect(markdown).toContain("Cleanup disposition:");
      expect(markdown).toContain("Command digest: (not recorded)");
    });
  });

  describe("policy-required records", () => {
    it("rejects a pinned required handoff whose packet is missing", () => {
      const records = [makeTransitionAccepted("required-handoff", "run-1", 1000, null)];

      expect(() =>
        materializeContinuity(withLifecycles(records), {
          run_id: "run-1",
          continuity: {
            schema_version: 1,
            require_handoff: true,
            require_delegated_result: false,
            seed_max_utf8_bytes: 32_768,
          },
        }),
      ).toThrow("required handoff continuity packet is missing");
    });

    it("rejects a packet that is not durably paired with handoff evidence", () => {
      const record = makeTransitionAccepted(
        "required-handoff-metadata",
        "run-1",
        1000,
        makePacket("present packet"),
      );
      if (record.accepted_handoff === undefined) throw new Error("test handoff missing");
      const malformed = {
        ...record,
        accepted_handoff: {
          ...record.accepted_handoff,
          continuity_evidence: undefined,
          continuity_packet_utf8_bytes: undefined,
        },
      } as unknown as PersistedRecord;

      expect(() =>
        materializeContinuity(withLifecycles([malformed]), {
          run_id: "run-1",
          continuity: {
            schema_version: 1,
            require_handoff: true,
            require_delegated_result: false,
            seed_max_utf8_bytes: 32_768,
          },
        }),
      ).toThrow("required handoff continuity packet is missing");
    });

    it("rejects a pinned required delegated result whose packet is missing", () => {
      const records = [
        makeSubagentStarted("required-child", "run-1", 1000),
        makeSubagentCompleted("required-child", "run-1", 2000, null),
      ];

      expect(() =>
        materializeContinuity(withLifecycles(records), {
          run_id: "run-1",
          continuity: {
            schema_version: 1,
            require_handoff: false,
            require_delegated_result: true,
            seed_max_utf8_bytes: 32_768,
          },
        }),
      ).toThrow("required delegated-result continuity packet is missing");
    });
  });

  describe("malformed records", () => {
    it("rejects record with unsupported schema version", () => {
      const packet = { ...makePacket("test"), schema_version: 99 };
      const records = [makeTransitionAccepted("rec-1", "run-1", 1000, packet)];

      expect(() => materializeContinuity(withLifecycles(records), { run_id: "run-1" })).toThrow(
        ContinuityMaterializationException,
      );
    });

    it("rejects record with non-object packet", () => {
      const records = [makeTransitionAccepted("rec-1", "run-1", 1000, "not-an-object")];
      expect(() => materializeContinuity(withLifecycles(records), { run_id: "run-1" })).toThrow(
        ContinuityMaterializationException,
      );
    });

    it("skips records without continuity (legacy accepted_handoff)", () => {
      const records = [
        makeTransitionAccepted("rec-1", "run-1", 1000, null), // no continuity
      ];

      const ledger = materializeContinuity(withLifecycles(records), { run_id: "run-1" });
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

      const ledger1 = materializeContinuity(withLifecycles(records), { run_id: "run-1" });
      const ledger2 = materializeContinuity(withLifecycles(records), { run_id: "run-1" });
      const ledger3 = materializeContinuity(withLifecycles(records), { run_id: "run-1" });

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

      const ledger1 = materializeContinuity(withLifecycles(records), { run_id: "run-1" });
      const ledger2 = materializeContinuity(withLifecycles(records), { run_id: "run-1" });

      expect(ledger1.envelopes.map((e) => e.packet.summary)).toEqual(
        ledger2.envelopes.map((e) => e.packet.summary),
      );
    });
  });

  describe("empty ledger", () => {
    it("no continuity records produces valid empty ledger", () => {
      const records = [makeTransitionAccepted("rec-1", "run-1", 1000, null)];

      const ledger = materializeContinuity(withLifecycles(records), { run_id: "run-1" });

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

      const ledger = materializeContinuity(withLifecycles(records), { run_id: "run-1" });
      expect(ledger.envelopes).toHaveLength(0);
    });

    it("keeps parentless legacy child lifecycles readable when no packet is present", () => {
      const started = makeSubagentStarted("legacy-child", "run-1", 1000);
      const completed = makeSubagentCompleted("legacy-child", "run-1", 1100, null);
      const { parent_role, parent_visit_index, ...legacyStarted } = started;
      void parent_role;
      void parent_visit_index;

      const ledger = materializeContinuity([legacyStarted, completed], { run_id: "run-1" });

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

    const restarted = materializeContinuity(withLifecycles(JSON.parse(JSON.stringify(records))), {
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

      const ledger = materializeContinuity(withLifecycles(records), { run_id: "run-1" });

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
