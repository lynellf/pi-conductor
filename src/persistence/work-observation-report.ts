/** Operator rendering for host-generated v2 observations (§18). */

import type { ContextEnrichmentRecordV2 } from "./context-enrichment-v2.js";
import type { WorkObservationV2 } from "./work-observation.js";

export interface WorkObservationEnrichmentReport {
  readonly recipient_role: string;
  readonly recipient_visit: number;
  readonly status: ContextEnrichmentRecordV2["status"];
  readonly candidate_count: number;
  readonly candidate_keys: readonly string[];
  readonly judgments?: readonly {
    readonly observation_key: string;
    readonly score: number;
    readonly ranking_certainty: number;
  }[];
  readonly usage?: ContextEnrichmentRecordV2["usage"];
  readonly failure?: ContextEnrichmentRecordV2["failure"];
}

function reportEnrichment(record: ContextEnrichmentRecordV2): WorkObservationEnrichmentReport {
  return {
    recipient_role: record.recipient_role,
    recipient_visit: record.recipient_visit,
    status: record.status,
    candidate_count: record.candidate_count,
    candidate_keys: record.candidate_keys,
    ...(record.judgments === undefined
      ? {}
      : {
          judgments: record.judgments.map((judgment) => ({
            observation_key: judgment.observation_key,
            score: judgment.score,
            ranking_certainty: judgment.ranking_certainty,
          })),
        }),
    ...(record.usage === undefined ? {} : { usage: record.usage }),
    ...(record.failure === undefined ? {} : { failure: record.failure }),
  };
}

/** Render a deterministic v2 JSON operator view. */
export function renderWorkObservationJson(
  observations: readonly WorkObservationV2[],
  enrichments: readonly ContextEnrichmentRecordV2[] = [],
): string {
  return JSON.stringify(
    {
      schema_version: 2,
      observations,
      enrichments: enrichments.map(reportEnrichment),
      okf_candidates: [],
    },
    null,
    2,
  );
}

/** Render chronological v2 observations without interpreting model prose as truth. */
export function renderWorkObservationMarkdown(
  observations: readonly WorkObservationV2[],
  enrichments: readonly ContextEnrichmentRecordV2[] = [],
): string {
  const lines = ["# Host-generated continuity v2", "", "Chronological work observations.", ""];
  if (observations.length === 0) {
    lines.push("No observations.");
    return lines.join("\n");
  }
  observations.forEach((observation, index) => {
    lines.push(
      `## Observation ${index + 1}`,
      `- source: ${escapeMarkdown(observation.source)}`,
      `- role: ${escapeMarkdown(observation.provenance.role)}`,
      `- visit: ${observation.provenance.visit}`,
      `- accepted at: ${escapeMarkdown(observation.provenance.accepted_at)}`,
      `- host directive: ${escapeMarkdown(observation.task.host_directive)}`,
      ...(observation.task.reported_objective === undefined
        ? []
        : [`- reported objective: ${escapeMarkdown(observation.task.reported_objective)}`]),
      ...(observation.task.reported_action === undefined
        ? []
        : [`- reported action: ${escapeMarkdown(observation.task.reported_action)}`]),
      ...(observation.task.reported_context === undefined
        ? []
        : [`- reported context: ${escapeMarkdown(observation.task.reported_context.text)}`]),
      `- terminal (host observed): ${escapeMarkdown(observation.observed.terminal)}`,
      ...(observation.observed.workspace_state === undefined
        ? []
        : [
            `- workspace state (host observed): ${escapeMarkdown(observation.observed.workspace_state)}`,
          ]),
      `- changed paths: ${list(observation.observed.changed_paths)}`,
      `- execution statuses: ${list(observation.observed.executions.map((entry) => entry.status))}`,
      `- artifact labels: ${list(
        observation.observed.artifacts.map((entry) =>
          entry.description === undefined
            ? `${entry.kind}: ${entry.basename}`
            : `${entry.kind}: ${entry.description}`,
        ),
      )}`,
      `- omitted: ${JSON.stringify(observation.omitted)}`,
      `- reported hints: ${escapeMarkdown(JSON.stringify(observation.reported_hints))}`,
      `- ignored optional fields: ${list(observation.ignored_hint_fields ?? [])}`,
      ...(observation.ignored_hint_diagnostics === undefined ||
      observation.ignored_hint_diagnostics.length === 0
        ? []
        : [`- ignored return diagnostics: ${list(observation.ignored_hint_diagnostics)}`]),
      "",
    );
  });
  if (enrichments.length > 0) {
    lines.push("## Jev relevance enrichment", "");
    for (const record of enrichments) {
      lines.push(
        `- recipient: ${escapeMarkdown(record.recipient_role)} visit ${record.recipient_visit}`,
        `- status: ${escapeMarkdown(record.status)}`,
        `- candidates: ${record.candidate_count}`,
        ...(record.failure === undefined
          ? []
          : [
              `- failure: ${escapeMarkdown(record.failure.code)} after ${record.failure.attempts} attempts`,
            ]),
        ...(record.judgments === undefined
          ? []
          : record.judgments.map(
              (judgment) =>
                `- judgment ${escapeMarkdown(judgment.observation_key)}: score ${judgment.score}, certainty ${judgment.ranking_certainty}`,
            )),
        ...(record.usage === undefined
          ? []
          : [
              `- usage: ${record.usage.input_tokens} input, ${record.usage.output_tokens} output tokens`,
            ]),
        "",
      );
    }
  }
  return lines.join("\n");
}

/** V2 deliberately does not nominate OKF knowledge candidates. */
export function renderWorkObservationOkfCandidates(): string {
  return JSON.stringify({ schema_version: 2, candidates: [] }, null, 2);
}

function list(values: readonly string[]): string {
  return values.length === 0 ? "(none)" : values.map(escapeMarkdown).join(", ");
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_[\](){}<>!#|\r\n]/g, (character) => {
    if (character === "\r") return "\\r";
    if (character === "\n") return "\\n";
    return `\\${character}`;
  });
}
