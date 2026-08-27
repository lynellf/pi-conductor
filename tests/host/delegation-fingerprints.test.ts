import { describe, expect, it } from "vitest";

import { projectionFingerprint, taskFingerprint } from "../../src/host/delegation/fingerprints.js";

describe("delegated-child cohort fingerprints (Issue #57 §9.1)", () => {
  it("changes task identity when any task-matching input changes", () => {
    const baseline = taskFingerprint("goal", "output", "base", ["src/a.ts", "tests/a.ts"]);
    expect(taskFingerprint("other goal", "output", "base", ["src/a.ts", "tests/a.ts"])).not.toBe(
      baseline,
    );
    expect(taskFingerprint("goal", "output", "other-base", ["src/a.ts", "tests/a.ts"])).not.toBe(
      baseline,
    );
    expect(taskFingerprint("goal", "output", "base", ["src/b.ts"])).not.toBe(baseline);
  });

  it("canonicalizes projection path ordering without retaining a raw task card", () => {
    expect(projectionFingerprint("exact", ["tests/a.ts", "src/a.ts"])).toEqual(
      projectionFingerprint("exact", ["src/a.ts", "tests/a.ts"]),
    );
  });
});
