/** Pure forward-budget measurement and guide-phase limit decisions (Prewalk §R6, §R8). */

import type { UsageRecord } from "../core/types.js";
import { sessionCapExceeded } from "../cost/caps.js";
import { deriveGuideTranscriptBudget } from "../manifest/prewalk.js";

/** P1's rounded one-sided margin for the currently evidenced Qwen/Tiel families. */
export const EVIDENCED_EXECUTOR_MARGIN_PERCENT = 26;

/** Exact one-time steer injected when the guide reaches 75% of its budget. */
export const PREWALK_CONVERGENCE_STEER =
  "Converge and checkpoint now: the guide transcript has reached 75% of its executor-targeted budget.";

type PrewalkBudgetErrorCode =
  | "prewalk_context_metadata_unknown"
  | "prewalk_context_unknown"
  | "prewalk_budget_unsatisfiable";

/** Stable fail-closed budget error for invalid runtime metadata or arithmetic. */
export class PrewalkBudgetError extends Error {
  readonly code: PrewalkBudgetErrorCode;

  constructor(code: PrewalkBudgetErrorCode, message: string) {
    super(message);
    this.name = "PrewalkBudgetError";
    this.code = code;
  }
}

export interface PrewalkForwardBudgetInput {
  readonly executorContextWindow: number | null | undefined;
  readonly executorMaxTokens: number | null | undefined;
  readonly configuredOutputReservation: number;
  readonly executorEnvelopeTokens: number | null | undefined;
  readonly safetyMarginTokens: number | null | undefined;
}

export interface PrewalkForwardBudget {
  readonly executor_output_reservation: number;
  readonly guide_transcript_budget_tokens: number;
}

/** Derive the numerical guide budget using the manifest's single arithmetic owner. */
export function derivePrewalkForwardBudget(input: PrewalkForwardBudgetInput): PrewalkForwardBudget {
  if (
    !positiveIntegerValue(input.executorContextWindow) ||
    !nonNegativeIntegerValue(input.executorMaxTokens) ||
    !positiveIntegerValue(input.configuredOutputReservation) ||
    !nonNegativeIntegerValue(input.executorEnvelopeTokens) ||
    !nonNegativeIntegerValue(input.safetyMarginTokens)
  ) {
    throw new PrewalkBudgetError(
      "prewalk_context_metadata_unknown",
      "Prewalk requires finite executor context, output, envelope, reservation, and safety metadata.",
    );
  }
  const executorOutputReservation = Math.min(
    input.executorMaxTokens,
    input.configuredOutputReservation,
  );
  const budget = deriveGuideTranscriptBudget(
    { executor_output_reservation: input.configuredOutputReservation },
    {
      executor_context_window: input.executorContextWindow,
      executor_max_tokens: input.executorMaxTokens,
      executor_envelope_tokens: input.executorEnvelopeTokens,
      safety_margin_tokens: input.safetyMarginTokens,
      workspace_is_git_repository: true,
    },
  );
  if (!positiveFinite(budget)) {
    throw new PrewalkBudgetError(
      "prewalk_budget_unsatisfiable",
      `Prewalk derived guide transcript budget ${String(budget)}; expected a finite value above zero.`,
    );
  }
  return Object.freeze({
    executor_output_reservation: executorOutputReservation,
    guide_transcript_budget_tokens: budget,
  });
}

export interface GuideContextMetadata {
  /** Integrity sentinel only; never used as executor-targeted consumption. */
  readonly tokens: number | null | undefined;
  readonly hasCompaction: boolean;
}

export interface PrewalkTranscriptMeasurement {
  readonly raw_tokens: number;
  readonly margin_percent: number;
  readonly admitted_tokens: number;
}

/** Count transformed/projection payload through an injected executor counter and calibrated margin. */
export function measurePrewalkTranscript<T>(input: {
  readonly executorPayload: T;
  readonly counterKind: "provider" | "tokenizer" | "estimate";
  readonly countExecutorTokens: (payload: T) => number;
  readonly calibratedMarginPercent: number | null | undefined;
  readonly guideContextMetadata: GuideContextMetadata;
}): PrewalkTranscriptMeasurement {
  const metadataTokens = input.guideContextMetadata.tokens;
  if (
    input.guideContextMetadata.hasCompaction !== false ||
    !nonNegativeIntegerValue(metadataTokens)
  ) {
    throw new PrewalkBudgetError(
      "prewalk_context_unknown",
      "Prewalk guide context metadata is null, invalid, or compacted.",
    );
  }
  const margin = input.calibratedMarginPercent ?? 0;
  if (
    !nonNegativeFinite(margin) ||
    margin > 35 ||
    (input.counterKind === "estimate" && margin === 0) ||
    (input.counterKind !== "provider" &&
      input.counterKind !== "tokenizer" &&
      input.counterKind !== "estimate")
  ) {
    throw new PrewalkBudgetError(
      "prewalk_context_metadata_unknown",
      "Prewalk estimates require a calibrated margin above 0% and at most 35%; exact counters may use 0%.",
    );
  }
  const rawTokens = input.countExecutorTokens(input.executorPayload);
  if (!nonNegativeIntegerValue(rawTokens)) {
    throw new PrewalkBudgetError(
      "prewalk_context_unknown",
      "The injected executor token counter returned an invalid value.",
    );
  }
  const admittedTokens = Math.ceil(rawTokens * (1 + margin / 100));
  if (!nonNegativeFinite(admittedTokens)) {
    throw new PrewalkBudgetError(
      "prewalk_context_unknown",
      "Executor-targeted transcript accounting was not finite.",
    );
  }
  return Object.freeze({
    raw_tokens: rawTokens,
    margin_percent: margin,
    admitted_tokens: admittedTokens,
  });
}

