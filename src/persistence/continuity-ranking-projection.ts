/**
 * Pure candidate projection for Jev recipient-context ranking —
 * jev-context-ranking spec §6.
 *
 * Host-agnostic; imports no pi SDK, no provider, no network. This
 * module is the projection counterpart to the host-side TypeSafe
 * adapter. The functions in this file derive a deterministic scored
 * prefix + unscored suffix from the canonical ledger (no model
 * calls, no ambient state).
 *
 * Coherent concept kept as a single module because projection and
 * baseline ordering cross-reference each other in tight loops;
 * splitting them further would force cross-imports that hurt
 * readability without reducing complexity.
 */

import type {
  ContinuityFinding,
  ContinuityNextStep,
  ContinuityQuestion,
} from "../seam/continuity.js";
import type {
  RankedCandidateProjection,
  RankedCandidateProjectionEntry,
  RankedRecipient,
  SectionKey,
} from "./continuity-ranking.js";
import type {
  ContinuityActiveOrSupersededItem,
  ContinuityEnvelopeV1,
  ContinuityLedger,
  ContinuityResolvedEvaluation,
} from "./continuity-types.js";

function attributesForFinding(
  finding: ContinuityFinding,
): Readonly<Record<string, string | boolean>> {
  return Object.freeze({ kind: finding.kind, confidence: finding.confidence });
}

function attributesForQuestion(
  question: ContinuityQuestion,
): Readonly<Record<string, string | boolean>> {
  return Object.freeze({ blocking: question.blocking });
}

function attributesForNextStep(
  nextStep: ContinuityNextStep,
): Readonly<Record<string, string | boolean>> {
  return Object.freeze({ owner: nextStep.owner });
}

function attributesForEvaluation(
  evaluation: ContinuityResolvedEvaluation,
): Readonly<Record<string, string | boolean>> {
  return Object.freeze({
    status: evaluation.status,
    cleanup_disposition: evaluation.cleanup_disposition,
    command_digest_present: evaluation.command_digest !== null,
  });
}

function attributesForEnvelope(
  envelope: ContinuityEnvelopeV1,
): Readonly<Record<string, string | boolean>> {
  return Object.freeze({ source: envelope.source });
}

function buildCandidateOutbound(
  section: SectionKey,
  kind: string,
  text: string,
  attributes: Readonly<Record<string, string | boolean>>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    section,
    kind,
    text,
    attributes: Object.freeze({ ...attributes }),
  });
}

interface SectionProjection {
  readonly section: SectionKey;
  readonly entries: readonly RankedCandidateProjectionEntry[];
}

function sectionFromBlockingQuestions(
  ledger: ContinuityLedger,
): readonly ContinuityActiveOrSupersededItem<ContinuityQuestion>[] {
  return ledger.open_questions
    .filter((entry) => entry.item.blocking && entry.superseded_by.length === 0)
    .reverse();
}

function sectionFromRecipientNextSteps(
  ledger: ContinuityLedger,
): readonly ContinuityActiveOrSupersededItem<ContinuityNextStep>[] {
  return ledger.next_steps
    .filter(
      (entry) =>
        (entry.item.owner === "recipient" || entry.item.owner === "parent") &&
        entry.superseded_by.length === 0,
    )
    .reverse();
}

function sectionFromRisksAndDecisions(
  ledger: ContinuityLedger,
): readonly ContinuityActiveOrSupersededItem<ContinuityFinding>[] {
  return ledger.findings
    .filter(
      (entry) =>
        (entry.item.kind === "risk" || entry.item.kind === "decision") &&
        entry.superseded_by.length === 0,
    )
    .reverse();
}

function sectionFromOtherActiveFindings(
  ledger: ContinuityLedger,
): readonly ContinuityActiveOrSupersededItem<ContinuityFinding>[] {
  return ledger.findings
    .filter(
      (entry) =>
        entry.item.kind !== "risk" &&
        entry.item.kind !== "decision" &&
        entry.superseded_by.length === 0,
    )
    .reverse();
}

function sectionFromEvaluations(ledger: ContinuityLedger): readonly SectionProjection[] {
  return [
    {
      section: "evaluations",
      entries: [...ledger.evaluations].reverse().map((evaluation) => {
        const attributes = attributesForEvaluation(evaluation);
        const text = `${evaluation.label} (${evaluation.status})`;
        return {
          section: "evaluations" as const,
          candidate_key: `evaluations:${evaluation.record_id}:${evaluation.id}`,
          baseline_ordinal: 0,
          item: evaluation,
          outbound: buildCandidateOutbound("evaluations", "evaluation", text, attributes),
          attributes,
        } satisfies RankedCandidateProjectionEntry;
      }),
    },
  ];
}

