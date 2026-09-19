/**
 * Pure recipient-context ranking primitives — jev-context-ranking spec §6, §8.
 *
 * Public API surface:
 *  - `projectRankedCandidates`: derive a deterministic scored prefix +
 *    unscored suffix from the canonical ledger (no model calls, no ambient state).
 *  - `rankCandidatesForSection`: stable within-section ordering (descending
 *    score, baseline ordinal tie-break, unscored suffix stability).
 *  - `buildRankedSeed`/`renderRankedContinuitySeed`: render the byte-bounded
 *    seed with optional host annotation wrapper while preserving the
 *    byte-identical baseline when enrichment is disabled or unavailable.
 *
 * Projection internals live in `continuity-ranking-projection.ts` to keep
 * this module at the AGENTS.md ~400 LOC ceiling.
 *
 * This module is host-agnostic — it imports no pi SDK, no provider, and
 * performs no network I/O. It is the pure counterpart to the host
 * TypeSafe adapter (`src/host/context-enrichment/typesafe-client.ts`).
 */

import { renderContinuitySeed as renderLegacyContinuitySeed } from "./continuity-seed.js";
import { stableJsonStringify } from "./continuity-semantics.js";
import type {
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

// ─── Re-export projection helper ────────────────────────────────────────

import { projectRankedCandidates } from "./continuity-ranking-projection.js";

export { projectRankedCandidates };

// ─── Within-section ranking (spec §8) ───────────────────────────────────

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
  const expectedKeys = new Set(projection.scored_prefix.map((entry) => entry.candidate_key));
  for (const judgment of judgments) {
    if (!expectedKeys.has(judgment.candidate_key)) {
      throw new Error(
        `ranked seed judgment '${judgment.candidate_key}' is not in the scored candidate prefix`,
      );
    }
    if (judgmentsByKey.has(judgment.candidate_key)) {
      throw new Error(`ranked seed has duplicate judgment '${judgment.candidate_key}'`);
    }
    judgmentsByKey.set(judgment.candidate_key, judgment);
  }
  for (const key of expectedKeys) {
    if (!judgmentsByKey.has(key)) {
      throw new Error(`ranked seed is missing judgment '${key}'`);
    }
  }

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
      if (judgment === undefined) {
        throw new Error(`ranked seed is missing judgment '${entry.candidate_key}'`);
      }
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
    const serialized = serialize(args.ledger.run_id, args.max_bytes, accepted, {
      items: 0,
      packets: 0,
    });
    if (encoder.encode(serialized).byteLength > args.max_bytes) {
      accepted[candidate.key].pop();
      break;
    }
    admitted += 1;
  }
  // Compute truthful omission counts from the items we did NOT admit.
  let omittedItems = 0;
  let omittedPackets = 0;
  for (const candidate of ordered.slice(admitted)) {
    if (candidate.packet) omittedPackets += 1;
    else omittedItems += 1;
  }
  const serialized = serialize(args.ledger.run_id, args.max_bytes, accepted, {
    items: omittedItems,
    packets: omittedPackets,
  });
  const usedBytes = encoder.encode(serialized).byteLength;
  if (usedBytes > args.max_bytes) {
    throw new Error(`continuity seed fixed metadata exceeds max_bytes cap (${args.max_bytes})`);
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
  omission: { readonly items: number; readonly packets: number },
): string {
  let used = 0;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const text = stableJsonStringify({
      schema_version: 1,
      run_id: runId,
      budget: { max_bytes: maxBytes, used_bytes: used },
      omitted: { items: omission.items, packets: omission.packets },
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
