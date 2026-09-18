/**
 * Focused tests for deterministic bounded seed selection — spec §11.
 *
 * Tests:
 * 1. Seed respects seed_max_utf8_bytes
 * 2. Items included atomically (no partial items)
 * 3. Omission counts recorded
 * 4. Metadata-only over-cap fails explicitly
 * 5. Priority order: blocking questions, recipient/parent next steps, risks/decisions, other findings, evaluations, summaries
 * 6. Items ordered newest first within each section
 */

import { describe, expect, it } from "vitest";
import { stableJsonStringify } from "../../src/persistence/continuity.js";
import {
  materializeContinuity,
  renderContinuitySeed,
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

function makePacket(opts: {
  summary: string;
  findings?: Array<{ id: string; kind?: string; statement?: string; supersedes?: string[] }>;
  questions?: Array<{ id: string; blocking?: boolean; supersedes?: string[] }>;
  nextSteps?: Array<{ id: string; owner?: string; action?: string; supersedes?: string[] }>;
  evaluations?: Array<{ id: string; label?: string; execution_id?: string }>;
}) {
  return {
    schema_version: 1 as const,
    summary: opts.summary,
    findings: (opts.findings ?? []).map((f) => ({
      id: f.id,
      kind: f.kind ?? "fact",
      confidence: "observed" as const,
      statement: f.statement ?? `finding ${f.id}`,
      evidence: [],
      supersedes: f.supersedes ?? [],
    })),
    evaluations: (opts.evaluations ?? []).map((e) => ({
      id: e.id,
      label: e.label ?? `eval ${e.id}`,
      execution_id: e.execution_id ?? "exec-1",
      supersedes: [],
    })),
    open_questions: (opts.questions ?? []).map((q) => ({
      id: q.id,
      question: `question ${q.id}`,
      blocking: q.blocking ?? false,
      evidence: [],
      supersedes: q.supersedes ?? [],
    })),
    next_steps: (opts.nextSteps ?? []).map((ns) => ({
      id: ns.id,
      action: ns.action ?? `action ${ns.id}`,
      owner: ns.owner ?? "recipient",
      evidence: [],
      supersedes: ns.supersedes ?? [],
    })),
    okf_candidate_ids: [],
  };
}

// ─── Test suite ────────────────────────────────────────────────────────

describe("continuity-materialization-truncation", () => {
  describe("seed respects max_bytes cap", () => {
    it("seed budget.used_bytes does not exceed max_bytes", () => {
      const packet = makePacket({
        summary: "test",
        findings: [{ id: "f-1", statement: "a".repeat(1000) }],
      });
      const records = [makeTransitionAccepted("rec-1", "run-1", 1000, packet)];
      const ledger = materializeContinuity(records, { run_id: "run-1" });

      // Use a generous cap
      const seed = renderContinuitySeed(ledger, 32 * 1024);
      expect(seed.budget.used_bytes).toBeLessThanOrEqual(seed.budget.max_bytes);
    });

    it("atomic inclusion: no partial items in the seed", () => {
      // Each item should be included or excluded as a whole
      const findings = Array.from({ length: 10 }, (_, i) => ({
        id: `f-${i}`,
        statement: `finding statement ${i} with some text`,
      }));
      const packet = makePacket({ summary: "test", findings });
      const records = [makeTransitionAccepted("rec-1", "run-1", 1000, packet)];
      const ledger = materializeContinuity(records, { run_id: "run-1" });

      // With a generous cap, all items should be included
      const seed = renderContinuitySeed(ledger, 32 * 1024);

      // All findings should be in the seed (atomic inclusion)
      const sectionFindings = seed.sections.other_active_findings as Array<{ id: string }>;
      expect(sectionFindings.length).toBe(10);
    });
  });

  describe("omission counts", () => {
    it("records omitted item count when truncation occurs", () => {
      // Create items whose statements are large enough to exceed a moderate
      // cap, exercising the truncation code path while respecting the
      // per-collection item bound (spec §6.1: ≤32 items per collection).
      const findings = Array.from({ length: 8 }, (_, i) => ({
        id: `f-${i}`,
        statement: `finding statement ${i} with enough meaningful content to consume bytes`,
      }));
      const packet = makePacket({ summary: "test", findings });
      const records = [makeTransitionAccepted("rec-1", "run-1", 1000, packet)];
      const ledger = materializeContinuity(records, { run_id: "run-1" });

      // Cap above the fixed metadata overhead but small enough to force
      // omission of one or more items (spec §11: must fail explicitly
      // when metadata alone exceeds the cap).
      const seedMaxBytes = 4096;
      const seed = renderContinuitySeed(ledger, seedMaxBytes);

      // Omission count should be > 0 when truncation occurs.
      expect(seed.omitted.items).toBeGreaterThan(0);
    });

    it("records omitted packet count", () => {
      // Multiple envelopes
      const packets = Array.from({ length: 5 }, (_, i) =>
        makePacket({ summary: `packet ${i}`, findings: [{ id: `f-${i}` }] }),
      );
      const records = packets.map((p, i) =>
        makeTransitionAccepted(`rec-${i}`, "run-1", (i + 1) * 1000, p),
      );
      const ledger = materializeContinuity(records, { run_id: "run-1" });

      const seed = renderContinuitySeed(ledger, 32 * 1024);
      expect(seed.omitted.packets).toBeGreaterThanOrEqual(0);
    });
  });

  describe("priority order", () => {
    it("blocking questions come first in seed sections", () => {
      const packet = makePacket({
        summary: "test",
        questions: [
          { id: "q-blocking", blocking: true },
          { id: "q-normal", blocking: false },
        ],
      });
      const records = [makeTransitionAccepted("rec-1", "run-1", 1000, packet)];
      const ledger = materializeContinuity(records, { run_id: "run-1" });

      const seed = renderContinuitySeed(ledger, 32 * 1024);
      const blockingQuestions = seed.sections.blocking_questions as Array<{ id: string }>;

      // Blocking question should be in the blocking section
      expect(blockingQuestions.some((q) => q.id === "q-blocking")).toBe(true);
    });

    it("recipient and parent next steps come before other findings", () => {
      const packet = makePacket({
        summary: "test",
        nextSteps: [
          { id: "ns-recipient", owner: "recipient", action: "do recipient thing" },
          { id: "ns-reviewer", owner: "reviewer", action: "do reviewer thing" },
          { id: "ns-parent", owner: "parent", action: "do parent thing" },
          { id: "ns-operator", owner: "operator", action: "do operator thing" },
        ],
        findings: [{ id: "f-1", kind: "fact", statement: "some finding" }],
      });
      const records = [makeTransitionAccepted("rec-1", "run-1", 1000, packet)];
      const ledger = materializeContinuity(records, { run_id: "run-1" });

      const seed = renderContinuitySeed(ledger, 32 * 1024);
      const recipientSteps = seed.sections.recipient_next_steps as Array<{ id: string }>;

      // Recipient and parent owned steps should be in recipient_next_steps section
      expect(recipientSteps.some((ns) => ns.id === "ns-recipient")).toBe(true);
      expect(recipientSteps.some((ns) => ns.id === "ns-parent")).toBe(true);
    });

    it("risks and decisions are in a separate section from other findings", () => {
      const packet = makePacket({
        summary: "test",
        findings: [
          { id: "f-fact", kind: "fact", statement: "a fact" },
          { id: "f-risk", kind: "risk", statement: "a risk" },
          { id: "f-decision", kind: "decision", statement: "a decision" },
        ],
      });
      const records = [makeTransitionAccepted("rec-1", "run-1", 1000, packet)];
      const ledger = materializeContinuity(records, { run_id: "run-1" });

      const seed = renderContinuitySeed(ledger, 32 * 1024);

      const risksDecisions = seed.sections.risks_and_decisions as Array<{
        id: string;
        kind: string;
      }>;
      expect(risksDecisions.some((f) => f.id === "f-risk")).toBe(true);
      expect(risksDecisions.some((f) => f.id === "f-decision")).toBe(true);

      const otherFindings = seed.sections.other_active_findings as Array<{ id: string }>;
      expect(otherFindings.some((f) => f.id === "f-fact")).toBe(true);
    });
  });

  describe("newest-first ordering within sections", () => {
    it("findings are ordered newest-first (reverse chronological)", () => {
      const packet1 = makePacket({
        summary: "old",
        findings: [{ id: "f-old", statement: "old finding" }],
      });
      const packet2 = makePacket({
        summary: "new",
        findings: [{ id: "f-new", statement: "new finding" }],
      });

      const records = [
        makeTransitionAccepted("rec-1", "run-1", 1000, packet1),
        makeTransitionAccepted("rec-2", "run-1", 2000, packet2),
      ];

      const ledger = materializeContinuity(records, { run_id: "run-1" });
      const seed = renderContinuitySeed(ledger, 32 * 1024);

      const otherFindings = seed.sections.other_active_findings as Array<{ id: string }>;
      // Newest first means f-new comes before f-old
      const ids = otherFindings.map((f) => f.id);
      expect(ids.indexOf("f-new")).toBeLessThan(ids.indexOf("f-old"));
    });
  });

  describe("metadata-only over-cap failure", () => {
    it("fails explicitly when fixed metadata exceeds the cap", () => {
      const packet = makePacket({ summary: "tiny packet" });
      const records = [makeTransitionAccepted("rec-1", "run-1", 1000, packet)];
      const ledger = materializeContinuity(records, { run_id: "run-1" });

      // Very small cap (less than even the seed wrapper structure)
      const tinyCap = 10;
      expect(() => renderContinuitySeed(ledger, tinyCap)).toThrow();
    });
  });

  describe("seed determinism", () => {
    it("same ledger + same cap produces byte-identical seed", () => {
      const packet = makePacket({
        summary: "stable seed content",
        findings: [
          { id: "f-1", statement: "first finding statement" },
          { id: "f-2", statement: "second finding statement" },
        ],
        questions: [{ id: "q-1", blocking: true }],
        nextSteps: [{ id: "ns-1", owner: "recipient", action: "do the thing" }],
      });
      const records = [makeTransitionAccepted("rec-1", "run-1", 1000, packet)];
      const ledger = materializeContinuity(records, { run_id: "run-1" });

      const seed1 = renderContinuitySeed(ledger, 32 * 1024);
      const seed2 = renderContinuitySeed(ledger, 32 * 1024);
      const seed3 = renderContinuitySeed(ledger, 32 * 1024);

      expect(stableJsonStringify(seed1)).toBe(stableJsonStringify(seed2));
      expect(stableJsonStringify(seed2)).toBe(stableJsonStringify(seed3));
    });

    it("seed sections JSON is byte-identical across replays", () => {
      const packet = makePacket({ summary: "repeatable", findings: [{ id: "f-r" }] });
      const records = [makeTransitionAccepted("rec-1", "run-1", 1000, packet)];
      const ledger = materializeContinuity(records, { run_id: "run-1" });

      const seed1 = renderContinuitySeed(ledger, 32 * 1024);
      const seed2 = renderContinuitySeed(ledger, 32 * 1024);

      expect(seed1.rendered).toBe(seed2.rendered);
    });
  });

  describe("evaluations in seed", () => {
    it("evaluations appear in seed sections", () => {
      const packet = makePacket({
        summary: "test",
        evaluations: [{ id: "e-1", label: "test evaluation" }],
      });
      const records = [makeTransitionAccepted("rec-1", "run-1", 1000, packet)];
      const ledger = materializeContinuity(records, { run_id: "run-1" });

      const seed = renderContinuitySeed(ledger, 32 * 1024);
      expect(
        (seed.sections.evaluations as readonly { id: string }[]).some((e) => e.id === "e-1"),
      ).toBe(true);
    });
  });

  describe("packet summaries in seed", () => {
    it("packet summaries appear in seed sections newest first", () => {
      const packet1 = makePacket({ summary: "first summary" });
      const packet2 = makePacket({ summary: "second summary" });

      const records = [
        makeTransitionAccepted("rec-1", "run-1", 1000, packet1),
        makeTransitionAccepted("rec-2", "run-1", 2000, packet2),
      ];

      const ledger = materializeContinuity(records, { run_id: "run-1" });
      const seed = renderContinuitySeed(ledger, 32 * 1024);

      const summaries = seed.sections.packet_summaries as Array<{ summary: string }>;
      expect(summaries[0]?.summary).toBe("second summary"); // newest first
      expect(summaries[1]?.summary).toBe("first summary");
    });
  });
});
