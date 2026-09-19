import { describe, expect, it } from "vitest";
import { stringify as yamlStringify } from "yaml";
import { parseManifest } from "../../src/manifest/parse.js";
import { ManifestParseError } from "../../src/manifest/types.js";
import { validateManifest } from "../../src/manifest/validate.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const baseRoles = [
  { name: "orchestrator", is_orchestrator: true },
  { name: "parent", max_visits: 1 },
];

function bubblewrap(extra: Record<string, unknown> = {}) {
  return {
    name: "wb",
    models: ["stub:model"],
    max_session_cost_usd: 1,
    system_prompt: "wb.md",
    execution: {
      backend: "bubblewrap",
      runtime_root: "rt",
      writable_paths: ["src"],
    },
    ...extra,
  };
}

function fileOnly(extra: Record<string, unknown> = {}) {
  return {
    name: "fo",
    models: ["stub:model"],
    max_session_cost_usd: 1,
    system_prompt: "fo.md",
    ...extra,
  };
}

interface BuildOpts {
  recipes?: unknown[];
}

function buildYaml(subagent: Record<string, unknown>, opts: BuildOpts = {}): string {
  const manifest: Record<string, unknown> = {
    version: 1,
    roles: baseRoles,
    subagents: [subagent],
  };
  if (opts.recipes !== undefined) {
    manifest.verification_recipes = opts.recipes;
  }
  return yamlStringify(manifest);
}

function parseAndValidate(yaml: string): {
  m: ReturnType<typeof parseManifest> | null;
  errors: readonly { code: string; message: string }[];
} {
  let m: ReturnType<typeof parseManifest>;
  try {
    m = parseManifest(yaml);
  } catch {
    return {
      m: null,
      errors: [
        {
          code: "parse-error",
          message: "parseManifest threw",
        },
      ],
    };
  }
  const errors = validateManifest(m).errors;
  return { m, errors };
}

const lintRecipe = {
  name: "lint",
  commands: [{ executable: "/usr/bin/git", args: ["status"] }],
  evaluation: "report_only",
  required_paths: ["src/foo.ts"],
  timeout_seconds: 30,
  max_calls: 1,
};
const testRecipe = {
  name: "test",
  commands: [{ executable: "/usr/bin/git", args: ["diff"] }],
  evaluation: "report_only",
  required_paths: ["src/foo.ts"],
  timeout_seconds: 30,
  max_calls: 1,
};

// ---------------------------------------------------------------------------
// Contract cases — docs/delegated-verification/spec.md §3.3 / §3.4
// ---------------------------------------------------------------------------