function sectionFromPacketSummaries(ledger: ContinuityLedger): readonly SectionProjection[] {
  const reversed = [...ledger.envelopes].reverse();
  return [
    {
      section: "packet_summaries",
      entries: reversed.map((envelope) => {
        const attributes = attributesForEnvelope(envelope);
        return {
          section: "packet_summaries" as const,
          candidate_key: `packet_summary:${envelope.record_id}`,
          baseline_ordinal: 0,
          item: {
            source: envelope.source,
            role: envelope.role,
            record_id: envelope.record_id,
            summary: envelope.packet.summary,
          },
          outbound: buildCandidateOutbound(
            "packet_summaries",
            "packet_summary",
            envelope.packet.summary,
            attributes,
          ),
          attributes,
        } satisfies RankedCandidateProjectionEntry;
      }),
    },
  ];
}

function buildSectionEntries(ledger: ContinuityLedger): readonly SectionProjection[] {
  const sections: SectionProjection[] = [
    {
      section: "blocking_questions",
      entries: sectionFromBlockingQuestions(ledger).map((entry) => {
        const attributes = attributesForQuestion(entry.item);
        return {
          section: "blocking_questions" as const,
          candidate_key: `blocking_questions:${entry.record_id}:${entry.item.id}`,
          baseline_ordinal: 0,
          item: entry.item,
          outbound: buildCandidateOutbound(
            "blocking_questions",
            "question",
            entry.item.question,
            attributes,
          ),
          attributes,
        } satisfies RankedCandidateProjectionEntry;
      }),
    },
    {
      section: "recipient_next_steps",
      entries: sectionFromRecipientNextSteps(ledger).map((entry) => {
        const attributes = attributesForNextStep(entry.item);
        return {
          section: "recipient_next_steps" as const,
          candidate_key: `recipient_next_steps:${entry.record_id}:${entry.item.id}`,
          baseline_ordinal: 0,
          item: entry.item,
          outbound: buildCandidateOutbound(
            "recipient_next_steps",
            "next_step",
            entry.item.action,
            attributes,
          ),
          attributes,
        } satisfies RankedCandidateProjectionEntry;
      }),
    },
    {
      section: "risks_and_decisions",
      entries: sectionFromRisksAndDecisions(ledger).map((entry) => {
        const attributes = attributesForFinding(entry.item);
        return {
          section: "risks_and_decisions" as const,
          candidate_key: `risks_and_decisions:${entry.record_id}:${entry.item.id}`,
          baseline_ordinal: 0,
          item: entry.item,
          outbound: buildCandidateOutbound(
            "risks_and_decisions",
            entry.item.kind,
            entry.item.statement,
            attributes,
          ),
          attributes,
        } satisfies RankedCandidateProjectionEntry;
      }),
    },
    {
      section: "other_active_findings",
      entries: sectionFromOtherActiveFindings(ledger).map((entry) => {
        const attributes = attributesForFinding(entry.item);
        return {
          section: "other_active_findings" as const,
          candidate_key: `other_active_findings:${entry.record_id}:${entry.item.id}`,
          baseline_ordinal: 0,
          item: entry.item,
          outbound: buildCandidateOutbound(
            "other_active_findings",
            entry.item.kind,
            entry.item.statement,
            attributes,
          ),
          attributes,
        } satisfies RankedCandidateProjectionEntry;
      }),
    },
    ...sectionFromEvaluations(ledger),
    ...sectionFromPacketSummaries(ledger),
  ];
  return sections;
}

/**
 * Derive the deterministic prefix + unscored suffix from the canonical
 * ledger for one accepted transition. The returned entries are pure
 * data; the caller passes them to the TypeSafe adapter and back to
 * `buildRankedSeed` for rendering.
 *
 * `candidate_limit` bounds the scored prefix globally — across all six
 * sections in §6.1 priority order. Unscored entries retain baseline
 * ordinals so the unscored suffix remains in canonical order.
 */
export function projectRankedCandidates(
  ledger: ContinuityLedger,
  input: RankedCandidateInputInternal,
): RankedCandidateProjection {
  const sections = buildSectionEntries(ledger);
  const flat: RankedCandidateProjectionEntry[] = [];
  for (const projection of sections) {
    for (const entry of projection.entries) flat.push(entry);
  }
  const totalCount = flat.length;
  const limit = Math.min(input.policy.candidate_limit, totalCount);
  const scoredPrefix: RankedCandidateProjectionEntry[] = [];
  let consumed = 0;
  for (const entry of flat) {
    if (consumed >= limit) break;
    scoredPrefix.push({ ...entry, baseline_ordinal: consumed });
    consumed += 1;
  }
  const unscoredSuffix = flat.slice(consumed).map((entry, offset) => ({
    ...entry,
    baseline_ordinal: consumed + offset,
  }));
  return Object.freeze({
    scored_prefix: Object.freeze(scoredPrefix),
    unscored_suffix: Object.freeze(unscoredSuffix),
    scored_count: scoredPrefix.length,
    total_count: totalCount,
    input_fingerprint: null,
  });
}

interface RankedCandidateInputInternal {
  readonly recipient: RankedRecipient;
  readonly policy: {
    readonly provider: "typesafe_jev";
    readonly model: string;
    readonly strategy: "recipient_relevance_rank";
    readonly candidate_limit: number;
  };
  readonly source_transition_key: string;
}
