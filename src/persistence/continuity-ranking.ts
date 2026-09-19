/**
 * Pure recipient-context ranking primitives — jev-context-ranking spec §6, §8.
 *
 * Three small surfaces live here:
 *  - `projectRankedCandidates`: derive a deterministic scored prefix +
 *    unscored suffix from the canonical ledger (no model calls, no ambient state).
 *  - `rankCandidatesForSection`: stable within-section ordering (descending
 *    score, baseline ordinal tie-break, unscored suffix stability).
 *  - `buildRankedSeed`/`renderRankedContinuitySeed`: render the byte-bounded
 *    seed with optional host annotation wrapper while preserving the
 *    byte-identical baseline when enrichment is disabled or unavailable.
 *
 * This module is host-agnostic — it imports no pi SDK, no provider, and
 * performs no network I/O. It is the pure counterpart to the host
 * TypeSafe adapter (`src/host/context-enrichment/typesafe-client.ts`).
 */

import type {
  ContinuityFinding,
  ContinuityNextStep,
  ContinuityQuestion,
} from "../seam/continuity.js";
import { renderContinuitySeed as renderLegacyContinuitySeed } from "./continuity-seed.js";
import { stableJsonStringify } from "./continuity-semantics.js";
import type {
  ContinuityActiveOrSupersededItem,
  ContinuityEnvelopeV1,
  ContinuityLedger,
  ContinuityResolvedEvaluation,
  ContinuitySeed,
  ContinuitySeedSections,
} from "./continuity-types.js";

const encoder = new TextEncoder();

// ─── Section key constants (spec §6.1) ─────────────────────────────────

export const SECTION_KEYS = [
  "blocking_questions",
  "recipient_next_steps",
  "risks_and_decisions",
  "other_active_findings",
  "evaluations",
  "packet_summaries",
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

// ─── Input contracts ───────────────────────────────────────────────────

/**
 * Pinned policy snapshot the host passes to the ranker. Only the fields
 * the ranker needs are required; transport limits belong to the adapter.
 */
export interface RankedCandidatePolicy {
  readonly provider: "typesafe_jev";
  readonly model: string;
  readonly strategy: "recipient_relevance_rank";
  readonly candidate_limit: number;
}

export interface RankedRecipient {
  readonly role: string;
  readonly objective: string;
  readonly requested_action: string;
}

export interface RankedCandidateInput {
  readonly recipient: RankedRecipient;
  readonly policy: RankedCandidatePolicy;
  readonly source_transition_key: string;
}

export interface RankedCandidateProjectionJudgment {
  readonly candidate_key: string;
  readonly baseline_ordinal: number;
  readonly score: number;
  readonly ranking_certainty: number;
  readonly probabilities: Readonly<Record<"0" | "1" | "2" | "3", number>>;
}

export interface RankedCandidateProjection {
  readonly scored_prefix: readonly RankedCandidateProjectionEntry[];
  readonly unscored_suffix: readonly RankedCandidateProjectionEntry[];
  readonly scored_count: number;
  readonly total_count: number;
  readonly input_fingerprint: string | null;
}

export interface RankedCandidateProjectionEntry {
  readonly section: SectionKey;
  readonly candidate_key: string;
  readonly baseline_ordinal: number;
  /** Semantic candidate value passed to the renderer; never contains run/record identities. */
  readonly item: unknown;
  /** Minimal outbound state for the adapter (no run/record identities, no paths, no URLs). */
  readonly outbound: unknown;
  readonly attributes: Readonly<Record<string, string | boolean>>;
}

// ─── Candidate projection (spec §6) ─────────────────────────────────────

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

function buildOutbound(
  recipient: RankedRecipient,
  section: SectionKey,
  kind: string,
  text: string,
  attributes: Readonly<Record<string, string | boolean>>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    recipient: Object.freeze({
      role: recipient.role,
      objective: recipient.objective,
      requested_action: recipient.requested_action,
    }),
    candidate: Object.freeze({
      section,
      kind,
      text,
      attributes: Object.freeze({ ...attributes }),
    }),
  });
}

interface SectionProjection {
  readonly section: SectionKey;
  readonly entries: readonly RankedCandidateProjectionEntry[];
}

function sectionFromBlockingQuestions(
  ledger: ContinuityLedger,
): readonly ContinuityActiveOrSupersededItem<ContinuityQuestion>[] {
  return ledger.open_questions.filter((entry) => entry.item.blocking).reverse();
}