describe("§3.3 profile `tools` policy and §3.4 profile verification_recipes authorization", () => {
  // (1) PROFILE WITHOUT `tools:` PRESERVES LEGACY
  it("(1) profile without `tools` block — legacy preserved", () => {
    const { m, errors } = parseAndValidate(buildYaml(bubblewrap()));
    const subagents = (m as unknown as { subagents?: { tools?: unknown }[] }).subagents;
    const profile = subagents?.[0];
    expect(profile?.tools).toBeUndefined();
    expect(errors).toEqual([]);
  });

  // (2) ACCEPT required:true with non-empty allowed; default forbidden
  it.each([
    {
      label: "with non-empty `allowed` is accepted",
      subagent: bubblewrap({ tools: { required: true, allowed: ["read"] } }),
      expectError: false,
    },
    {
      label: "presence of `default` is rejected",
      subagent: bubblewrap({
        tools: { required: true, allowed: ["read"], default: ["read"] },
      }),
      expectError: true,
    },
  ])("(2) required:true semantics — $label", ({ subagent, expectError }) => {
    const { errors } = parseAndValidate(buildYaml(subagent));
    if (expectError) {
      expect(errors.length).toBeGreaterThan(0);
    } else {
      expect(errors).toEqual([]);
    }
  });

  // (3) REJECT required:false with empty default; reject required:false with default outside allowed
  it.each([
    {
      label: "empty `default` is rejected",
      subagent: bubblewrap({
        tools: { required: false, allowed: ["read", "write"], default: [] },
      }),
    },
    {
      label: "`default` containing names outside `allowed` is rejected",
      subagent: bubblewrap({
        tools: { required: false, allowed: ["read"], default: ["read", "grep"] },
      }),
    },
  ])("(3) required:false bad `default` — $label", ({ subagent }) => {
    const { errors } = parseAndValidate(buildYaml(subagent));
    expect(errors.length).toBeGreaterThan(0);
  });

  // (4) ACCEPT required:false with non-empty default subset of allowed
  it("(4) required:false with non-empty `default` that is a subset of `allowed`", () => {
    const { errors } = parseAndValidate(
      buildYaml(
        bubblewrap({
          tools: {
            required: false,
            allowed: ["read", "write", "grep"],
            default: ["read", "write"],
          },
        }),
      ),
    );
    expect(errors).toEqual([]);
  });

  // (5) REJECT empty allowed; REJECT duplicates; REJECT more than 16 entries
  it.each([
    {
      label: "empty `allowed` is rejected",
      subagent: bubblewrap({ tools: { required: false, allowed: [] } }),
    },
    {
      label: "duplicate entries in `allowed` are rejected",
      subagent: bubblewrap({
        tools: { required: false, allowed: ["read", "read"] },
      }),
    },
    {
      label: "more than 16 entries in `allowed` is rejected",
      subagent: bubblewrap({
        tools: {
          required: false,
          allowed: [
            "read",
            "grep",
            "find",
            "ls",
            "edit",
            "write",
            "bash",
            "read_execution_output",
            "verify",
            "read",
            "grep",
            "find",
            "ls",
            "edit",
            "write",
            "bash",
            "read_execution_output",
          ],
        },
      }),
    },
  ])("(5) `allowed` shape — $label", ({ subagent }) => {
    const { errors } = parseAndValidate(buildYaml(subagent));
    expect(errors.length).toBeGreaterThan(0);
  });

  // (6) REJECT unsupported tool names in allowed
  it.each([
    { label: "file:read (prefixed)", name: "file:read" },
    { label: "network:curl (prefixed)", name: "network:curl" },
    { label: "unknown (not in closed set)", name: "unknown" },
  ])("(6) unsupported tool name in `allowed` — $label", ({ name }) => {
    const { errors } = parseAndValidate(
      buildYaml(
        bubblewrap({
          tools: { required: false, allowed: ["read", name], default: ["read"] },
        }),
      ),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  // (7) ACCEPT full closed supported set in allowed
  it("(7) full closed supported set in `allowed` is accepted", () => {
    const { errors } = parseAndValidate(
      buildYaml(
        bubblewrap({
          tools: {
            required: false,
            allowed: [
              "read",
              "grep",
              "find",
              "ls",
              "edit",
              "write",
              "bash",
              "read_execution_output",
              "verify",
            ],
            default: ["read"],
          },
          verification_recipes: ["lint"],
        }),
        { recipes: [lintRecipe] },
      ),
    );
    expect(errors).toEqual([]);
  });

  // (8) REJECT default containing names not in allowed
  it("(8) `default` containing names not in `allowed` is rejected", () => {
    const { errors } = parseAndValidate(
      buildYaml(
        bubblewrap({
          tools: { required: false, allowed: ["read"], default: ["read", "grep"] },
        }),
      ),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  // (9) REJECT sandbox tools in allowed when profile has no bubblewrap execution (file-only)
  it.each([
    { label: "bash", name: "bash" },
    { label: "read_execution_output", name: "read_execution_output" },
    { label: "verify", name: "verify" },
  ])("(9) file-only profile with sandbox tool in `allowed` — $label", ({ name }) => {
    const { errors } = parseAndValidate(
      buildYaml(
        fileOnly({
          tools: { required: false, allowed: ["read", name], default: ["read"] },
        }),
      ),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  // (10) PROFILE AUTHORIZING verify MUST DECLARE ≥1 verification_recipes
  it.each([
    { label: "missing `verification_recipes`", profileRecipes: undefined as unknown[] | undefined },
    { label: "empty `verification_recipes` array", profileRecipes: [] as unknown[] },
  ])("(10) profile authorizing `verify` without recipes — $label", ({ profileRecipes }) => {
    const subagent = bubblewrap({
      tools: {
        required: false,
        allowed: ["read", "verify"],
        default: ["read"],
      },
      ...(profileRecipes !== undefined ? { verification_recipes: profileRecipes } : {}),
    });
    const { errors } = parseAndValidate(buildYaml(subagent, { recipes: [lintRecipe] }));
    expect(errors.length).toBeGreaterThan(0);
  });

  // (11) PROFILE DECLARING verification_recipes MUST INCLUDE verify IN allowed
  it("(11) profile declaring `verification_recipes` without `verify` in `allowed` is rejected", () => {
    const { errors } = parseAndValidate(
      buildYaml(
        bubblewrap({
          tools: {
            required: false,
            allowed: ["read", "write"],
            default: ["read"],
          },
          verification_recipes: ["lint"],
        }),
        { recipes: [lintRecipe] },
      ),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  // (12) PROFILE verification_recipes MUST REFERENCE DECLARED TOP-LEVEL RECIPES
  it("(12) profile `verification_recipes` must reference declared top-level recipes", () => {
    const { errors } = parseAndValidate(
      buildYaml(
        bubblewrap({
          tools: {
            required: false,
            allowed: ["read", "verify"],
            default: ["read"],
          },
          verification_recipes: ["unknown_recipe"],
        }),
        { recipes: [lintRecipe] },
      ),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  // (13) PROFILE verification_recipes DUPLICATE NAMES REJECTED
  it("(13) profile `verification_recipes` duplicate names are rejected", () => {
    const { errors } = parseAndValidate(
      buildYaml(
        bubblewrap({
          tools: {
            required: false,
            allowed: ["read", "verify"],
            default: ["read"],
          },
          verification_recipes: ["lint", "lint"],
        }),
        { recipes: [lintRecipe, testRecipe] },
      ),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  // (14) PROFILE AUTHORIZING verify PLUS NON-BUBBLEWRAP EXECUTION REJECTED
  it("(14) profile authorizing `verify` with non-bubblewrap execution is rejected", () => {
    const subagent = {
      name: "ex",
      models: ["stub:model"],
      max_session_cost_usd: 1,
      system_prompt: "ex.md",
      execution: {
        backend: "docker",
        runtime_root: "rt",
        writable_paths: ["src"],
      },
      tools: {
        required: false,
        allowed: ["read", "verify"],
        default: ["read"],
      },
      verification_recipes: ["lint"],
    };
    const { errors } = parseAndValidate(buildYaml(subagent, { recipes: [lintRecipe] }));
    expect(errors.length).toBeGreaterThan(0);
  });

  // (15) EFFECTIVE TOOL SET (PARSED) IS SORTED, DEDUPE, NON-EMPTY, SUBSET OF PROFILE CEILING
  // (15) removed under reviewer remediation F11: effective_tools materialization
  // is P2 admission work; defer to P2. Removed to avoid asserting P2 behavior
  // in P1 RED.

  // ---- Reviewer remediation regressions (commit c35e3a6) -----------------

  it("(F2 HIGH) rejects profile with NO tools policy but with profile.verification_recipes declared", () => {
    const { errors } = parseAndValidate(
      buildYaml(bubblewrap({ verification_recipes: ["lint"] }), { recipes: [lintRecipe] }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it.each([
    {
      label: "required=false default contains duplicate entries",
      subagent: bubblewrap({
        tools: { required: false, allowed: ["read", "write"], default: ["read", "read"] },
      }),
    },
    {
      label: "required=true allowed contains duplicate entries",
      subagent: bubblewrap({
        tools: { required: true, allowed: ["read", "read"] },
      }),
    },
  ])("(F4 HIGH) rejects duplicate names in tool-policy arrays: %s", ({ subagent }) => {
    const { errors } = parseAndValidate(buildYaml(subagent));
    expect(errors.length).toBeGreaterThan(0);
  });
});

// Reference the imported ManifestParseError so the exact import path stays
// in use even when none of the contract cases below need it directly.
void ManifestParseError;
