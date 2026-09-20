import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { delegateTaskSchema, verifyArgsSchema } from "../../src/seam/schema.js";

// Closed set of supported child tool names per docs/delegated-verification/spec.md §3.4.
// Use bare names (e.g. "read"), NOT namespaced forms (e.g. "file:read" / "sandbox:bash").
const SUPPORTED_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "edit",
  "write",
  "bash",
  "read_execution_output",
  "verify",
] as const;

// Baseline delegate-task payload. The existing delegateTaskSchema requires id /
// subagent / objective / expected_output. Optional projection_paths and
// context_artifacts are also part of the legacy surface.
const baselineTask = {
  id: "task-001",
  subagent: "implementer",
  objective: "implement the delegated-verification schema contract",
  expected_output:
    "schema.ts exports verifyArgsSchema and a delegateTaskSchema with tools + verification_recipe",
};

describe("delegated-verification schema contracts (P1 RED)", () => {
  describe("§5.2 verifyArgsSchema", () => {
    it("accepts an empty object as the only valid value", () => {
      expect(Value.Check(verifyArgsSchema, {})).toBe(true);
    });

    it.each<[string, unknown]>([
      ["non-empty string", "verify"],
      ["empty string", ""],
      ["number", 1],
      ["boolean", false],
      ["null", null],
      ["array (even empty)", []],
      ["non-empty object", { verify: true }],
    ])("rejects non-empty / non-object value: %s", (_label, value) => {
      expect(Value.Check(verifyArgsSchema, value)).toBe(false);
    });

    it("is structurally Type.Object({}, { additionalProperties: false })", () => {
      expect(verifyArgsSchema).toEqual(
        expect.objectContaining({
          type: "object",
          properties: {},
          additionalProperties: false,
        }),
      );
    });
  });

  describe("§3.4 delegateTaskSchema — legacy surface (must keep passing)", () => {
    it("accepts the legacy baseline shape (id, subagent, objective, expected_output)", () => {
      expect(Value.Check(delegateTaskSchema, baselineTask)).toBe(true);
    });

    it("accepts the legacy shape with optional projection_paths and context_artifacts", () => {
      const task = {
        ...baselineTask,
        projection_paths: ["src/seam/schema.ts"],
        context_artifacts: [
          {
            id: "ref-1",
            source: "file" as const,
            path: "docs/delegated-verification/spec.md",
          },
        ],
      };
      expect(Value.Check(delegateTaskSchema, task)).toBe(true);
    });
  });

  describe("§3.4 delegateTaskSchema — optional `tools` field", () => {
    it("accepts a single closed-set tool name", () => {
      const task = { ...baselineTask, tools: ["read"] };
      expect(Value.Check(delegateTaskSchema, task)).toBe(true);
    });

    it("accepts multiple closed-set tool names, sorted and deduped", () => {
      const task = { ...baselineTask, tools: ["bash", "read", "verify"] };
      expect(Value.Check(delegateTaskSchema, task)).toBe(true);
    });

    it("accepts the full closed-set (9 entries, sorted, deduped)", () => {
      const task = { ...baselineTask, tools: [...SUPPORTED_TOOLS] };
      expect(Value.Check(delegateTaskSchema, task)).toBe(true);
    });

    it.each<[string, unknown[]]>([
      ["empty array", []],
      ["duplicate tools", ["read", "read"]],
      ["unsupported tool name (namespaced)", ["file:read"]],
      ["unsupported tool name (unknown)", ["unknown_tool"]],
      ["non-string entry", ["read", 123]],
      ["empty-string entry", [""]],
      ["entry exceeding maxLength 64", ["x".repeat(65)]],
    ])("rejects malformed tools array: %s", (_label, tools) => {
      const task = { ...baselineTask, tools };
      expect(Value.Check(delegateTaskSchema, task)).toBe(false);
    });

    it("rejects oversize tools array (>16 entries)", () => {
      const tools = Array.from({ length: 17 }, () => "read");
      const task = { ...baselineTask, tools };
      expect(Value.Check(delegateTaskSchema, task)).toBe(false);
    });

    it("rejects tools array of size 16 when entries are not closed-set names", () => {
      const tools = Array.from({ length: 16 }, () => "not_a_tool");
      const task = { ...baselineTask, tools };
      expect(Value.Check(delegateTaskSchema, task)).toBe(false);
    });
  });

  describe("§3.4 delegateTaskSchema — optional `verification_recipe` field", () => {
    it("accepts an identifier-like string", () => {
      const task = { ...baselineTask, verification_recipe: "default" };
      expect(Value.Check(delegateTaskSchema, task)).toBe(true);
    });

    it("accepts verification_recipe at the maxLength=64 boundary", () => {
      const task = { ...baselineTask, verification_recipe: "a".repeat(64) };
      expect(Value.Check(delegateTaskSchema, task)).toBe(true);
    });

    it.each<[string, unknown]>([
      ["empty string", ""],
      ["non-string (number)", 123],
      ["non-string (boolean)", true],
      ["non-string (null)", null],
      ["non-string (array)", []],
      ["non-string (object)", { recipe: "default" }],
      ["string exceeding maxLength 64", "a".repeat(65)],
      // Reviewer F8: enforce the recipe identifier grammar, not just length.
      ["contains space", "has space"],
      ["contains slash", "has/slash"],
    ])("rejects malformed verification_recipe: %s", (_label, verification_recipe) => {
      const task = { ...baselineTask, verification_recipe };
      expect(Value.Check(delegateTaskSchema, task)).toBe(false);
    });

    it.each([
      "a",
      "A1",
      "recipe.test",
      "a-b_c",
      "x".repeat(64),
    ])("(F8) accepts verification_recipe matching the identifier grammar: %s", (recipe) => {
      const task = { ...baselineTask, verification_recipe: recipe };
      expect(Value.Check(delegateTaskSchema, task)).toBe(true);
    });
  });

  // ---- P1 reviewer remediation regressions (post-c35e3a6 follow-ups) ----

  describe("§3.4 delegateTaskSchema — strict closed shape (rejects unknown + recipe-field keys; documented legacy fields remain accepted)", () => {
    // Reviewer P1 remediation: the delegate-task schema must be closed
    // shape. Recipe-internal fields such as `executable` and `args` must
    // NOT be silently accepted at the top level of a delegate task. The
    // documented legacy fields (id, subagent, objective, expected_output,
    // projection_paths, context_artifacts) remain accepted.

    it.each<[string, unknown]>([
      ["random unknown key", { custom_field: "x" }],
      ["`executable` (recipe-internal field, not a task field)", { executable: "/bin/echo" }],
      ["`args` (recipe-internal field, not a task field)", { args: ["hi"] }],
    ])("rejects a delegate task carrying extra top-level key: %s", (_label, extra) => {
      const task = { ...baselineTask, ...extra };
      expect(Value.Check(delegateTaskSchema, task)).toBe(false);
    });

    it("accepts the documented legacy field set (id, subagent, objective, expected_output, projection_paths, context_artifacts)", () => {
      const task = {
        ...baselineTask,
        projection_paths: ["src/seam/schema.ts"],
        context_artifacts: [
          {
            id: "ref-1",
            source: "file" as const,
            path: "docs/delegated-verification/spec.md",
          },
        ],
      };
      expect(Value.Check(delegateTaskSchema, task)).toBe(true);
    });
  });
});
