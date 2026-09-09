import { describe, expect, it } from "vitest";
import { validateRpcCompactionUsage } from "../../src/host/isolated-context-retention.js";

const usage = {
  input: 2,
  output: 3,
  cacheRead: 4,
  cacheWrite: 5,
  totalTokens: 14,
  cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
};
const aggregate = {
  input: 2,
  output: 3,
  cache_read: 4,
  cache_write: 5,
  tokens: 14,
  cost: 0.03,
};

describe("isolated context compaction accounting", () => {
  it("normalizes raw SDK usage while accepting the matching aggregate", () => {
    expect(validateRpcCompactionUsage({ usage: aggregate, rawUsages: [usage] })).toEqual([
      aggregate,
    ]);
  });

  it("rejects an aggregate mismatch before any charge can be applied", () => {
    expect(() =>
      validateRpcCompactionUsage({
        usage: { ...aggregate, cost: 0.04 },
        rawUsages: [usage],
      }),
    ).toThrow("aggregate does not match raw usages");
  });

  it("requires unknown aggregate usage when a raw provider observation is unknown", () => {
    expect(() => validateRpcCompactionUsage({ usage: aggregate, rawUsages: [null] })).toThrow(
      "aggregate must be unknown",
    );
    expect(validateRpcCompactionUsage({ usage: null, rawUsages: [null] })).toEqual([null]);
  });

  it("retains known raw subtotals when a later provider observation is unknown", () => {
    expect(validateRpcCompactionUsage({ usage: null, rawUsages: [usage, null] })).toEqual([
      aggregate,
      null,
    ]);
  });
});
