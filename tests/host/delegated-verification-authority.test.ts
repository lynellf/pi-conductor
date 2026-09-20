import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type DelegatedAuthorityErrorCode,
  resolveDelegatedAuthority,
} from "../../src/host/delegation/authority.js";
import { buildChildTools, childToolNames } from "../../src/host/delegation/run-tool.js";
import { validateBatch } from "../../src/host/delegation/validate-batch.js";
import type { DelegationPolicy, SubagentProfile } from "../../src/manifest/types.js";
import type { VerificationRecipe } from "../../src/manifest/verification-recipes.js";
import { canonicalizeVerificationRecipe } from "../../src/manifest/verification-recipes.js";

const recipe: VerificationRecipe = {
  name: "parser-focused",
  commands: [{ executable: "/usr/bin/pnpm", args: ["exec", "vitest", "run"] }],
  evaluation: "require_pass",
  required_paths: ["package.json", "tests/parser.test.ts"],
  timeout_seconds: 180,
  max_calls: 5,
};

const profile = {
  name: "local-implementer",
  models: [{ model: "stub:model", effort: "medium" as const }],
  max_session_cost_usd: 1,
  system_prompt: "worker.md",
  completion_protocol: "minimal" as const,
  execution: { backend: "bubblewrap" as const, runtime_root: "runtime", writable_paths: [] },
  tools: {
    required: false,
    allowed: [
      "read",
      "grep",
      "find",
      "ls",
      "edit",
      "write",
      "verify",
      "read_execution_output",
    ] as const,
    default: ["write", "read_execution_output", "verify", "read"] as const,
  },
  verification_recipes: ["parser-focused"],
} satisfies SubagentProfile;

function codes(result: ReturnType<typeof resolveDelegatedAuthority>): readonly string[] {
  return result.valid ? [] : result.errors.map((error) => error.code);
}

const { tools: _ignoredTools, verification_recipes: _ignoredRecipes, ...legacyProfile } = profile;

describe("delegated child authority admission", () => {
  it("resolves a sorted default and pins the canonical recipe", () => {
    const result = resolveDelegatedAuthority({
      profile,
      requestedRecipe: recipe.name,
      verificationRecipes: [recipe],
      projectionPaths: ["package.json", "tests/parser.test.ts"],
    });
    expect(result).toMatchObject({
      valid: true,
      effectiveTools: ["read", "read_execution_output", "verify", "write"],
      verificationRecipe: {
        name: recipe.name,
        canonical_json: canonicalizeVerificationRecipe(recipe),
        digest: createHash("sha256")
          .update(canonicalizeVerificationRecipe(recipe), "utf8")
          .digest("hex"),
      },
    });
  });

  it("only permits a task selection to narrow the default", () => {
    const narrowed = resolveDelegatedAuthority({
      profile,
      requestedTools: ["write", "read"],
      verificationRecipes: [recipe],
      projectionPaths: ["package.json", "tests/parser.test.ts"],
    });
    expect(narrowed).toMatchObject({ valid: true, effectiveTools: ["read", "write"] });

    const widened = resolveDelegatedAuthority({
      profile,
      requestedTools: ["find"],
      verificationRecipes: [recipe],
      projectionPaths: ["package.json", "tests/parser.test.ts"],
    });
    expect(codes(widened)).toContain(
      "tool-selection-widens-default" satisfies DelegatedAuthorityErrorCode,
    );
  });

  it.each([
    [
      "required selection",
      { ...profile, tools: { required: true, allowed: profile.tools.allowed } },
      undefined,
      "tool-selection-required",
      undefined,
    ],
    ["legacy widening", legacyProfile, ["read"], "tool-policy-unavailable", undefined],
    [
      "verify without recipe",
      { ...profile, tools: { ...profile.tools, default: ["read", "verify"] } },
      undefined,
      "verification-recipe-required",
      undefined,
    ],
    [
      "recipe without verify",
      { ...profile, tools: { ...profile.tools, default: ["read"] } },
      ["read"],
      "verification-recipe-without-verify",
      recipe.name,
    ],
  ] as const)("rejects %s", (_name, candidate, requestedTools, expected, requestedRecipe) => {
    const result = resolveDelegatedAuthority({
      profile: candidate,
      ...(requestedTools === undefined ? {} : { requestedTools }),
      ...(requestedRecipe === undefined ? {} : { requestedRecipe }),
      verificationRecipes: [recipe],
      projectionPaths: ["package.json", "tests/parser.test.ts"],
    });
    expect(codes(result)).toContain(expected);
  });

  it("rejects a recipe whose required path is outside the effective projection", () => {
    const result = resolveDelegatedAuthority({
      profile,
      requestedRecipe: recipe.name,
      verificationRecipes: [recipe],
      projectionPaths: ["package.json"],
    });
    expect(codes(result)).toContain("verification-recipe-path-not-projected");
    expect(result).toMatchObject({ valid: false, errors: [{ path: "tests/parser.test.ts" }] });
  });

  it("projects only the pinned file tools plus the completion tool", () => {
    expect(
      buildChildTools({ worktreePath: "/tmp/child", effectiveTools: ["read", "write"] }).map(
        (tool) => tool.name,
      ),
    ).toEqual(["read", "write"]);
    expect(childToolNames("report_result", ["read", "verify"])).toEqual([
      "read",
      "verify",
      "report_result",
    ]);
  });

  it("materializes exact authority in batch admission before sandbox capture", () => {
    const policy: DelegationPolicy = {
      allowed_subagents: [profile.name],
      max_children_per_session: 1,
      max_parallel: 1,
    };
    const result = validateBatch(
      {
        tasks: [
          {
            id: "parser-green",
            subagent: profile.name,
            objective: "implement",
            expected_output: "patch",
            tools: ["read", "verify"],
            verification_recipe: recipe.name,
          },
        ],
      },
      policy,
      [profile],
      1,
      { isGit: true, isClean: true, headCommit: "a".repeat(40) },
      ["package.json", "tests/parser.test.ts"],
      true,
      [recipe],
    );
    expect(result).toMatchObject({
      valid: true,
      tasks: [
        {
          effectiveTools: ["read", "verify"],
          verificationRecipe: { name: recipe.name },
        },
      ],
    });
  });

  it("rejects unknown or unauthorized recipe names before child creation", () => {
    const unknown = resolveDelegatedAuthority({
      profile,
      requestedRecipe: "other",
      verificationRecipes: [recipe],
      projectionPaths: ["package.json", "tests/parser.test.ts"],
    });
    expect(codes(unknown)).toContain("verification-recipe-unknown");

    const unauthorized = resolveDelegatedAuthority({
      profile: { ...profile, verification_recipes: [] },
      requestedRecipe: recipe.name,
      verificationRecipes: [recipe],
      projectionPaths: ["package.json", "tests/parser.test.ts"],
    });
    expect(codes(unauthorized)).toContain("verification-recipe-unauthorized");
  });
});
