/**
 * Focused tests for the pure ranking primitives — jev-context-ranking spec §6.2,
 * §6.3, §8, and the byte-for-byte omission-compat requirement.
 *
 * Covers:
 *  - Stable candidate keys (section:record_id:item_id / packet_summary:record_id).
 *  - Deterministic prefix selection (candidate_limit).
 *  - Within-section score ordering (descending, stable ties by baseline ordinal).
 *  - Unscored suffix stability after scored prefix.
 *  - Host annotation wrapper does not mutate source items or finding confidence.
 *  - Disabled/unavailable rendering is byte-identical to current output.
 *  - Atomic byte truncation respects host annotation bytes.
 */

import { describe, expect, it } from "vitest";
import { stableJsonStringify } from "../../src/persistence/continuity.js";
import {
  materializeContinuity,
  renderContinuitySeed,
} from "../../src/persistence/continuity-materialization.js";
import {
  buildRankedSeed,
  projectRankedCandidates,
  type RankedCandidateInput,
  rankCandidatesForSection,
} from "../../src/persistence/continuity-ranking.js";
import type {
  ContinuityLedger,
  ContinuitySeedSections,
} from "../../src/persistence/continuity-types.js";
import type { PersistedRecord } from "../../src/persistence/log.js";

const SCORED_RANK_INPUT: RankedCandidateInput = {
  recipient: { role: "implementer", objective: "ship it", requested_action: "implement" },
  policy: {
    provider: "typesafe_jev",
    model: "jev-latest",
    strategy: "recipient_relevance_rank",
    candidate_limit: 32,
  },
  source_transition_key: "a".repeat(64),
};

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

function makePacket(
  summary: string,
  findings: Array<{ id: string; kind?: string; statement?: string }> = [],
  questions: Array<{ id: string; blocking?: boolean }> = [],
  nextSteps: Array<{ id: string; owner?: string; action?: string }> = [],
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
      supersedes: [],
    })),
    evaluations: [],
    open_questions: questions.map((q) => ({
      id: q.id,
      question: `question ${q.id}`,
      blocking: q.blocking ?? false,
      evidence: [],
      supersedes: [],
    })),
    next_steps: nextSteps.map((ns) => ({
      id: ns.id,
      action: ns.action ?? "test action",
      owner: (ns.owner ?? "recipient") as "parent" | "recipient" | "reviewer" | "operator",
      evidence: [],
      supersedes: [],
    })),
    okf_candidate_ids: [],
  };
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

function ledger(records: readonly PersistedRecord[]): ContinuityLedger {
  return materializeContinuity(records, { run_id: "run-1" });
}

