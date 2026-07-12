/**
 * Table-driven tests for `validateManifest` (spec §13) and
 * `toMachineDefinition` (spec §12). One assertion per behavior; cases
 * named after the rule they exercise.
 */

import { describe, expect, it } from "vitest";

import { toMachineDefinition } from "../../src/manifest/definition.js";
import { parseManifest } from "../../src/manifest/parse.js";
import type { Manifest, RoleConfig } from "../../src/manifest/types.js";
import { validateManifest } from "../../src/manifest/validate.js";

const VALID_YAML = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [anthropic:claude-sonnet-4-5]
    max_run_cost_usd: 25.0
    system_prompt: .pi/roles/orchestrator.md
    tools: [read, bash, handoff, end]
  - name: implementer
    max_visits: 3
    max_session_cost_usd: 5.0
    models: [anthropic:claude-opus-4-5, openai:gpt-4o]
    system_prompt: .pi/roles/implementer.md
    tools: [read, edit, write, bash, handoff, end]
  - name: reviewer
    max_visits: 3
    system_prompt: .pi/roles/reviewer.md
    tools: [read, grep, handoff, end]
`;

function m(roles: RoleConfig[], version = 1): Manifest {
  return { version, roles };
}

// ─── §13 hard errors ───────────────────────────────────────────────────

describe("validateManifest: hard errors (§13)", () => {
  it("accepts the §8 example manifest with no errors and no warnings", () => {
    const manifest = parseManifest(VALID_YAML);
    const r = validateManifest(manifest);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("missing-orchestrator: rejects when no role carries is_orchestrator: true", () => {
    const manifest = m([{ name: "worker", max_visits: 3 }]);
    const r = validateManifest(manifest);
    expect(r.errors.map((e) => e.code)).toContain("missing-orchestrator");
  });

  it("multiple-orchestrators: rejects when more than one role carries is_orchestrator: true", () => {
    const manifest = m([
      { name: "orch-a", is_orchestrator: true },
      { name: "orch-b", is_orchestrator: true },
    ]);
    const r = validateManifest(manifest);
    expect(r.errors.map((e) => e.code)).toContain("multiple-orchestrators");
  });

  it("uncapped-worker: rejects a worker without max_visits", () => {
    const manifest = m([
      { name: "orch", is_orchestrator: true },
      { name: "looper" /* no max_visits */ },
    ]);
    const r = validateManifest(manifest);
    expect(r.errors.map((e) => e.code)).toContain("uncapped-worker");
  });

  it("max-run-cost-on-worker: rejects max_run_cost_usd on a worker", () => {
    const manifest = m([
      { name: "orch", is_orchestrator: true },
      { name: "w", max_visits: 3, max_run_cost_usd: 10 },
    ]);
    const r = validateManifest(manifest);
    expect(r.errors.map((e) => e.code)).toContain("max-run-cost-on-worker");
  });

  it("bare-model-alias: rejects a models entry that is not provider:id", () => {
    const manifest = m([
      {
        name: "orch",
        is_orchestrator: true,
        models: [{ model: "claude-sonnet", effort: "medium" }],
      },
    ]);
    const r = validateManifest(manifest);
    expect(r.errors.map((e) => e.code)).toContain("bare-model-alias");
  });

  it("does not flag a role whose tools include both handoff and end", () => {
    const manifest = m([
      {
        name: "orch",
        is_orchestrator: true,
        tools: ["read", "handoff", "end"],
      },
    ]);
    const r = validateManifest(manifest);
    expect(r.warnings).toEqual([]);
  });

  it("does NOT flag multi-colon entries as bare-model-alias (first colon is separator)", () => {
    const manifest = m([
      {
        name: "orch",
        is_orchestrator: true,
        models: [{ model: "ollama:robit/ornith:9b", effort: "medium" }],
      },
    ]);
    const r = validateManifest(manifest);
    expect(r.errors.map((e) => e.code)).not.toContain("bare-model-alias");
  });
});

// ─── §13 soft warnings ─────────────────────────────────────────────────

describe("validateManifest: soft warnings (§13)", () => {
  it("no-cheaper-fallback: warns when max_session_cost_usd is set with only one model", () => {
    const manifest = m([
      { name: "orch", is_orchestrator: true },
      {
        name: "w",
        max_visits: 3,
        max_session_cost_usd: 5,
        models: [{ model: "anthropic:claude-opus-4-5", effort: "medium" }],
      },
    ]);
    const r = validateManifest(manifest);
    expect(r.warnings.map((w) => w.code)).toContain("no-cheaper-fallback");
  });

  it("no-cheaper-fallback: does not warn when models has 2+ entries", () => {
    const manifest = m([
      { name: "orch", is_orchestrator: true },
      {
        name: "w",
        max_visits: 3,
        max_session_cost_usd: 5,
        models: [
          { model: "anthropic:claude-opus-4-5", effort: "medium" },
          { model: "openai:gpt-4o", effort: "high" },
        ],
      },
    ]);
    const r = validateManifest(manifest);
    expect(r.warnings).toEqual([]);
  });

  it("no-cheaper-fallback: does not warn when models is absent (uses system model)", () => {
    // Spec phrasing: "its `models` list should include..." — absence
    // of a list is not a fallback-list-too-short, so no warning.
    const manifest = m([
      { name: "orch", is_orchestrator: true },
      { name: "w", max_visits: 3, max_session_cost_usd: 5 },
    ]);
    const r = validateManifest(manifest);
    expect(r.warnings).toEqual([]);
  });

  it("missing-required-tool: warns when a role's tools omits handoff or end", () => {
    const manifest = m([{ name: "orch", is_orchestrator: true, tools: ["read"] }]);
    const r = validateManifest(manifest);
    expect(r.warnings.map((w) => w.code)).toContain("missing-required-tool");
  });

  it("invalid-model-effort: rejects a models entry with an invalid effort token", () => {
    const manifest = m([
      {
        name: "orch",
        is_orchestrator: true,
        models: [{ model: "anthropic:claude-opus-4-5", effort: "turbo" as never }],
      },
    ]);
    const r = validateManifest(manifest);
    expect(r.errors.map((e) => e.code)).toContain("invalid-model-effort");
  });

  it("accepts max as a valid model effort", () => {
    const manifest = parseManifest(`
