import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type ChildSubreaperBindings,
  ensureChildSubreaper,
  evaluateChildSubreaper,
} from "../../src/host/execution/child-subreaper.js";

describe("evaluateChildSubreaper", () => {
  const cases: readonly {
    readonly name: string;
    readonly bindings: ChildSubreaperBindings | undefined;
    readonly available: boolean;
    readonly active: boolean;
  }[] = [
    {
      name: "reports inactive when the bindings are unavailable",
      bindings: undefined,
      available: false,
      active: false,
    },
    {
      name: "reports inactive when PR_SET_CHILD_SUBREAPER fails",
      bindings: { setChildSubreaper: () => 1, getChildSubreaper: () => -1 },
      available: true,
      active: false,
    },
    {
      name: "reports inactive when verification does not confirm the claim",
      bindings: { setChildSubreaper: () => 0, getChildSubreaper: () => 0 },
      available: true,
      active: false,
    },
    {
      name: "reports active when the claim is set and verified",
      bindings: { setChildSubreaper: () => 0, getChildSubreaper: () => 1 },
      available: true,
      active: true,
    },
  ];
  for (const { name, bindings, available, active } of cases) {
    it(name, () => {
      const state = evaluateChildSubreaper(bindings);
      expect(state.available).toBe(available);
      expect(state.active).toBe(active);
      expect(state.detail.length).toBeGreaterThan(0);
    });
  }
});

const addonPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "dist",
  "native",
  "child-subreaper.node",
);

describe.skipIf(!existsSync(addonPath))("real child-subreaper addon", () => {
  it("equips and verifies the host process", () => {
    expect(ensureChildSubreaper()).toMatchObject({ available: true, active: true });
  });
});
