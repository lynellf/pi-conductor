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

import type {
  ContinuityFinding,
  ContinuityNextStep,
  ContinuityQuestion,
} from "../seam/continuity.js";
import {
  type ContinuityActiveOrSupersededItem,
  type ContinuityLedger,
  type ContinuityOkfCandidate,
  type ContinuityResolvedEvaluation,
  escapeMarkdownText,
  stableJsonStringify,
} from "./continuity.js";

// ─── Stable Markdown escaping (spec §14) ─────────────────────────────────

/**
 * Escape a block of text that may contain multiple paragraphs.
 * Each line is processed separately to preserve paragraph structure.
 *
 * spec §14: "Packet text is untrusted input. It is escaped in Markdown
 * output and never executed as a command. URLs are data; rendering does not
 * fetch them."
 */
function escapeBlock(text: string): string {
  return text.split("\n").map(escapeMarkdownText).join("\n");
}

// ─── Renderer return types ──────────────────────────────────────────────

/** JSON operator view of the continuity ledger. */
export interface ContinuityLedgerJsonView {
  readonly schema_version: 1;
  readonly run_id: string;
  readonly generated_at: string;
  readonly envelope_count: number;
  readonly byte_count: number;
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
    readonly evidence: readonly {
      readonly ref_key: string;
      readonly status: string;
      readonly resolved_path?: string;
    }[];
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
      evidence: c.evidence.map((e) => {
        const base = { ref_key: e.ref_key, status: e.status };
        return e.resolved_path !== undefined ? { ...base, resolved_path: e.resolved_path } : base;
      }),
      envelope_source: c.envelope_source,
      record_id: c.record_id,
    })),
    counts: ledger.counts,
  };

  return stableJsonStringify(view);
}

// ─── Markdown renderer (spec §11, §12, §14) ─────────────────────────────

/**
 * Render the human-readable Markdown ledger.
 *
 * - Provenance: source, role, visit, record identity, timestamp
 * - Evidence status: verified/declared/missing per reference
 * - Escaped untrusted text (no HTML injection, no command execution)
 * - URLs emitted as text only
 *
 * spec §14: "Packet text is untrusted input. It is escaped in Markdown
 * output and never executed as a command. URLs are data; rendering does
 * not fetch them."
 */
export function renderLedgerMarkdown(ledger: ContinuityLedger): string {
  const lines: string[] = [];

  // Header
  lines.push("# Continuity Ledger");
  lines.push("");
  lines.push(`- **Run ID:** ${escapeMarkdownText(ledger.run_id)}`);
  lines.push(`- **Generated:** ${escapeMarkdownText(ledger.generated_at)}`);
  lines.push(
    `- **Envelopes:** ${ledger.counts.envelope_count} | **Bytes:** ${ledger.counts.byte_count}`,
  );
  lines.push("");

  // Summary counts
  lines.push("## Summary");
  lines.push("");
  lines.push(`| Category | Active | Superseded | Total |`);
  lines.push(`|---|---|---|---|`);
  lines.push(
    `| Findings | ${ledger.counts.active_finding_count} | ${ledger.counts.superseded_finding_count} | ${ledger.counts.active_finding_count + ledger.counts.superseded_finding_count} |`,
  );
  lines.push(
    `| Questions | ${ledger.counts.active_question_count} | ${ledger.counts.superseded_question_count} | ${ledger.counts.active_question_count + ledger.counts.superseded_question_count} |`,
  );
  lines.push(
    `| Next Steps | ${ledger.counts.active_next_step_count} | ${ledger.counts.superseded_next_step_count} | ${ledger.counts.active_next_step_count + ledger.counts.superseded_next_step_count} |`,
  );
  lines.push(
    `| OKF Candidates | ${ledger.counts.okf_candidate_count} | — | ${ledger.counts.okf_candidate_count} |`,
  );
  lines.push("");

  // Findings
  if (ledger.findings.length > 0) {
    lines.push("## Findings");
    lines.push("");
    for (const f of ledger.findings) {
      renderFindingMarkdown(lines, f);
    }
  }

  // Open Questions
  if (ledger.open_questions.length > 0) {
    lines.push("## Open Questions");
    lines.push("");
    for (const q of ledger.open_questions) {
      renderQuestionMarkdown(lines, q);
    }
  }

  // Next Steps
  if (ledger.next_steps.length > 0) {
    lines.push("## Next Steps");
    lines.push("");
    for (const ns of ledger.next_steps) {
      renderNextStepMarkdown(lines, ns);
    }
  }

  // Evaluations
  if (ledger.evaluations.length > 0) {
    lines.push("## Evaluations");
    lines.push("");
    for (const e of ledger.evaluations) {
      renderEvaluationMarkdown(lines, e);
    }
  }

  // Envelope provenance log
  if (ledger.envelopes.length > 0) {
    lines.push("## Provenance Log");
    lines.push("");
    lines.push(`| # | Source | Role | Record | Timestamp | Bytes |`);
    lines.push(`|---|---|---|---|---|---|`);
    ledger.envelopes.forEach((env, i) => {
      const sourceBadge = env.source === "handoff" ? "handoff" : "delegated";
      const childInfo =
        env.child !== undefined ? ` → ${escapeMarkdownText(env.child.subagent)}` : "";
      lines.push(
        `| ${i + 1} | ${sourceBadge}${childInfo} | ${escapeMarkdownText(env.role)} | ${escapeMarkdownText(env.record_id)} | ${escapeMarkdownText(env.accepted_at)} | ${env.packet_utf8_bytes} |`,
      );
    });
    lines.push("");
  }

  // OKF Candidates
  if (ledger.okf_candidates.length > 0) {
    lines.push("## OKF Candidates");
    lines.push("");
    lines.push("| Finding | Statement | Evidence | Source |");
    lines.push("|---|---|---|---|");
    for (const c of ledger.okf_candidates) {
      const evidenceStatus = c.evidence.map((e) => `${e.ref_key}: ${e.status}`).join(", ");
      const truncatedStatement =
        c.statement.length > 80 ? `${c.statement.slice(0, 80)}\u2026` : c.statement;
      lines.push(
        `| ${escapeMarkdownText(c.finding_id)} | ${escapeMarkdownText(truncatedStatement)} | ${escapeMarkdownText(evidenceStatus)} | ${c.envelope_source} |`,
      );
    }
    lines.push("");
  }

  // Footer
  lines.push("---");
  lines.push("*This ledger was deterministically generated from append-only run records.*");
  lines.push("*Packet text is escaped; URLs are not fetched or linked.*");

  return lines.join("\n");
}

