/** Markdown rendering for the aggregate-only issue #154 offline report. */

import {
  DELEGATION_ADVISORY_BUCKETS,
  DELEGATION_ADVISORY_HOST_STATUSES,
  type DelegationAdvisoryReport,
  type DelegationAdvisoryStatusBreakdown,
} from "./delegation-advisory-report.js";

/** Render counts and within-group rates without exposing record identities or prose. */
export function renderDelegationAdvisoryReportMarkdown(report: DelegationAdvisoryReport): string {
  const lines = [
    "# Delegation advisory calibration report",
    "",
    "## Coverage",
    "",
    "| advisory | population | completed | unavailable | missing |",
    "| --- | ---: | ---: | ---: | ---: |",
    `| dispatch | ${report.coverage.admitted_tasks} admitted tasks | ${report.coverage.dispatch.completed} | ${report.coverage.dispatch.unavailable} | ${report.coverage.dispatch.missing} |`,
    `| result | ${report.coverage.terminal_children} terminal children | ${report.coverage.result.completed} | ${report.coverage.result.unavailable} | ${report.coverage.result.missing} |`,
    "",
    "Status cells show count (share of the row); the report makes no recommendations.",
    "",
    "## Noul judgments",
    "",
    "| question | probability bucket | completed | no_changes | blocked | failed | cancelled | total |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const question of Object.keys(
    report.noul,
  ).sort() as (keyof DelegationAdvisoryReport["noul"])[]) {
    const buckets = report.noul[question].by_probability_bucket;
    for (const bucket of DELEGATION_ADVISORY_BUCKETS) {
      lines.push(
        `| ${question} | ${bucket} | ${formatStatusCells(buckets[bucket])} | ${buckets[bucket].total} |`,
      );
    }
  }
  for (const choiceName of ["scope", "profile_fit", "claims_supported"] as const) {
    const choice = report.choices[choiceName];
    lines.push(
      "",
      `## Choice: ${choiceName}`,
      "",
      "| grouping | option or bucket | completed | no_changes | blocked | failed | cancelled | total |",
      "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const [option, breakdown] of Object.entries(choice.by_argmax).sort(([a], [b]) =>
      compareText(a, b),
    )) {
      lines.push(
        `| argmax | ${escapeTableCell(option)} | ${formatStatusCells(breakdown)} | ${breakdown.total} |`,
      );
    }
    for (const bucket of DELEGATION_ADVISORY_BUCKETS) {
      const breakdown = choice.by_confidence_bucket[bucket];
      lines.push(
        `| confidence | ${bucket} | ${formatStatusCells(breakdown)} | ${breakdown.total} |`,
      );
    }
  }
  const fit = report.choices.profile_fit;
  lines.push(
    "",
    "## Profile fit",
    "",
    `- agreement: ${fit.agreement.agreed}/${fit.agreement.judged} (${formatNullableRate(fit.agreement.rate)})`,
    `- omitted: single_profile=${fit.omitted.single_profile}, missing_descriptions=${fit.omitted.missing_descriptions}`,
    "",
    "| assignment comparison | completed | no_changes | blocked | failed | cancelled | total |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| agree | ${formatStatusCells(fit.outcomes.agree)} | ${fit.outcomes.agree.total} |`,
    `| disagree | ${formatStatusCells(fit.outcomes.disagree)} | ${fit.outcomes.disagree.total} |`,
    "",
    "## Contradicted claims by host status",
    "",
    "| host status | contradicted | total | rate |",
    "| --- | ---: | ---: | ---: |",
  );
  for (const status of DELEGATION_ADVISORY_HOST_STATUSES) {
    const value = report.choices.claims_supported.contradicted_by_host_status[status];
    lines.push(
      `| ${status} | ${value.contradicted} | ${value.total} | ${formatNullableRate(value.rate)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function formatStatusCells(breakdown: DelegationAdvisoryStatusBreakdown): string {
  return DELEGATION_ADVISORY_HOST_STATUSES.map(
    (status) =>
      `${breakdown.status_counts[status]} (${formatRate(breakdown.status_rates[status])})`,
  ).join(" | ");
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function formatNullableRate(rate: number | null): string {
  return rate === null ? "n/a" : formatRate(rate);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapeTableCell(value: string): string {
  return value.replace(/[&<>|\\\r\n]/g, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    if (character === "\r") return "\\r";
    if (character === "\n") return "\\n";
    return `\\${character}`;
  });
}