version: 1
roles:
  - name: orch
    is_orchestrator: true
    models:
      - model: openai:gpt-5.6
        effort: max
`);

    const r = validateManifest(manifest);
    expect(r.errors).toEqual([]);
  });
});

// ─── toMachineDefinition (§12) ─────────────────────────────────────────

describe("toMachineDefinition", () => {
  const manifest = parseManifest(VALID_YAML);

  it("stamps manifest_version as the integer version coerced to string", () => {
    const def = toMachineDefinition(manifest);
    expect(def.manifest_version).toBe("1");
  });

  it("orchestrator is the one role with is_orchestrator: true", () => {
    const def = toMachineDefinition(manifest);
    expect(def.orchestrator).toBe("orchestrator");
  });

  it("workers list excludes the orchestrator", () => {
    const def = toMachineDefinition(manifest);
    expect(def.workers).toEqual(["implementer", "reviewer"]);
  });

  it("max_visits matches each worker's finite cap", () => {
    const def = toMachineDefinition(manifest);
    expect(def.max_visits.implementer).toBe(3);
    expect(def.max_visits.reviewer).toBe(3);
  });

  it("returns a frozen object (top level + workers + max_visits)", () => {
    const def = toMachineDefinition(manifest);
    expect(Object.isFrozen(def)).toBe(true);
    expect(Object.isFrozen(def.workers)).toBe(true);
    expect(Object.isFrozen(def.max_visits)).toBe(true);
  });

  it("throws when called on a manifest with hard errors (no silent fallback)", () => {
    const bad = m([{ name: "w", max_visits: 3 }]); // no orchestrator
    expect(() => toMachineDefinition(bad)).toThrow(/hard error/);
  });
});

// ─── Issue #17 delegation policy validation ────────────────────────────

describe("validateManifest with delegation policy (issue #17)", () => {
  const validDelegation = {
    max_parallel: 3,
    max_children: 6,
    max_depth: 1 as const,
    workspace_modes: ["read_only", "worktree"] as const,
    max_child_cost_usd: 2.0,
  };

  it("delegation-without-delegate-tool: errors when delegation block present but delegate not in tools", () => {
    const manifest = m([
      { name: "orch", is_orchestrator: true },
      {
        name: "worker",
        max_visits: 3,
        delegation: validDelegation,
        // missing delegate from tools
      },
    ]);
    const r = validateManifest(manifest);
    expect(r.errors.map((e) => e.code)).toContain("delegation-without-delegate-tool");
  });

  it("delegation-without-block: errors when delegate in tools but no delegation block", () => {
    const manifest = m([
      { name: "orch", is_orchestrator: true },
      { name: "worker", max_visits: 3, tools: ["delegate"] },
    ]);
    const r = validateManifest(manifest);
    expect(r.errors.map((e) => e.code)).toContain("delegation-without-block");
  });

  it("both present with valid policy: no delegation-related errors", () => {
    const manifest = m([
      { name: "orch", is_orchestrator: true },
      { name: "worker", max_visits: 3, tools: ["delegate"], delegation: validDelegation },
    ]);
    const r = validateManifest(manifest);
    const delErrors = r.errors.filter((e) =>
      [
        "delegation-without-delegate-tool",
        "delegation-without-block",
        "delegation-invalid-policy",
      ].includes(e.code),
    );
    expect(delErrors).toEqual([]);
  });

  it("delegation-invalid-policy: max_depth !== 1", () => {
    const manifest = m([
      { name: "orch", is_orchestrator: true },
      {
        name: "worker",
        max_visits: 3,
        tools: ["delegate"],
        delegation: { ...validDelegation, max_depth: 2 as never },
      },
    ]);
    const r = validateManifest(manifest);
    expect(r.errors.map((e) => e.code)).toContain("delegation-invalid-policy");
  });

  it("delegation-invalid-policy: non-positive max_parallel", () => {
    const manifest = m([
      { name: "orch", is_orchestrator: true },
      {
        name: "worker",
        max_visits: 3,
        tools: ["delegate"],
        delegation: { ...validDelegation, max_parallel: 0 },
      },
    ]);
    const r = validateManifest(manifest);
    expect(r.errors.map((e) => e.code)).toContain("delegation-invalid-policy");
  });

  it("delegation-invalid-policy: non-positive max_children", () => {
    const manifest = m([
      { name: "orch", is_orchestrator: true },
      {
        name: "worker",
        max_visits: 3,
        tools: ["delegate"],
        delegation: { ...validDelegation, max_children: -1 },
      },
    ]);
    const r = validateManifest(manifest);
    expect(r.errors.map((e) => e.code)).toContain("delegation-invalid-policy");
  });

  it("delegation-invalid-policy: non-positive max_child_cost_usd", () => {
    const manifest = m([
      { name: "orch", is_orchestrator: true },
      {
        name: "worker",
        max_visits: 3,
        tools: ["delegate"],
        delegation: { ...validDelegation, max_child_cost_usd: 0 },
      },
    ]);
    const r = validateManifest(manifest);
    expect(r.errors.map((e) => e.code)).toContain("delegation-invalid-policy");
  });

  it("delegation-duplicate-workspace-mode: workspace_modes with a duplicate emits the typed code", () => {
    const manifest = m([
      { name: "orch", is_orchestrator: true },
      {
        name: "worker",
        max_visits: 3,
        tools: ["delegate"],
        delegation: { ...validDelegation, workspace_modes: ["read_only", "read_only"] as never },
      },
    ]);
    const r = validateManifest(manifest);
    expect(r.errors.map((e) => e.code)).toContain("delegation-duplicate-workspace-mode");
  });

  it("delegation-duplicate-workspace-mode: message includes the duplicate value", () => {
    const manifest = m([
      { name: "orch", is_orchestrator: true },
      {
        name: "worker",
        max_visits: 3,
        tools: ["delegate"],
        delegation: { ...validDelegation, workspace_modes: ["worktree", "worktree"] as never },
      },
    ]);
    const r = validateManifest(manifest);
    const err = r.errors.find((e) => e.code === "delegation-duplicate-workspace-mode");
    expect(err?.message).toContain("worktree");
  });

  it("existing validation cases pass unchanged", () => {
    // Re-run the §8 example; delegation block absent → same result as before.
    const manifest = parseManifest(VALID_YAML);
    const r = validateManifest(manifest);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});
