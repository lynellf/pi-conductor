import { describe, expect, it } from "vitest";

import { parseManifest } from "../../src/manifest/parse.js";
import { ManifestParseError } from "../../src/manifest/types.js";

const PROFILE = `
subagents:
  - name: reviewer
    models: [stub:reviewer]
    max_session_cost_usd: 1
    system_prompt: reviewer.md
`;

function manifestWithDelegation(delegation: string): string {
  return `
version: 2
${PROFILE}
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end, delegate_task, delegation_control]
    delegation:
${delegation}
`;
}

describe("manifest delegation assignments parser", () => {
  it("parses and deeply freezes an assignments_v1 policy", () => {
    const manifest = parseManifest(
      manifestWithDelegation(`      interface: assignments_v1
      allowed_subagents: [reviewer]
      max_children_per_session: 2
      max_parallel: 1
      assignments:
        - name: p1-review
          subagent: reviewer
          expected_output: A focused review patch.
          projection_paths: [src/manifest/validate.ts, tests/manifest/delegation-assignments.test.ts]
          tools: [read, grep]
          verification_recipe: focused-check
`),
    );
    const policy = manifest.roles[0]?.delegation;
    const assignment = policy?.assignments?.[0];

    expect(policy?.interface).toBe("assignments_v1");
    expect(assignment).toEqual({
      name: "p1-review",
      subagent: "reviewer",
      expected_output: "A focused review patch.",
      projection_paths: [
        "src/manifest/validate.ts",
        "tests/manifest/delegation-assignments.test.ts",
      ],
      tools: ["read", "grep"],
      verification_recipe: "focused-check",
    });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy?.assignments)).toBe(true);
    expect(Object.isFrozen(assignment)).toBe(true);
    expect(Object.isFrozen(assignment?.projection_paths)).toBe(true);
    expect(Object.isFrozen(assignment?.tools)).toBe(true);
  });

  it("normalizes an omitted interface to legacy_v1 without inventing assignments", () => {
    const manifest = parseManifest(
      manifestWithDelegation(`      allowed_subagents: [reviewer]
      max_children_per_session: 2
      max_parallel: 1
`),
    );

    expect(manifest.roles[0]?.delegation?.interface).toBe("legacy_v1");
    expect(manifest.roles[0]?.delegation?.assignments).toBeUndefined();
  });

  it.each([
    ["unknown key", "          unexpected: true\n"],
    ["empty assignment name", '          name: ""\n'],
    ["whitespace output", '          expected_output: "   "\n'],
    ["too-long brief contract", `          expected_output: ${JSON.stringify("x".repeat(8193))}\n`],
    ["unsafe projection", "          projection_paths: [../secret.txt]\n"],
    ["duplicate projection", "          projection_paths: [src/a.ts, src/a.ts]\n"],
    ["duplicate tools", "          tools: [read, read]\n"],
    ["unknown child tool", "          tools: [teleport]\n"],
    ["empty recipe name", '          verification_recipe: ""\n'],
  ])("rejects %s in a closed assignment", (_name, field) => {
    expect(() =>
      parseManifest(
        manifestWithDelegation(`      interface: assignments_v1
      allowed_subagents: [reviewer]
      max_children_per_session: 2
      max_parallel: 1
      assignments:
        - name: p1-review
          subagent: reviewer
          expected_output: A focused review patch.
${field}`),
      ),
    ).toThrow(ManifestParseError);
  });

  it("rejects assignment templates on the legacy interface during parsing", () => {
    expect(() =>
      parseManifest(
        manifestWithDelegation(`      interface: legacy_v1
      allowed_subagents: [reviewer]
      max_children_per_session: 1
      max_parallel: 1
      assignments:
        - name: p1-review
          subagent: reviewer
          expected_output: A focused review patch.
`),
      ),
    ).toThrow("only valid when delegation.interface is");
  });

  it("rejects an invalid delegation interface", () => {
    expect(() =>
      parseManifest(
        manifestWithDelegation(`      interface: permissive_v2
      allowed_subagents: [reviewer]
      max_children_per_session: 1
      max_parallel: 1
`),
      ),
    ).toThrow("delegation.interface must be");
  });

  it("rejects a non-array assignment list and malformed assignment entries", () => {
    expect(() =>
      parseManifest(
        manifestWithDelegation(`      interface: assignments_v1
      allowed_subagents: [reviewer]
      max_children_per_session: 1
      max_parallel: 1
      assignments: p1-review
`),
      ),
    ).toThrow("delegation.assignments must be an array");

    expect(() =>
      parseManifest(
        manifestWithDelegation(`      interface: assignments_v1
      allowed_subagents: [reviewer]
      max_children_per_session: 1
      max_parallel: 1
      assignments:
        - name: p1-review
          subagent: reviewer
          expected_output: [not, text]
`),
      ),
    ).toThrow("expected_output");
  });
});
