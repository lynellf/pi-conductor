import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  CONTROLLER_PATCH_MEDIA_TYPE,
  controllerOutputPolicySchema,
  parseControllerChildOutputPolicy,
  validateControllerChildOutputPolicies,
} from "../../src/manifest/controller-output.js";

const principal = { kind: "controller" } as const;
const report = (overrides: Record<string, unknown> = {}) => ({
  id: "report",
  path: "reports/result.json",
  media_type: "application/json",
  max_bytes: 100,
  consumers: [principal],
  ...overrides,
});
const valid = {
  profile_id: "worker",
  reports: [report()],
};

describe("controller output policy", () => {
  it("accepts and freezes a bounded report and optional patch policy", () => {
    const policy = parseControllerChildOutputPolicy({
      profile_id: "worker",
      reports: [report(), report({ id: "notes", path: "notes.md", media_type: "text/markdown" })],
      patch: {
        id: "patch",
        paths: ["src/change.ts", "tests/change.test.ts"],
        max_bytes: 500,
        consumers: [{ kind: "native", profile_id: "reviewer" }],
      },
    });

    expect(policy.patch).toEqual({
      id: "patch",
      paths: ["src/change.ts", "tests/change.test.ts"],
      max_bytes: 500,
      consumers: [{ kind: "native", profile_id: "reviewer" }],
    });
    expect(CONTROLLER_PATCH_MEDIA_TYPE).toBe("application/x-git-patch");
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.reports)).toBe(true);
  });

  it("accepts all closed principal variants", () => {
    expect(
      Value.Check(controllerOutputPolicySchema, {
        ...valid,
        reports: [
          report({
            consumers: [
              { kind: "controller" },
              { kind: "native", profile_id: "native" },
              { kind: "adapter", adapter_id: "adapter" },
              { kind: "effect", effect_id: "effect" },
            ],
          }),
        ],
      }),
    ).toBe(true);
  });

  it("accepts a patch-only policy", () => {
    expect(
      parseControllerChildOutputPolicy({
        profile_id: "worker",
        reports: [],
        patch: {
          id: "patch",
          paths: ["src/change.ts"],
          max_bytes: 1,
          consumers: [principal],
        },
      }).reports,
    ).toEqual([]);
  });

  it.each([
    ["unknown policy key", { ...valid, extra: true }],
    ["empty policy without patch", { ...valid, reports: [] }],
    [
      "too many reports",
      { ...valid, reports: Array.from({ length: 16 }, (_, i) => report({ id: `r${i}` })) },
    ],
    ["report bytes below minimum", { ...valid, reports: [report({ max_bytes: 0 })] }],
    [
      "patch bytes above maximum",
      { ...valid, patch: { id: "p", paths: ["a"], max_bytes: 524289, consumers: [principal] } },
    ],
    [
      "total bytes above maximum",
      {
        ...valid,
        reports: [report({ max_bytes: 131072 }), report({ id: "r2", max_bytes: 131072 })],
        patch: { id: "p", paths: ["a"], max_bytes: 786433, consumers: [principal] },
      },
    ],
    [
      "duplicate output ids",
      { ...valid, reports: [report(), report({ id: "report", path: "other" })] },
    ],
    ["duplicate report paths", { ...valid, reports: [report(), report({ id: "second" })] }],
    ["unsafe path", { ...valid, reports: [report({ path: "../secret" })] }],
    [
      "empty patch paths",
      { ...valid, patch: { id: "p", paths: [], max_bytes: 1, consumers: [principal] } },
    ],
    ["duplicate consumers", { ...valid, reports: [report({ consumers: [principal, principal] })] }],
    ["empty consumers", { ...valid, reports: [report({ consumers: [] })] }],
    [
      "unknown principal key",
      { ...valid, reports: [report({ consumers: [{ kind: "controller", extra: true }] })] },
    ],
  ] as const)("rejects %s", (_name, candidate) => {
    expect(validateControllerChildOutputPolicies([candidate]).length).toBeGreaterThan(0);
    expect(() => parseControllerChildOutputPolicy(candidate)).toThrow();
  });
});