function sectionFromRecipientNextSteps(
  ledger: ContinuityLedger,
): readonly ContinuityActiveOrSupersededItem<ContinuityNextStep>[] {
  return ledger.next_steps
    .filter((entry) => entry.item.owner === "recipient" || entry.item.owner === "parent")
    .reverse();
}

function sectionFromRisksAndDecisions(
  ledger: ContinuityLedger,
): readonly ContinuityActiveOrSupersededItem<ContinuityFinding>[] {
  return ledger.findings
    .filter((entry) => entry.item.kind === "risk" || entry.item.kind === "decision")
    .reverse();
}

function sectionFromOtherActiveFindings(
  ledger: ContinuityLedger,
): readonly ContinuityActiveOrSupersededItem<ContinuityFinding>[] {
  return ledger.findings
    .filter((entry) => entry.item.kind !== "risk" && entry.item.kind !== "decision")
    .reverse();
}

function sectionFromEvaluations(ledger: ContinuityLedger): readonly SectionProjection[] {
  return [
    {
      section: "evaluations",
      entries: ledger.evaluations.map((evaluation) => {
        const attributes = attributesForEvaluation(evaluation);
        const text = `${evaluation.label} (${evaluation.status})`;
        return {
          section: "evaluations" as const,
          candidate_key: `evaluations:${evaluation.record_id}:${evaluation.id}`,
          baseline_ordinal: 0,
          item: evaluation,
          outbound: buildOutbound(
            { role: "", objective: "", requested_action: "" },
            "evaluations",
            "evaluation",
            text,
            attributes,
          ),
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
          outbound: buildOutbound(
            { role: "", objective: "", requested_action: "" },
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

function buildSectionEntries(
  ledger: ContinuityLedger,
  recipient: RankedRecipient,
): readonly SectionProjection[] {
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
          outbound: buildOutbound(
            recipient,
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
          outbound: buildOutbound(
            recipient,
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
          outbound: buildOutbound(
            recipient,
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
          outbound: buildOutbound(
            recipient,
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
  input: RankedCandidateInput,
): RankedCandidateProjection {
  const sections = buildSectionEntries(ledger, input.recipient);
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

/**
 * Order a single section's scored prefix by descending score, breaking
 * equal-score ties by baseline ordinal. Unscored candidates retain
 * their baseline ordinals. The function is pure: input order does not
 * affect output beyond the documented tie-break rule.
 */
export function rankCandidatesForSection(
  judgments: readonly RankedCandidateProjectionJudgment[],
  baselineKeys: readonly string[],
  section: SectionKey,
): readonly RankedCandidateProjectionJudgment[] {
  void section;
  const byKey = new Map<string, RankedCandidateProjectionJudgment>();
  for (const judgment of judgments) byKey.set(judgment.candidate_key, judgment);
  const ordered: RankedCandidateProjectionJudgment[] = [];
  for (const key of baselineKeys) {
    const judgment = byKey.get(key);
    if (judgment !== undefined) ordered.push(judgment);
  }
  return Object.freeze(
    ordered.sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      return left.baseline_ordinal - right.baseline_ordinal;
    }),
  );
}

// ─── Ranked seed rendering (spec §8) ────────────────────────────────────

export interface BuildRankedSeedArgs {
  readonly ledger: ContinuityLedger;
  readonly max_bytes: number;
  readonly ranking_input: RankedCandidateInput | null;
  readonly judgments: readonly RankedCandidateProjectionJudgment[];
}

interface RankedSeedResult {
  readonly rendered: string;
  readonly sections: ContinuitySeedSections;
  readonly omitted_items: number;
  readonly omitted_packets: number;
  readonly used_bytes: number;
  readonly max_bytes: number;
}

/**
 * Render the byte-bounded seed with optional host annotation wrapper.
 * When `ranking_input` is `null` or the judgments list is empty, the
 * function returns the exact legacy rendered text — preserving the
 * two-argument `renderContinuitySeed(ledger, max_bytes)` baseline
 * byte-for-byte.
 */
export function buildRankedSeed(args: BuildRankedSeedArgs): RankedSeedResult {
  if (args.ranking_input === null || args.judgments.length === 0) {
    const baseline = renderLegacyContinuitySeed(args.ledger, args.max_bytes);
    return {
      rendered: baseline.rendered,
      sections: baseline.sections,
      omitted_items: baseline.omitted.items,
      omitted_packets: baseline.omitted.packets,
      used_bytes: baseline.budget.used_bytes,
      max_bytes: baseline.budget.max_bytes,
    };
  }
  const projection = projectRankedCandidates(args.ledger, args.ranking_input);
  const sections = composeRankedSections(projection, args.judgments, args.ledger);
  return renderRanked({ ledger: args.ledger, max_bytes: args.max_bytes, sections });
}

function composeRankedSections(
  projection: RankedCandidateProjection,
  judgments: readonly RankedCandidateProjectionJudgment[],
  ledger: ContinuityLedger,
): ContinuitySeedSections {
  // Build a per-section ranked list (scored prefix first, then unscored suffix
  // in baseline order). Then assemble `ContinuitySeedSections` from those.
  const judgmentsByKey = new Map<string, RankedCandidateProjectionJudgment>();
  for (const judgment of judgments) judgmentsByKey.set(judgment.candidate_key, judgment);

  const bySection = new Map<
    SectionKey,
    { scored: RankedCandidateProjectionEntry[]; unscored: RankedCandidateProjectionEntry[] }
  >();
  for (const key of SECTION_KEYS) {
    bySection.set(key, { scored: [], unscored: [] });
  }
  for (const entry of projection.scored_prefix) {
    bySection.get(entry.section)?.scored.push(entry);
  }
  for (const entry of projection.unscored_suffix) {
    bySection.get(entry.section)?.unscored.push(entry);
  }

  const baselineSections = renderLegacyContinuitySeed(ledger, Number.MAX_SAFE_INTEGER).sections;
  const rebuilt: Record<SectionKey, unknown[]> = {
    blocking_questions: [...baselineSections.blocking_questions],
    recipient_next_steps: [...baselineSections.recipient_next_steps],
    risks_and_decisions: [...baselineSections.risks_and_decisions],
    other_active_findings: [...baselineSections.other_active_findings],
    evaluations: [...baselineSections.evaluations],
    packet_summaries: [...baselineSections.packet_summaries],
  };

  for (const [sectionKey, split] of bySection) {
    const orderedScored = split.scored.slice().sort((a, b) => {
      const ja = judgmentsByKey.get(a.candidate_key);
      const jb = judgmentsByKey.get(b.candidate_key);
      const sa = ja?.score ?? 0;
      const sb = jb?.score ?? 0;
      if (sa !== sb) return sb - sa;
      return a.baseline_ordinal - b.baseline_ordinal;
    });
    rebuilt[sectionKey] = [];
    for (const entry of orderedScored) {
      const judgment = judgmentsByKey.get(entry.candidate_key);
      if (judgment === undefined) continue;
      rebuilt[sectionKey].push({
        host_relevance: Object.freeze({
          score: judgment.score,
          ranking_certainty: judgment.ranking_certainty,
        }),
        item: entry.item,
      });
    }
    for (const entry of split.unscored) {
      rebuilt[sectionKey].push(entry.item);
    }
  }

  return Object.freeze({
    blocking_questions: Object.freeze(rebuilt.blocking_questions),
    recipient_next_steps: Object.freeze(rebuilt.recipient_next_steps),
    risks_and_decisions: Object.freeze(rebuilt.risks_and_decisions),
    other_active_findings: Object.freeze(rebuilt.other_active_findings),
    evaluations: Object.freeze(rebuilt.evaluations) as readonly ContinuityResolvedEvaluation[],
    packet_summaries: Object.freeze(rebuilt.packet_summaries),
  }) as ContinuitySeedSections;
}

interface RenderArgs {
  readonly ledger: ContinuityLedger;
  readonly max_bytes: number;
  readonly sections: ContinuitySeedSections;
}

function renderRanked(args: RenderArgs): RankedSeedResult {
  const ordered: { key: SectionKey; value: unknown; packet: boolean }[] = [];
  for (const item of args.sections.blocking_questions)
    ordered.push({ key: "blocking_questions", value: item, packet: false });
  for (const item of args.sections.recipient_next_steps)
    ordered.push({ key: "recipient_next_steps", value: item, packet: false });
  for (const item of args.sections.risks_and_decisions)
    ordered.push({ key: "risks_and_decisions", value: item, packet: false });
  for (const item of args.sections.other_active_findings)
    ordered.push({ key: "other_active_findings", value: item, packet: false });
  for (const item of args.sections.evaluations)
    ordered.push({ key: "evaluations", value: item, packet: false });
  for (const item of args.sections.packet_summaries)
    ordered.push({ key: "packet_summaries", value: item, packet: true });

  const accepted: Record<SectionKey, unknown[]> = {
    blocking_questions: [],
    recipient_next_steps: [],
    risks_and_decisions: [],
    other_active_findings: [],
    evaluations: [],
    packet_summaries: [],
  };
  let admitted = 0;
  for (const candidate of ordered) {
    accepted[candidate.key].push(candidate.value);
    const serialized = serialize(args.ledger.run_id, args.max_bytes, accepted);
    if (encoder.encode(serialized).byteLength > args.max_bytes) {
      accepted[candidate.key].pop();
      break;
    }
    admitted += 1;
  }
  const serialized = serialize(args.ledger.run_id, args.max_bytes, accepted);
  const usedBytes = encoder.encode(serialized).byteLength;
  if (usedBytes > args.max_bytes) {
    throw new Error(`continuity seed fixed metadata exceeds max_bytes cap (${args.max_bytes})`);
  }
  let omittedItems = 0;
  let omittedPackets = 0;
  for (const candidate of ordered.slice(admitted)) {
    if (candidate.packet) omittedPackets += 1;
    else omittedItems += 1;
  }
  return Object.freeze({
    rendered: serialized,
    sections: Object.freeze({
      blocking_questions: Object.freeze([...accepted.blocking_questions]),
      recipient_next_steps: Object.freeze([...accepted.recipient_next_steps]),
      risks_and_decisions: Object.freeze([...accepted.risks_and_decisions]),
      other_active_findings: Object.freeze([...accepted.other_active_findings]),
      evaluations: Object.freeze([
        ...accepted.evaluations,
      ]) as readonly ContinuityResolvedEvaluation[],
      packet_summaries: Object.freeze([...accepted.packet_summaries]),
    }) as ContinuitySeedSections,
    omitted_items: omittedItems,
    omitted_packets: omittedPackets,
    used_bytes: usedBytes,
    max_bytes: args.max_bytes,
  });
}

function serialize(
  runId: string,
  maxBytes: number,
  sections: Record<SectionKey, unknown[]>,
): string {
  let used = 0;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const text = stableJsonStringify({
      schema_version: 1,
      run_id: runId,
      budget: { max_bytes: maxBytes, used_bytes: used },
      omitted: { items: 0, packets: 0 },
      sections,
      packet_summaries: sections.packet_summaries,
    });
    const measured = encoder.encode(text).byteLength;
    if (measured === used) return text;
    used = measured;
  }
  throw new Error("continuity seed byte accounting did not converge");
}

// ─── Optional ranking input on the legacy renderer (spec §8 backward-compat) ──

/**
 * Backward-compatible three-argument overload that preserves the exact
 * legacy `(ledger, maxBytes)` semantics when `ranking` is `null`.
 * Existing callers of `renderContinuitySeed(ledger, maxBytes)` continue
 * to receive the legacy rendered text byte-for-byte; the new optional
 * `ranking` argument activates the host-annotation path.
 */
export function renderRankedContinuitySeed(
  ledger: ContinuityLedger,
  maxBytes: number,
  ranking: {
    readonly recipient: RankedRecipient;
    readonly policy: RankedCandidatePolicy;
    readonly source_transition_key: string;
    readonly judgments: readonly RankedCandidateProjectionJudgment[];
  } | null,
): ContinuitySeed {
  if (ranking === null) return renderLegacyContinuitySeed(ledger, maxBytes);
  const built = buildRankedSeed({
    ledger,
    max_bytes: maxBytes,
    ranking_input: {
      recipient: ranking.recipient,
      policy: ranking.policy,
      source_transition_key: ranking.source_transition_key,
    },
    judgments: ranking.judgments,
  });
  return Object.freeze({
    schema_version: 1,
    run_id: ledger.run_id,
    budget: Object.freeze({ max_bytes: maxBytes, used_bytes: built.used_bytes }),
    omitted: Object.freeze({
      items: built.omitted_items,
      packets: built.omitted_packets,
    }),
    rendered: built.rendered,
    sections: built.sections,
  }) as ContinuitySeed;
}
