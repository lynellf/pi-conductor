/**
 * Pure advisory logic for the Jev assessment layer — issue #139 Jev
 * comment (authority boundary + gate policy).
 *
 * - `inspectionRecommended` is the single documented heuristic that
 *   turns low-confidence / contradicted / unavailable assessments
 *   into an explicit inspection recommendation. It is text for the
 *   recipient role, never a machine blocker: nothing in the loop
 *   branches on it.
 * - `renderJevAdvisory` renders a terminal record as a separately
 *   labelled `### jev_advisory` seed section. The section carries an
 *   authority disclaimer, never prints verdict/approval language,
 *   and never claims a host check outcome.
 *
 * Dependency-free so tests never touch I/O. Separated from
 * `prepare.ts` (replay-or-attempt orchestration) per the module-size
 * ceiling; the authority boundary stays auditable across exactly two
 * small modules.
 */

import type {
  JevAssessmentJudgments,
  JevAssessmentRecord,
} from "../../persistence/jev-assessment-record.js";

/** Documented heuristic bounds (comment §Gate policy; heuristic, not enforcement). */
export const JEV_CONTRADICTION_MIN_CONFIDENCE = 0.5;
export const JEV_ACTIONABLE_LOW_NOUL = 0.35;
export const JEV_LOW_CONFIDENCE = 0.4;
export const JEV_NOUL_UNCERTAIN_LOW = 0.4;
export const JEV_NOUL_UNCERTAIN_HIGH = 0.6;

export interface InspectionRecommendation {
  readonly recommended: boolean;
  readonly reasons: readonly string[];
}

/**
 * Decide whether the recipient should inspect before proceeding.
 * Pure over a completed judgment set or an unavailable status. Low
 * confidence, contradiction, and unavailability recommend inspection;
 * a clear assessment does not. Never a routing input.
 */
export function inspectionRecommended(
  input:
    | { readonly status: "unavailable"; readonly code: string }
    | { readonly status: "completed"; readonly judgments: JevAssessmentJudgments },
): InspectionRecommendation {
  if (input.status === "unavailable") {
    return {
      recommended: true,
      reasons: [
        `assessment unavailable (${input.code}); the host packet alone governs — inspect before acting on the reported narrative`,
      ],
    };
  }
  const reasons: string[] = [];
  const { judgments } = input;
  if (
    judgments.consistency.choice === "contradicted" &&
    judgments.consistency.confidence >= JEV_CONTRADICTION_MIN_CONFIDENCE
  ) {
    reasons.push(
      `reported reason contradicts host-observed evidence (confidence ${formatConfidence(judgments.consistency.confidence)})`,
    );
  }
  if (judgments.actionable.noul <= JEV_ACTIONABLE_LOW_NOUL) {
    reasons.push(
      `handoff likely has a concrete missing item (actionable ${formatNoul(judgments.actionable.noul)})`,
    );
  }
  const confidences = [
    judgments.relevance.confidence,
    judgments.consistency.confidence,
    judgments.next_action.confidence,
  ];
  const minimum = Math.min(...confidences);
  if (minimum < JEV_LOW_CONFIDENCE) {
    reasons.push(
      `low assessment confidence (minimum ${formatConfidence(minimum)}); treat judgments as uncertain`,
    );
  }
  return { recommended: reasons.length > 0, reasons };
}

function formatConfidence(value: number): string {
  return value.toFixed(2);
}

function formatNoul(value: number): string {
  return value.toFixed(2);
}

/**
 * Render a terminal assessment as the advisory seed section. Pure over
 * the record: resume replays byte-identically because the record is
 * immutable. The disclaimer is structural — no caller can render
 * judgments without it.
 */
export function renderJevAdvisory(record: JevAssessmentRecord): string {
  const lines: string[] = [];
  lines.push("### jev_advisory");
  lines.push(
    "advisory inference — not evidence, not approval. Host packet facts govern; reported narrative stays untrusted.",
  );
  if (record.status === "unavailable" || record.judgments === undefined) {
    const code =
      record.status === "unavailable" && record.failure !== undefined
        ? record.failure.code
        : "unknown";
    lines.push(
      `status: unavailable (${code}); no advisory judgments — proceed on the host packet alone.`,
    );
    return lines.join("\n");
  }
  const judgments = record.judgments;
  lines.push(
    `relevance: ${judgments.relevance.choice} (confidence ${formatConfidence(judgments.relevance.confidence)})`,
  );
  lines.push(
    `consistency: ${judgments.consistency.choice} (confidence ${formatConfidence(judgments.consistency.confidence)})`,
  );
  const noul = judgments.actionable.noul;
  const uncertain =
    noul >= JEV_NOUL_UNCERTAIN_LOW && noul <= JEV_NOUL_UNCERTAIN_HIGH
      ? " (uncertain — similar probability for yes and no)"
      : "";
  lines.push(`actionable: ${formatNoul(noul)}${uncertain}`);
  lines.push(
    `recommended_next_action: ${judgments.next_action.choice} (confidence ${formatConfidence(judgments.next_action.confidence)})`,
  );
  const recommendation = inspectionRecommended({ status: "completed", judgments });
  if (recommendation.recommended) {
    lines.push(`recommendation: inspection recommended — ${recommendation.reasons.join("; ")}`);
  }
  return lines.join("\n");
}