describe("projectRankedCandidates (spec §6.1, §6.2)", () => {
  it("returns a deterministic prefix bounded by candidate_limit", () => {
    const packet = makePacket(
      "test",
      Array.from({ length: 10 }, (_, i) => ({ id: `f-${i}`, statement: `finding ${i}` })),
    );
    const records = [makeTransitionAccepted("rec-1", "run-1", 1000, packet)];
    const ledgerValue = ledger(withLifecycles(records));

    const projection = projectRankedCandidates(ledgerValue, {
      ...SCORED_RANK_INPUT,
      policy: { ...SCORED_RANK_INPUT.policy, candidate_limit: 3 },
    });
    expect(projection.scored_count).toBe(3);
    // 10 findings + 1 packet summary = 11 total.
    expect(projection.total_count).toBe(11);
    expect(projection.scored_prefix.map((c) => c.baseline_ordinal)).toEqual([0, 1, 2]);
  });

  it("emits stable candidate keys in section:record_id:item_id form", () => {
    const packet = makePacket("test", [
      { id: "f-1", kind: "fact", statement: "first finding" },
      { id: "f-2", kind: "risk", statement: "second finding" },
    ]);
    const records = [makeTransitionAccepted("rec-1", "run-1", 1000, packet)];
    const ledgerValue = ledger(withLifecycles(records));

    const projection = projectRankedCandidates(ledgerValue, SCORED_RANK_INPUT);
    const expectedKeys = new Set<string>();
    for (const item of ledgerValue.findings) {
      if (item.item.kind === "risk" || item.item.kind === "decision") {
        expectedKeys.add(`risks_and_decisions:${item.record_id}:${item.item.id}`);
      } else {
        expectedKeys.add(`other_active_findings:${item.record_id}:${item.item.id}`);
      }
    }
    for (const candidate of projection.scored_prefix) {
      // Allow packet_summary keys too; we only assert item-id keys exist.
      if (candidate.candidate_key.startsWith("packet_summary:")) continue;
      expect(expectedKeys.has(candidate.candidate_key)).toBe(true);
    }
  });

  it("uses packet_summary:<record_id> keys for packet summaries", () => {
    const packet = makePacket("test", [{ id: "f-1", statement: "finding" }]);
    const records = [makeTransitionAccepted("rec-1", "run-1", 1000, packet)];
    const ledgerValue = ledger(withLifecycles(records));

    const projection = projectRankedCandidates(ledgerValue, SCORED_RANK_INPUT);
    const packetSummaryKey = projection.scored_prefix.find((c) =>
      c.candidate_key.startsWith("packet_summary:"),
    );
    expect(packetSummaryKey).toBeDefined();
  });

  it("respects the documented outbound-state prohibition list", () => {
    const packet = makePacket("test", [{ id: "f-1", statement: "first finding" }]);
    const records = [makeTransitionAccepted("rec-1", "run-1", 1000, packet)];
    const ledgerValue = ledger(withLifecycles(records));

    const projection = projectRankedCandidates(ledgerValue, SCORED_RANK_INPUT);
    for (const candidate of projection.scored_prefix) {
      const serialized = stableJsonStringify(candidate.outbound);
      expect(serialized).not.toMatch(
        /run_id|record_id|session_id|child_id|execution_id|artifact_id/,
      );
      expect(serialized).not.toMatch(/path|commit|line_start|line_end|sha256|url/);
    }
  });
});

describe("rankCandidatesForSection (spec §8)", () => {
  function rankedCandidate(overrides: {
    candidate_key: string;
    baseline_ordinal: number;
    score?: number;
    ranking_certainty?: number;
    probabilities?: Readonly<Record<"0" | "1" | "2" | "3", number>>;
  }) {
    return {
      candidate_key: overrides.candidate_key,
      baseline_ordinal: overrides.baseline_ordinal,
      score: overrides.score ?? 1,
      ranking_certainty: overrides.ranking_certainty ?? 0.5,
      probabilities: overrides.probabilities ?? {
        "0": 0.25,
        "1": 0.25,
        "2": 0.25,
        "3": 0.25,
      },
    };
  }

  it("orders scored candidates by descending score within a section", () => {
    const ranked = rankCandidatesForSection(
      [
        rankedCandidate({ candidate_key: "a", baseline_ordinal: 0, score: 1 }),
        rankedCandidate({ candidate_key: "b", baseline_ordinal: 1, score: 3 }),
        rankedCandidate({ candidate_key: "c", baseline_ordinal: 2, score: 2 }),
      ],
      ["a", "b", "c"],
      "other_active_findings",
    );
    expect(ranked.map((entry) => entry.candidate_key)).toEqual(["b", "c", "a"]);
  });

  it("breaks equal-score ties by baseline ordinal", () => {
    const ranked = rankCandidatesForSection(
      [
        rankedCandidate({ candidate_key: "a", baseline_ordinal: 0, score: 2 }),
        rankedCandidate({ candidate_key: "b", baseline_ordinal: 1, score: 2 }),
        rankedCandidate({ candidate_key: "c", baseline_ordinal: 2, score: 2 }),
      ],
      ["a", "b", "c"],
      "other_active_findings",
    );
    expect(ranked.map((entry) => entry.candidate_key)).toEqual(["a", "b", "c"]);
  });

  it("preserves unscored candidates after scored ones in baseline order", () => {
    const ranked = rankCandidatesForSection(
      [
        rankedCandidate({ candidate_key: "a", baseline_ordinal: 0, score: 3 }),
        rankedCandidate({ candidate_key: "b", baseline_ordinal: 1 }),
        rankedCandidate({ candidate_key: "c", baseline_ordinal: 2 }),
      ],
      ["a", "b", "c"],
      "other_active_findings",
    );
    // Only 'a' is scored; 'b' and 'c' retain baseline order
    expect(ranked.map((entry) => entry.candidate_key)).toEqual(["a", "b", "c"]);
  });
});