export interface PrewalkGuideBudgetState {
  readonly warningIssued: boolean;
}

export type PrewalkGuideBudgetAction =
  | { readonly type: "none" }
  | { readonly type: "converge"; readonly message: string }
  | {
      readonly type: "force_projection";
      readonly code: "prewalk_guide_budget_exceeded";
      readonly preserve_guide_work: true;
    };

/** Return one deterministic action at the 75% and 100% guide-budget boundaries. */
export function evaluatePrewalkGuideBudget(input: {
  readonly budgetTokens: number;
  readonly consumedTokens: number;
  readonly state: PrewalkGuideBudgetState;
}): { readonly state: PrewalkGuideBudgetState; readonly action: PrewalkGuideBudgetAction } {
  if (
    !positiveIntegerValue(input.budgetTokens) ||
    !nonNegativeIntegerValue(input.consumedTokens) ||
    typeof input.state.warningIssued !== "boolean"
  ) {
    throw new PrewalkBudgetError(
      "prewalk_context_unknown",
      "Prewalk guide budget enforcement requires finite non-negative consumption and state.",
    );
  }
  if (input.consumedTokens >= input.budgetTokens) {
    return frozenDecision(true, {
      type: "force_projection",
      code: "prewalk_guide_budget_exceeded",
      preserve_guide_work: true,
    });
  }
  if (!input.state.warningIssued && input.consumedTokens * 4 >= input.budgetTokens * 3) {
    return frozenDecision(true, { type: "converge", message: PREWALK_CONVERGENCE_STEER });
  }
  return frozenDecision(input.state.warningIssued, { type: "none" });
}

export type PrewalkGuideCapAction =
  | { readonly type: "none" }
  | {
      readonly type: "fail";
      readonly code: "prewalk_guide_cost_cap_exceeded" | "prewalk_guide_turn_cap_exceeded";
    };

/** Evaluate guide-only cumulative cost first, then the exact completed-turn cap. */
export function evaluatePrewalkGuideCaps(input: {
  readonly guideUsage: UsageRecord;
  readonly guideMaxCostUsd: number;
  readonly completedGuideTurns: number;
  readonly guideMaxTurns: number;
}): PrewalkGuideCapAction {
  if (
    !validUsage(input.guideUsage) ||
    !positiveFinite(input.guideMaxCostUsd) ||
    !nonNegativeInteger(input.completedGuideTurns) ||
    !positiveInteger(input.guideMaxTurns)
  ) {
    throw new PrewalkBudgetError(
      "prewalk_context_metadata_unknown",
      "Prewalk guide cap evaluation received invalid usage or limit metadata.",
    );
  }
  if (sessionCapExceeded({ ...input.guideUsage, sessions: 0 }, input.guideMaxCostUsd)) {
    return Object.freeze({ type: "fail", code: "prewalk_guide_cost_cap_exceeded" });
  }
  if (input.completedGuideTurns >= input.guideMaxTurns) {
    return Object.freeze({ type: "fail", code: "prewalk_guide_turn_cap_exceeded" });
  }
  return Object.freeze({ type: "none" });
}

function frozenDecision(
  warningIssued: boolean,
  action: PrewalkGuideBudgetAction,
): { readonly state: PrewalkGuideBudgetState; readonly action: PrewalkGuideBudgetAction } {
  return Object.freeze({
    state: Object.freeze({ warningIssued }),
    action: Object.freeze(action),
  });
}

function validUsage(usage: UsageRecord): boolean {
  return (
    nonNegativeFinite(usage.input) &&
    nonNegativeFinite(usage.output) &&
    nonNegativeFinite(usage.cache_read) &&
    nonNegativeFinite(usage.cache_write) &&
    nonNegativeFinite(usage.tokens) &&
    nonNegativeFinite(usage.cost)
  );
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function nonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function positiveIntegerValue(value: unknown): value is number {
  return typeof value === "number" && positiveInteger(value);
}

function nonNegativeIntegerValue(value: unknown): value is number {
  return typeof value === "number" && nonNegativeInteger(value);
}
