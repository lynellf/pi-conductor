import { describe, expect, it } from "vitest";
import { resolveEffectiveProjection } from "../../src/host/delegation/projection-policy.js";

const policy = { required: true, allowed_paths: ["src"] } as const;

describe("projection authority diagnostics (#107)", () => {
  it.each([
    "docs/Compiler Specification.md",
    "docs/diagnostic-B+C.json",
  ])("identifies the rejected authority entry %s without relaxing selection", (path) => {
    const result = resolveEffectiveProjection(policy, ["src/main.ts"], ["src/main.ts", path]);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("expected invalid authority");
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "projection-authority-unavailable",
        message: expect.stringContaining(JSON.stringify(path)),
      }),
    ]);
    expect(result.errors[0]?.message).toContain("unsafe exact path");
    expect(result.errors[0]?.message).toContain("selectable");
  });

  it("bounds and escapes the first offending filename without dumping the inventory", () => {
    const path = `docs/\n\u001b${"x".repeat(2000)}.md`;
    const result = resolveEffectiveProjection(
      policy,
      ["src/main.ts"],
      ["src/main.ts", path, "docs/second offending filename.md"],
    );
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("expected invalid authority");
    const message = result.errors[0]?.message ?? "";
    expect(message).toContain('"docs/\\n\\u001b');
    expect(message).toContain("truncated");
    expect(message).not.toContain("\n");
    expect(message).not.toContain("\u001b");
    expect(message).not.toContain("second offending filename");
    expect(message.length).toBeLessThan(1200);
  });
});