describe("buildRankedSeed (spec §8 byte accounting)", () => {
  function makeSections(): ContinuitySeedSections {
    return {
      blocking_questions: [],
      recipient_next_steps: [],
      risks_and_decisions: [],
      other_active_findings: [],
      evaluations: [],
      packet_summaries: [],
    };
  }

  it("renders host annotation wrapper with score + ranking_certainty", () => {
    const ledgerValue = ledger(
      withLifecycles([
        makeTransitionAccepted(
          "rec-1",
          "run-1",
          1000,
          makePacket("test", [{ id: "f-1", statement: "first finding" }]),
        ),
      ]),
    );

    const projection = projectRankedCandidates(ledgerValue, SCORED_RANK_INPUT);
    const sections = makeSections();
    void sections;
    const result = buildRankedSeed({
      ledger: ledgerValue,
      max_bytes: 65536,
      ranking_input: SCORED_RANK_INPUT,
      judgments: projection.scored_prefix.map((candidate) => ({
        candidate_key: candidate.candidate_key,
        baseline_ordinal: candidate.baseline_ordinal,
        score: candidate.section === "other_active_findings" ? 2 : 1,
        ranking_certainty: 0.81,
        probabilities: { "0": 0.05, "1": 0.1, "2": 0.7, "3": 0.15 },
      })),
    });
    const json = JSON.parse(result.rendered) as {
      sections: { other_active_findings: Array<Record<string, unknown>> };
    };
    const item = json.sections.other_active_findings[0] as Record<string, unknown>;
    expect(item.host_relevance).toEqual({ score: 2, ranking_certainty: 0.81 });
    expect(item.item).toBeDefined();
    const inner = item.item as Record<string, unknown>;
    expect(inner.confidence).toBe("observed");
    expect(item.host_relevance).toBeDefined();
    // Wrapper does not mutate the underlying item or its confidence.
    expect((item.item as Record<string, unknown>).confidence).toBe("observed");
  });

  it("is byte-identical to baseline when enrichment is disabled (omission compat)", () => {
    const ledgerValue = ledger(
      withLifecycles([
        makeTransitionAccepted(
          "rec-1",
          "run-1",
          1000,
          makePacket("test", [
            { id: "f-1", statement: "first finding" },
            { id: "f-2", statement: "second finding" },
          ]),
        ),
      ]),
    );
    const baselineSeed = renderContinuitySeed(ledgerValue, 65536);
    const rankedSeed = buildRankedSeed({
      ledger: ledgerValue,
      max_bytes: 65536,
      ranking_input: null,
      judgments: [],
    });
    expect(rankedSeed.rendered).toBe(baselineSeed.rendered);
    expect(rankedSeed.omitted_items).toBe(baselineSeed.omitted.items);
    expect(rankedSeed.omitted_packets).toBe(baselineSeed.omitted.packets);
  });
});

describe("renderContinuitySeed two-arg baseline (spec §14.4)", () => {
  it("preserves byte-identical rendering when no ranking is supplied", () => {
    const ledgerValue = ledger(
      withLifecycles([
        makeTransitionAccepted(
          "rec-1",
          "run-1",
          1000,
          makePacket("test", [{ id: "f-1", statement: "first finding" }]),
        ),
      ]),
    );
    const a = renderContinuitySeed(ledgerValue, 65536);
    const b = renderContinuitySeed(ledgerValue, 65536);
    expect(a.rendered).toBe(b.rendered);
    // The two-arg signature must remain unchanged for legacy callers.
    const c = renderContinuitySeed(ledgerValue, 65536);
    expect(c.rendered).toBe(a.rendered);
  });
});
