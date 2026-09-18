/**
 * Deterministic renderers for the continuity ledger — spec §11, §12, §14.
 *
 * Three output formats:
 * 1. JSON full operator view — deterministic key order, byte-identical replays
 * 2. Markdown human-readable ledger — provenance, evidence status, escaped text
 * 3. OKF candidates — verified, non-superseded findings with exact evidence
 *
 * Renderers never fetch URLs, never execute packet content, and never mutate
 * the run or repository.
 *
 * Write-owned by: Lane C (DC-LEDGER). Reads only shared contracts from
 * `src/persistence/continuity.ts` and `src/persistence/continuity-materialization.ts`.
 */

import {
  type ContinuityLedger,
  type ContinuityOkfCandidate,
  escapeMarkdownText,
  stableJsonStringify,
} from "./continuity.js";

// ─── Renderer return types ──────────────────────────────────────────────

/** JSON operator view of the continuity ledger. */
export interface ContinuityLedgerJsonView {
  readonly schema_version: 1;
  readonly run_id: string;
  readonly generated_at: string;
  readonly envelope_count: number;
  readonly byte_count: number;
  /** Complete durable envelopes retain summaries, raw references, and resolutions. */
  readonly envelopes: ContinuityLedger["envelopes"];
  readonly evidence_resolutions: ContinuityLedger["evidence_resolutions"];
  readonly findings: readonly {
    readonly id: string;
    readonly kind: string;
    readonly confidence: string;
    readonly statement: string;
    readonly superseded_by: readonly string[];
    readonly active: boolean;
    readonly source: string;
    readonly record_id: string;
    readonly evidence_count: number;
  }[];
  readonly evaluations: readonly {
    readonly id: string;
    readonly label: string;
    readonly execution_id: string;
    readonly status: string;
    readonly exit_summary: string;
    readonly cleanup_disposition: string;
    readonly command_digest: string | null;
    readonly superseded_by: readonly string[];
    readonly source: string;
    readonly record_id: string;
  }[];
  readonly open_questions: readonly {
    readonly id: string;
    readonly question: string;
    readonly blocking: boolean;
    readonly superseded_by: readonly string[];
    readonly active: boolean;
    readonly source: string;
    readonly record_id: string;
    readonly evidence_count: number;
  }[];
  readonly next_steps: readonly {
    readonly id: string;
    readonly action: string;
    readonly owner: string;
    readonly superseded_by: readonly string[];
    readonly active: boolean;
    readonly source: string;
    readonly record_id: string;
    readonly evidence_count: number;
  }[];
  readonly okf_candidates: readonly {
    readonly finding_id: string;
    readonly statement: string;
    readonly evidence: ContinuityOkfCandidate["evidence"];
    readonly envelope_source: string;
    readonly record_id: string;
  }[];
  readonly counts: {
    readonly active_finding_count: number;
    readonly superseded_finding_count: number;
    readonly active_question_count: number;
    readonly superseded_question_count: number;
    readonly active_next_step_count: number;
    readonly superseded_next_step_count: number;
    readonly okf_candidate_count: number;
  };
}

/** OKF-candidates view. */
export interface ContinuityOkfCandidatesView {
  readonly schema_version: 1;
  readonly run_id: string;
  readonly generated_at: string;
  readonly candidates: readonly ContinuityOkfCandidate[];
}

// ─── JSON renderer (spec §11) ───────────────────────────────────────────

/**
 * Render the full operator JSON view of the continuity ledger.
 * Deterministic: stable JSON key order, byte-identical across replays.
 */
export function renderLedgerJson(ledger: ContinuityLedger): string {
  const view: ContinuityLedgerJsonView = {
    schema_version: 1,
    run_id: ledger.run_id,
    generated_at: ledger.generated_at,
    envelope_count: ledger.counts.envelope_count,
    byte_count: ledger.counts.byte_count,
    envelopes: ledger.envelopes,
    evidence_resolutions: ledger.evidence_resolutions,
    findings: ledger.findings.map((f) => ({
      id: f.item.id,
      kind: f.item.kind,
      confidence: f.item.confidence,
      statement: f.item.statement,
      superseded_by: f.superseded_by,
      active: f.superseded_by.length === 0,
      source: f.envelope_source,
      record_id: f.record_id,
      evidence_count: f.item.evidence.length,
    })),
    evaluations: ledger.evaluations.map((e) => ({
      id: e.id,
      label: e.label,
      execution_id: e.execution_id,
      status: e.status,
      exit_summary: e.exit_summary,
      cleanup_disposition: e.cleanup_disposition,
      command_digest: e.command_digest,
      superseded_by: e.superseded_by,
      source: e.envelope_source,
      record_id: e.record_id,
    })),
    open_questions: ledger.open_questions.map((q) => ({
      id: q.item.id,
      question: q.item.question,
      blocking: q.item.blocking,
      superseded_by: q.superseded_by,
      active: q.superseded_by.length === 0,
      source: q.envelope_source,
      record_id: q.record_id,
      evidence_count: q.item.evidence.length,
    })),
    next_steps: ledger.next_steps.map((ns) => ({
      id: ns.item.id,
      action: ns.item.action,
      owner: ns.item.owner,
      superseded_by: ns.superseded_by,
      active: ns.superseded_by.length === 0,
      source: ns.envelope_source,
      record_id: ns.record_id,
      evidence_count: ns.item.evidence.length,
    })),
    okf_candidates: ledger.okf_candidates.map((c) => ({
      finding_id: c.finding_id,
      statement: c.statement,
      evidence: c.evidence,
      envelope_source: c.envelope_source,
      record_id: c.record_id,
    })),
    counts: ledger.counts,
  };

  return stableJsonStringify(view);
}

export { renderLedgerMarkdown } from "./continuity-render-markdown.js";

// ─── OKF-candidates renderer (spec §11, §6.5) ─────────────────────────

/**
 * Render only non-superseded, verified OKF candidates with exact source
 * evidence and provenance.
 *
 * Emits an empty array when no findings qualify.
 *
 * spec §6.5: "Candidates must be verified and may not be superseded in
 * that packet. Invalid references fail closed."
 */
export function renderOkfCandidates(ledger: ContinuityLedger): string {
  const view: ContinuityOkfCandidatesView = {
    schema_version: 1,
    run_id: ledger.run_id,
    generated_at: ledger.generated_at,
    candidates: ledger.okf_candidates,
  };

  return stableJsonStringify(view);
}

// ─── Re-export helpers for tests ───────────────────────────────────────

export { escapeMarkdownText };