function renderFindingMarkdown(
  lines: string[],
  f: ContinuityActiveOrSupersededItem<ContinuityFinding>,
): void {
  const activeMarker = f.superseded_by.length === 0 ? "✅" : "❌";
  const supersessionNote =
    f.superseded_by.length > 0
      ? ` *(superseded by: ${f.superseded_by.map(escapeMarkdownText).join(", ")})*`
      : "";

  lines.push(`### ${activeMarker} ${escapeMarkdownText(f.item.id)}`);
  lines.push("");
  lines.push(`- **Kind:** ${escapeMarkdownText(f.item.kind)}`);
  lines.push(`- **Confidence:** ${escapeMarkdownText(f.item.confidence)}`);
  lines.push(`- **Statement:** ${escapeBlock(f.item.statement)}`);
  lines.push(`- **Evidence:** ${f.item.evidence.length} reference(s)${supersessionNote}`);
  lines.push(`- **Source:** ${f.envelope_source} | **Record:** ${escapeMarkdownText(f.record_id)}`);
  lines.push("");
}

function renderQuestionMarkdown(
  lines: string[],
  q: ContinuityActiveOrSupersededItem<ContinuityQuestion>,
): void {
  const activeMarker = q.superseded_by.length === 0 ? "✅" : "❌";
  const blockingMarker = q.item.blocking ? "🚧 **BLOCKING**" : "";
  const supersessionNote =
    q.superseded_by.length > 0
      ? ` *(superseded by: ${q.superseded_by.map(escapeMarkdownText).join(", ")})*`
      : "";

  lines.push(`### ${activeMarker} ${escapeMarkdownText(q.item.id)} ${blockingMarker}`);
  lines.push("");
  lines.push(`- **Question:** ${escapeBlock(q.item.question)}`);
  lines.push(`- **Evidence:** ${q.item.evidence.length} reference(s)${supersessionNote}`);
  lines.push(`- **Source:** ${q.envelope_source} | **Record:** ${escapeMarkdownText(q.record_id)}`);
  lines.push("");
}

function renderNextStepMarkdown(
  lines: string[],
  ns: ContinuityActiveOrSupersededItem<ContinuityNextStep>,
): void {
  const activeMarker = ns.superseded_by.length === 0 ? "✅" : "❌";
  const supersessionNote =
    ns.superseded_by.length > 0
      ? ` *(superseded by: ${ns.superseded_by.map(escapeMarkdownText).join(", ")})*`
      : "";

  lines.push(`### ${activeMarker} ${escapeMarkdownText(ns.item.id)}`);
  lines.push("");
  lines.push(`- **Action:** ${escapeBlock(ns.item.action)}`);
  lines.push(`- **Owner:** ${escapeMarkdownText(ns.item.owner)}`);
  lines.push(`- **Evidence:** ${ns.item.evidence.length} reference(s)${supersessionNote}`);
  lines.push(
    `- **Source:** ${ns.envelope_source} | **Record:** ${escapeMarkdownText(ns.record_id)}`,
  );
  lines.push("");
}

function renderEvaluationMarkdown(lines: string[], e: ContinuityResolvedEvaluation): void {
  const supersessionNote =
    e.superseded_by.length > 0
      ? ` *(superseded by: ${e.superseded_by.map(escapeMarkdownText).join(", ")})*`
      : "";

  lines.push(`- **${escapeMarkdownText(e.id)}** — ${escapeMarkdownText(e.label)}`);
  lines.push(
    `  - Status: \`${e.status}\` | Execution: \`${escapeMarkdownText(e.execution_id)}\`${supersessionNote}`,
  );
  if (e.command_digest !== null) {
    lines.push(`  - Command digest: \`${escapeMarkdownText(e.command_digest)}\``);
  }
  lines.push("");
}

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
