import { describe, expect, it } from "vitest";
import type { UsageRecord } from "../../src/core/types.js";
import {
  derivePrewalkForwardBudget,
  EVIDENCED_EXECUTOR_MARGIN_PERCENT,
  evaluatePrewalkGuideBudget,
  evaluatePrewalkGuideCaps,
  measurePrewalkTranscript,
  PREWALK_CONVERGENCE_STEER,
  type PrewalkBudgetError,
} from "../../src/host/prewalk-budget.js";

const zeroUsage: UsageRecord = {
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  tokens: 0,
  cost: 0,
};

describe("Prewalk forward guide budget", () => {
  it("derives exact arithmetic while capping output reservation at executor maxTokens", () => {
    expect(
      derivePrewalkForwardBudget({
        executorContextWindow: 32_000,
        executorMaxTokens: 4_096,
        configuredOutputReservation: 8_192,
        executorEnvelopeTokens: 2_000,
        safetyMarginTokens: 1_000,
      }),
    ).toEqual({
      executor_output_reservation: 4_096,
      guide_transcript_budget_tokens: 24_904,
    });
  });

  it("uses the configured reservation when it is below executor maxTokens", () => {
    expect(
      derivePrewalkForwardBudget({
        executorContextWindow: 32_000,
        executorMaxTokens: 12_000,
        configuredOutputReservation: 6_000,
        executorEnvelopeTokens: 2_000,
        safetyMarginTokens: 1_000,
      }),
    ).toEqual({
      executor_output_reservation: 6_000,
      guide_transcript_budget_tokens: 23_000,
    });
  });

  it.each([
    ["null context window", { executorContextWindow: null }],
    ["non-positive context window", { executorContextWindow: 0 }],
    ["invalid max tokens", { executorMaxTokens: Number.NaN }],
    ["negative envelope", { executorEnvelopeTokens: -1 }],
    ["invalid safety margin", { safetyMarginTokens: Number.POSITIVE_INFINITY }],
  ] as const)("fails closed for %s", (_name, override) => {
    expect(() =>
      derivePrewalkForwardBudget({
        executorContextWindow: 32_000,
        executorMaxTokens: 4_096,
        configuredOutputReservation: 8_192,
        executorEnvelopeTokens: 2_000,
        safetyMarginTokens: 1_000,
        ...override,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<PrewalkBudgetError>>({
        code: "prewalk_context_metadata_unknown",
      }),
    );
  });

  it("rejects a non-positive derived budget", () => {
    expect(() =>
      derivePrewalkForwardBudget({
        executorContextWindow: 10_000,
        executorMaxTokens: 8_000,
        configuredOutputReservation: 8_000,
        executorEnvelopeTokens: 1_000,
        safetyMarginTokens: 1_000,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<PrewalkBudgetError>>({
        code: "prewalk_budget_unsatisfiable",
      }),
    );
  });
});

describe("executor-targeted transcript measurement", () => {
  it("counts the injected transformed payload and applies the evidenced 26% margin", () => {
    const transformed = [{ role: "user", content: "executor-visible" }];
    let observed: unknown;

    const measured = measurePrewalkTranscript({
      executorPayload: transformed,
      counterKind: "estimate",
      countExecutorTokens: (payload) => {
        observed = payload;
        return 100;
      },
      calibratedMarginPercent: EVIDENCED_EXECUTOR_MARGIN_PERCENT,
      guideContextMetadata: { tokens: 9_999, hasCompaction: false },
    });

    expect(observed).toBe(transformed);
    expect(measured).toEqual({ raw_tokens: 100, margin_percent: 26, admitted_tokens: 126 });
  });

  it("counts an injected projection payload without consulting guide context usage", () => {
    const projection = "bounded projection";
    const measured = measurePrewalkTranscript({
      executorPayload: projection,
      counterKind: "estimate",
      countExecutorTokens: (payload) => (payload === projection ? 80 : 1_000_000),
      calibratedMarginPercent: 26,
      guideContextMetadata: { tokens: 1_000_000, hasCompaction: false },
    });

    expect(measured.admitted_tokens).toBe(101);
  });

  it("permits an exact provider counter without an estimation margin", () => {
    expect(
      measurePrewalkTranscript({
        executorPayload: [],
        counterKind: "provider",
        countExecutorTokens: () => 80,
        calibratedMarginPercent: null,
        guideContextMetadata: { tokens: 1, hasCompaction: false },
      }),
    ).toEqual({ raw_tokens: 80, margin_percent: 0, admitted_tokens: 80 });
  });

  it.each([
    ["null context tokens", { tokens: null, hasCompaction: false }],
    ["undefined context tokens", { tokens: undefined, hasCompaction: false }],
    ["negative context tokens", { tokens: -1, hasCompaction: false }],
    ["compacted history", { tokens: 1, hasCompaction: true }],
  ] as const)("fails closed on %s", (_name, guideContextMetadata) => {
    expect(() =>
      measurePrewalkTranscript({
        executorPayload: [],
        counterKind: "estimate",
        countExecutorTokens: () => 10,
        calibratedMarginPercent: 26,
        guideContextMetadata,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<PrewalkBudgetError>>({ code: "prewalk_context_unknown" }),
    );
  });

  it.each([
    Number.NaN,
    -1,
    Number.POSITIVE_INFINITY,
  ])("fails closed when the injected counter returns %s", (count) => {
    expect(() =>
      measurePrewalkTranscript({
        executorPayload: [],
        counterKind: "estimate",
        countExecutorTokens: () => count,
        calibratedMarginPercent: 26,
        guideContextMetadata: { tokens: 1, hasCompaction: false },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<PrewalkBudgetError>>({ code: "prewalk_context_unknown" }),
    );
  });

  it("rejects an unavailable or out-of-policy calibrated margin", () => {
    expect(() =>
      measurePrewalkTranscript({
        executorPayload: [],
        counterKind: "estimate",
        countExecutorTokens: () => 10,
        calibratedMarginPercent: null,
        guideContextMetadata: { tokens: 1, hasCompaction: false },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<PrewalkBudgetError>>({
        code: "prewalk_context_metadata_unknown",
      }),
    );
    expect(() =>
      measurePrewalkTranscript({
        executorPayload: [],
        counterKind: "estimate",
        countExecutorTokens: () => 10,
        calibratedMarginPercent: 36,
        guideContextMetadata: { tokens: 1, hasCompaction: false },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<PrewalkBudgetError>>({
        code: "prewalk_context_metadata_unknown",
      }),
    );
  });
});

describe("guide budget enforcement boundaries", () => {
  it.each([
    [74, false, "none"],
    [75, false, "converge"],
    [99, true, "none"],
    [100, true, "force_projection"],
    [125, true, "force_projection"],
  ] as const)("at %s%% with warned=%s returns %s", (percent, warningIssued, actionType) => {
    const state = Object.freeze({ warningIssued });
    const result = evaluatePrewalkGuideBudget({
      budgetTokens: 100,
      consumedTokens: percent,
      state,
    });

    expect(result.action.type).toBe(actionType);
    expect(state).toEqual({ warningIssued });
    if (actionType === "force_projection") {
      expect(result.action).toEqual({
        type: "force_projection",
        code: "prewalk_guide_budget_exceeded",
        preserve_guide_work: true,
      });
    }
  });

  it("emits the exact convergence action once at and above 75%", () => {
    const first = evaluatePrewalkGuideBudget({
      budgetTokens: 100,
      consumedTokens: 75,
      state: { warningIssued: false },
    });
    const repeated = evaluatePrewalkGuideBudget({
      budgetTokens: 100,
      consumedTokens: 76,
      state: first.state,
    });

    expect(first.action).toEqual({ type: "converge", message: PREWALK_CONVERGENCE_STEER });
    expect(first.state).toEqual({ warningIssued: true });
    expect(repeated.action).toEqual({ type: "none" });
  });

  it("prioritizes forced projection when consumption first jumps to 100%", () => {
    const result = evaluatePrewalkGuideBudget({
      budgetTokens: 100,
      consumedTokens: 100,
      state: { warningIssued: false },
    });

    expect(result.action.type).toBe("force_projection");
    expect(result.state).toEqual({ warningIssued: true });
  });
});

describe("guide-only cost and exact turn caps", () => {
  it("surfaces the guide cost-cap code at the exact cumulative boundary", () => {
    expect(
      evaluatePrewalkGuideCaps({
        guideUsage: { ...zeroUsage, cost: 2.5 },
        guideMaxCostUsd: 2.5,
        completedGuideTurns: 1,
        guideMaxTurns: 12,
      }),
    ).toEqual({ type: "fail", code: "prewalk_guide_cost_cap_exceeded" });
  });

  it("does not include executor or role-session cost in the guide-only input", () => {
    const guideUsage = Object.freeze({ ...zeroUsage, cost: 2.49 });
    expect(
      evaluatePrewalkGuideCaps({
        guideUsage,
        guideMaxCostUsd: 2.5,
        completedGuideTurns: 11,
        guideMaxTurns: 12,
      }),
    ).toEqual({ type: "none" });
    expect(guideUsage).toEqual({ ...zeroUsage, cost: 2.49 });
  });

  it("surfaces the turn-cap code at the exact completed-turn boundary", () => {
    expect(
      evaluatePrewalkGuideCaps({
        guideUsage: zeroUsage,
        guideMaxCostUsd: 2.5,
        completedGuideTurns: 12,
        guideMaxTurns: 12,
      }),
    ).toEqual({ type: "fail", code: "prewalk_guide_turn_cap_exceeded" });
  });

  it("uses deterministic cost-before-turn precedence when both caps are reached", () => {
    expect(
      evaluatePrewalkGuideCaps({
        guideUsage: { ...zeroUsage, cost: 2.5 },
        guideMaxCostUsd: 2.5,
        completedGuideTurns: 12,
        guideMaxTurns: 12,
      }),
    ).toEqual({ type: "fail", code: "prewalk_guide_cost_cap_exceeded" });
  });
});
