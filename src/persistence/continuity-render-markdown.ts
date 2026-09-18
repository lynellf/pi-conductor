/** Safe deterministic Markdown continuity renderer — spec §12, §14. */
import type {
  ContinuityFinding,
  ContinuityNextStep,
  ContinuityQuestion,
} from "../seam/continuity.js";
import type {
  ContinuityActiveOrSupersededItem,
  ContinuityLedger,
  ContinuityResolvedEvaluation,
} from "./continuity.js";
import { escapeMarkdownText } from "./continuity.js";

function escapeBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => `\u200b${escapeMarkdownText(line)}`)
    .join("\n");
}
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

  // Exact host-authored evidence resolutions. This is deliberately not a
  // count: operators must be able to distinguish declared/missing evidence
  // and inspect the record-bound resolution provenance.
  if (ledger.evidence_resolutions.length > 0) {
    lines.push("## Evidence Resolutions");
    lines.push("");
    for (const resolution of ledger.evidence_resolutions) {
      const provenance = [
        resolution.resolved_path,
        resolution.resolved_commit,
        resolution.diagnostic,
      ]
        .filter((value): value is string => value !== undefined)
        .map(escapeMarkdownText)
        .join(" | ");
      lines.push(
        `- \`${escapeMarkdownText(resolution.ref_key)}\`: **${escapeMarkdownText(resolution.status)}** (${escapeMarkdownText(resolution.kind)})${provenance.length === 0 ? "" : ` — ${provenance}`}`,
      );
    }
    lines.push("");
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
