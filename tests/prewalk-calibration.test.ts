import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

interface CalibrationRow {
  readonly executor_model: string;
  readonly guide: "sol" | "terra" | "luna";
  readonly requested_tokens: number;
  readonly estimate_tokens: number;
  readonly sdk_context_tokens: number;
  readonly transcript_input_tokens: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly ttft_ms: number;
  readonly purpose: "calibration" | "calibration+prefill";
}

interface MarginRow {
  readonly executor_family: string;
  readonly sample_count: number;
  readonly estimate_p95_relative_error: number;
  readonly estimate_p95_required_margin: number;
  readonly sdk_context_p95_relative_error: number;
  readonly selected_margin: number;
  readonly requires_real_count: boolean;
}

interface Evidence {
  readonly rows: readonly CalibrationRow[];
  readonly margin_table: readonly MarginRow[];
  readonly latency_budgets_ms: Readonly<Record<string, number>>;
}

const evidencePath = fileURLToPath(
  new URL("./fixtures/prewalk/calibration-evidence.json", import.meta.url),
);
const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as Evidence;

function p95(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const value = ordered[Math.ceil(ordered.length * 0.95) - 1];
  if (value === undefined) throw new Error("p95 requires evidence");
  return value;
}

describe("Slice 0 executor tokenizer calibration", () => {
  for (const margin of evidence.margin_table) {
    it(`${margin.executor_family} commits its measured p95 and safe margin`, () => {
      const rows = evidence.rows.filter((row) => row.executor_model === margin.executor_family);
      const relativeErrors = rows.map(
        (row) =>
          Math.abs(row.estimate_tokens - row.transcript_input_tokens) / row.transcript_input_tokens,
      );
      const requiredMargins = rows.map((row) =>
        Math.max(0, row.transcript_input_tokens / row.estimate_tokens - 1),
      );
      const contextErrors = rows.map(
        (row) =>
          Math.abs(row.sdk_context_tokens - row.transcript_input_tokens) /
          row.transcript_input_tokens,
      );

      expect(rows).toHaveLength(10);
      expect(Number(p95(relativeErrors).toFixed(4))).toBe(margin.estimate_p95_relative_error);
      expect(Number(p95(requiredMargins).toFixed(4))).toBe(margin.estimate_p95_required_margin);
      expect(Number(p95(contextErrors).toFixed(4))).toBe(margin.sdk_context_p95_relative_error);
      expect(margin.selected_margin).toBeGreaterThanOrEqual(margin.estimate_p95_required_margin);
      expect(margin.requires_real_count).toBe(margin.estimate_p95_relative_error > 0.15);
    });
  }

  it("has a passed live validity probe for all six guide/executor pairs", () => {
    const pairs = new Set(evidence.rows.map((row) => `${row.guide}->${row.executor_model}`));

    expect(pairs).toEqual(
      new Set([
        "sol->Qwen3.8-27B-oQ4e-mtp",
        "terra->Qwen3.8-27B-oQ4e-mtp",
        "luna->Qwen3.8-27B-oQ4e-mtp",
        "sol->Tiel-Coder-35B-A3B-MLX-oQ4e",
        "terra->Tiel-Coder-35B-A3B-MLX-oQ4e",
        "luna->Tiel-Coder-35B-A3B-MLX-oQ4e",
      ]),
    );
  });

  for (const model of ["Qwen3.8-27B-oQ4e-mtp", "Tiel-Coder-35B-A3B-MLX-oQ4e"]) {
    for (const requested of [10_000, 25_000, 50_000]) {
      it(`${model} stays within the warm-server TTFT budget at ~${requested} tokens`, () => {
        const row = evidence.rows.find(
          (candidate) =>
            candidate.executor_model === model && candidate.requested_tokens === requested,
        );
        if (!row) throw new Error("missing prefill evidence row");
        const budget = evidence.latency_budgets_ms[String(requested)];
        if (budget === undefined) throw new Error("missing latency budget");

        expect(row.purpose).toBe("calibration+prefill");
        expect(row.output_tokens).toBeLessThanOrEqual(1);
        expect(row.ttft_ms).toBeLessThan(budget);
      });
    }
  }
});
