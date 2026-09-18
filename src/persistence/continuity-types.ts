/** Durable continuity ledger and seed contracts — spec §10–§11. */
import type { Static } from "typebox";
import type { ContinuityEvidenceResolution, Role } from "../core/types.js";
import type {
  ContinuityFinding,
  ContinuityNextStep,
  ContinuityPacketV1,
  ContinuityQuestion,
  EvidenceRef,
} from "../seam/continuity.js";
import type { continuitySiblingSchema } from "./delegation-lifecycle-schema.js";
import type { PersistedRecord } from "./log.js";
export type ContinuityEnvelopeSource = "handoff" | "delegated_result";

/** Bounded host-authored child provenance for `delegated_result` envelopes. */
export interface ContinuityChildProvenance {
  readonly child_id: string;
  readonly subagent: string;
  readonly task_id: string;
  readonly attempt: number;
}

/** Normalized continuity envelope materialized from durable records. */
export interface ContinuityEnvelopeV1 {
  readonly schema_version: 1;
  readonly source: ContinuityEnvelopeSource;
  readonly record_id: string;
  readonly run_id: string;
  readonly role: Role;
  readonly visit: number;
  readonly child?: ContinuityChildProvenance;
  readonly accepted_at: string;
  readonly packet_utf8_bytes: number;
  readonly packet: ContinuityPacketV1;
  readonly evidence_resolutions: readonly ContinuityEvidenceResolution[];
}

/**
 * Spec §9 / §10: additive host-authored continuity sibling persisted on
 * successful child completion records. Derived from the TypeBox schema in
 * `delegation-lifecycle-schema.ts` so the durable record shape stays in
 * one place. The surrounding `subagent_completed` record remains the
 * source of run/parent/child/task/attempt provenance — never the child.
 */
export type ChildContinuitySibling = Static<typeof continuitySiblingSchema>;

// ─── Materialized ledger + bounded seed (spec §11) ──────────────────────

/** Bounded, deterministic projection of the run's continuity envelopes. */
export interface ContinuityLedger {
  readonly run_id: string;
  readonly generated_at: string;
  readonly envelopes: readonly ContinuityEnvelopeV1[];
  readonly findings: readonly ContinuityActiveOrSupersededItem<ContinuityFinding>[];
  readonly evaluations: readonly ContinuityResolvedEvaluation[];
  readonly open_questions: readonly ContinuityActiveOrSupersededItem<ContinuityQuestion>[];
  readonly next_steps: readonly ContinuityActiveOrSupersededItem<ContinuityNextStep>[];
  readonly evidence_resolutions: readonly ContinuityEvidenceResolution[];
  readonly okf_candidates: readonly ContinuityOkfCandidate[];
  readonly counts: ContinuityLedgerCounts;
}

export interface ContinuityLedgerCounts {
  readonly envelope_count: number;
  readonly byte_count: number;
  readonly active_finding_count: number;
  readonly superseded_finding_count: number;
  readonly active_question_count: number;
  readonly superseded_question_count: number;
  readonly active_next_step_count: number;
  readonly superseded_next_step_count: number;
  readonly okf_candidate_count: number;
}

/** Generic active-or-superseded item shape reused for findings/questions/next-steps. */
export interface ContinuityActiveOrSupersededItem<T = unknown> {
  readonly item: T;
  readonly superseded_by: readonly string[];
  readonly envelope_source: ContinuityEnvelopeSource;
  readonly record_id: string;
}

/** Host-derived evaluation outcome (spec §6.3: model cannot supply). */
export interface ContinuityResolvedEvaluation {
  readonly id: string;
  readonly label: string;
  readonly execution_id: string;
  readonly status: "passed" | "failed" | "incomplete" | "unverified";
  readonly exit_summary: string;
  readonly cleanup_disposition: "confirmed" | "unconfirmed" | "unknown";
  readonly command_digest: string | null;
  readonly superseded_by: readonly string[];
  readonly envelope_source: ContinuityEnvelopeSource;
  readonly record_id: string;
}

/** Verified OKF candidate projection (spec §6.5). */
export interface ContinuityOkfCandidate {
  readonly finding_id: string;
  readonly statement: string;
  /** Exact model-authored reference paired with its host-authored resolution. */
  readonly evidence: readonly (ContinuityEvidenceResolution & {
    readonly ref: EvidenceRef;
  })[];
  readonly envelope_source: ContinuityEnvelopeSource;
  readonly record_id: string;
}

