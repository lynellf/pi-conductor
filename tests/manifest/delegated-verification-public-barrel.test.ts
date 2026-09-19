/**
 * Regression: the P1 delegated-verification public surface is reachable from
 * `src/index.ts` (the package barrel) so consumers can import the closed
 * child-tool alphabet, profile tool policy, top-level verification recipe
 * shape, canonical recipe helper, and the empty verify() schema without
 * traversing internal modules. Reviewer G4 second part.
 */

import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import type {
  ChildToolName,
  SubagentToolPolicy,
  VerificationEvaluation,
  VerificationRecipe,
} from "../../src/index.js";
import {
  canonicalizeVerificationRecipe,
  parseManifest,
  parseVerificationRecipes,
  validateManifest,
  validateVerificationRecipes,
  verifyArgsSchema,
} from "../../src/index.js";

describe("delegated-verification public barrel (P1 reviewer G4)", () => {
  it("re-exports ChildToolName, SubagentToolPolicy, VerificationEvaluation, VerificationRecipe", () => {
    const tools: readonly ChildToolName[] = ["read", "verify"];
    const policy: SubagentToolPolicy = {
      required: false,
      allowed: ["read", "verify"],
      default: ["read"],
    };
    const eval1: VerificationEvaluation = "report_only";
    const recipe: VerificationRecipe = {
      name: "r",
      commands: [{ executable: "/usr/bin/git", args: ["status"] }],
      evaluation: eval1,
      required_paths: ["src/foo.ts"],
      timeout_seconds: 30,
      max_calls: 1,
    };
    expect(tools).toEqual(["read", "verify"]);
    expect(policy.required).toBe(false);
    expect(eval1).toBe("report_only");
    expect(recipe.name).toBe("r");
  });

  it("re-exports canonicalizeVerificationRecipe with object-array form (F9)", () => {
    const recipe: VerificationRecipe = {
      name: "r",
      commands: [{ executable: "/usr/bin/git", args: ["x"] }],
      evaluation: "report_only",
      required_paths: ["src/foo.ts"],
      timeout_seconds: 30,
      max_calls: 1,
    };
    const canonical = canonicalizeVerificationRecipe(recipe);
    const parsed = JSON.parse(canonical);
    expect(typeof parsed).toBe("object");
    expect(parsed.name).toBe("r");
  });

  it("re-exports parseVerificationRecipes / validateVerificationRecipes", async () => {
    const { parse: parseYaml } = await import("yaml");
    const yaml = `
name: r
commands:
  - executable: /usr/bin/git
    args: [status]
evaluation: report_only
required_paths: [src/foo.ts]
timeout_seconds: 30
max_calls: 1
`;
    // parseVerificationRecipes takes the parsed YAML array (object form),
    // not a YAML string — parseManifest handles the YAML conversion.
    const recipes = parseVerificationRecipes([parseYaml(yaml)], "verification_recipes");
    expect(recipes).toHaveLength(1);
    const errors = validateVerificationRecipes(recipes);
    expect(errors).toEqual([]);
  });

  it("re-exports verifyArgsSchema with empty-object-only behavior", () => {
    expect(Value.Check(verifyArgsSchema, {})).toBe(true);
    expect(Value.Check(verifyArgsSchema, { recipe: "x" })).toBe(false);
  });

  it("parseManifest + validateManifest remain available through the barrel", () => {
    const yaml = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: parent
    max_visits: 1
verification_recipes:
  - name: r
    commands:
      - executable: /usr/bin/git
        args: [status]
    evaluation: report_only
    required_paths: [src/foo.ts]
    timeout_seconds: 30
    max_calls: 1
`;
    const m = parseManifest(yaml);
    const v = validateManifest(m);
    expect(v.errors).toEqual([]);
    expect(m.verification_recipes).toHaveLength(1);
  });
});