/** Bounded materializer seed (spec §11) injected into fresh role memory. */
export interface ContinuitySeed {
  readonly schema_version: 1;
  readonly run_id: string;
  readonly budget: {
    readonly max_bytes: number;
    readonly used_bytes: number;
  };
  readonly omitted: {
    readonly items: number;
    readonly packets: number;
  };
  readonly rendered: string;
  /** Stable JSON projection used by `renderContinuitySeed` callers. */
  readonly sections: ContinuitySeedSections;
}

export interface ContinuitySeedSections {
  readonly blocking_questions: readonly unknown[];
  readonly recipient_next_steps: readonly unknown[];
  readonly risks_and_decisions: readonly unknown[];
  readonly other_active_findings: readonly unknown[];
  readonly evaluations: readonly ContinuityResolvedEvaluation[];
  readonly packet_summaries: readonly unknown[];
}

// ─── Materializer + renderer signatures (spec §11) ─────────────────────

/**
 * Fold validated envelopes in canonical record order. Pure over the
 * record log and the resolved evidence map; filesystem/network
 * resolution happens before this call. Implementations live in
 * `src/persistence/continuity-materialization.ts`.
 */
export type MaterializeContinuity = (
  records: readonly PersistedRecord[],
  policy: ContinuityMaterializationPolicy,
) => ContinuityLedger;

export interface ContinuityMaterializationPolicy {
  readonly run_id: string;
  /** Policy supplied from the pinned manifest snapshot; absent = no policy. */
  readonly continuity?: {
    readonly schema_version: 1;
    readonly require_handoff: boolean;
    readonly require_delegated_result: boolean;
    readonly seed_max_utf8_bytes: number;
  };
  /** Flattened legacy fields preserved for backward compatibility with
   *  pre-v1 callers that spread a v1 manifest policy at the top level.
   *  New code passes `continuity` (the policy itself). */
  readonly schema_version?: 1;
  readonly require_handoff?: boolean;
  readonly require_delegated_result?: boolean;
  readonly seed_max_utf8_bytes?: number;
  /** Optional caller-supplied current time; null uses record timestamps. */
  readonly now?: () => Date;
}

/**
 * Render the bounded seed for a fresh role session. Atomic truncation:
 * the byte budget is consumed item-by-item and the function records the
 * omitted counts. Byte-identical across replays of the same ledger.
 */
export type RenderContinuitySeed = (ledger: ContinuityLedger, maxBytes: number) => ContinuitySeed;

// ─── Stable textual seed builders (used by the renderer) ──────────────

/**
 * Escape a continuity text value for safe Markdown rendering (spec §14).
 *
 * CR/LF must be neutralized here as well as the visible control characters.
 * Table-cell and list-item renderers feed `escapeMarkdownText` directly; a
 * payload whose summary contains `\n` would otherwise break out of the row
 * and inject the next line as a Markdown list item or table row, letting
 * untrusted text rewrite downstream rendering (e.g. `- spoofed finding`).
 * `escapeBlock` is responsible for the paragraph case (it splits on `\n`
 * first and joins with `\n`); the byte sequences below stay literal escapes
 * (`\\n`, `\\r`) so the cell remains a single visible line.
 */
export function escapeMarkdownText(text: string): string {
  // Conservative escape: neutralize the Markdown control characters that
  // can flip a paragraph into a heading, list, link, code span, or HTML
  // block, and CR/LF so multi-line input cannot break scalar contexts.
  // Parentheses are escaped because the inline-link syntax `[text](url)`
  // would otherwise render as a clickable link in downstream consumers.
  //
  // Single-pass via callback: each matched character is mapped to its
  // two-character literal escape sequence in one `replace` call. Chaining
  // a CR/LF pass with the visible-character pass would re-escape the
  // inserted backslashes (e.g. `\n` would become `\\n` because the
  // next pass escapes the literal `\`); a single pass avoids that.
  return text.replace(/[\\`*_[\](){}<>!#|\r\n]/g, (ch) => {
    if (ch === "\r") return "\\r";
    if (ch === "\n") return "\\n";
    return `\\${ch}`;
  });
}

/** Stable evidence key namespace used by both lanes. */
export function evidenceRefKey(
  collection: "findings" | "evaluations" | "open_questions" | "next_steps",
  itemId: string,
  index: number,
): string {
  return `${collection}:${itemId}:${index}`;
}

/** Stable OKF candidate key for record→ledger mapping. */
export function okfCandidateKey(envelope: ContinuityEnvelopeV1, findingId: string): string {
  return `${envelope.record_id}:${findingId}`;
}
