import { describe, expect, it } from "vitest";

import { parseManifest } from "../../src/manifest/parse.js";
import type { DelegationPolicy } from "../../src/manifest/types.js";
import { validateManifest } from "../../src/manifest/validate.js";

const PROFILE = `
  - name: reviewer
    models: [stub:reviewer]
    max_session_cost_usd: 1
    system_prompt: reviewer.md
`;

function manifest(overrides: string): ReturnType<typeof parseManifest> {
  return parseManifest(`
version: 2
subagents:
${PROFILE}
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end, delegate_task, delegation_control]
    delegation:
      interface: assignments_v1
      allowed_subagents: [reviewer]
      max_children_per_session: 2
      max_parallel: 1
      assignments:
        - name: p1-review
          subagent: reviewer
          expected_output: A focused review patch.
${overrides}
`);
}

function codes(source: ReturnType<typeof parseManifest>): readonly string[] {
  return validateManifest(source).errors.map((error) => error.code);
}

describe("manifest delegation assignment validation", () => {
  it("accepts a bounded assignment that uses the allowed profile", () => {
    expect(codes(manifest("")).filter((code) => code.startsWith("delegation-assignment"))).toEqual(
      [],
    );
  });

  it("requires assignments_v1 to declare at least one assignment", () => {
    const source = manifest("");
    const role = source.roles[0];
    if (role === undefined || role.delegation === undefined) throw new Error("missing test role");
    const { assignments: _assignments, ...legacyPolicyFields } = role.delegation;
    const withoutAssignments = {
      ...source,
      roles: [{ ...role, delegation: legacyPolicyFields }],
    };

    expect(validateManifest(withoutAssignments).errors.map((error) => error.code)).toContain(
      "delegation-assignments-required",
    );
  });

  it("requires the two assignment-mode role tools and rejects legacy delegate", () => {
    const source = manifest("");
    const role = source.roles[0];
    if (role === undefined) throw new Error("missing test role");

    const report = validateManifest({
      ...source,
      roles: [{ ...role, tools: ["handoff", "end", "delegate"] }],
    });
    const errors = report.errors.map((error) => error.code);

    expect(errors).toContain("delegation-missing-delegate-task-tool");
    expect(errors).toContain("delegation-missing-control-tool");
    expect(errors).toContain("delegation-assignment-legacy-tool");
  });

  it("rejects assignment profiles that are undeclared or not parent-allowed", () => {
    const source = manifest("");
    const role = source.roles[0];
    if (role === undefined || role.delegation === undefined) throw new Error("missing test role");
    const assignment = role.delegation.assignments?.[0];
    if (assignment === undefined) throw new Error("missing test assignment");

    const report = validateManifest({
      ...source,
      roles: [
        {
          ...role,
          delegation: {
            ...role.delegation,
            assignments: [
              { ...assignment, subagent: "missing-profile" },
              { ...assignment, name: "not-allowed", subagent: "reviewer" },
            ],
            allowed_subagents: [],
          } as unknown as DelegationPolicy,
        },
      ],
    });
    const messages = report.errors.map((error) => error.message).join("\n");

    expect(messages).toContain("assignment 'p1-review' references undeclared subagent");
    expect(messages).toContain("assignment 'not-allowed' is not allowed");
  });

  it("rejects unsafe and duplicate projection paths at static validation", () => {
    const source = manifest("");
    const role = source.roles[0];
    if (role === undefined || role.delegation === undefined) throw new Error("missing test role");
    const assignment = role.delegation.assignments?.[0];
    if (assignment === undefined) throw new Error("missing test assignment");

    const report = validateManifest({
      ...source,
      roles: [
        {
          ...role,
          delegation: {
            ...role.delegation,
            assignments: [
              {
                ...assignment,
                projection_paths: ["../secret", "src/file.ts", "src/file.ts"],
              },
            ],
          } as unknown as DelegationPolicy,
        },
      ],
    });

    expect(report.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        "delegation-assignment-projection-unsafe",
        "delegation-assignment-projection-duplicate",
      ]),
    );
  });

  it("rejects assignment tools outside the profile's closed authority", () => {
    const source = manifest("");
    const role = source.roles[0];
    if (role === undefined || role.delegation === undefined) throw new Error("missing test role");
    const assignment = role.delegation.assignments?.[0];
    if (assignment === undefined) throw new Error("missing test assignment");

    const report = validateManifest({
      ...source,
      roles: [
        {
          ...role,
          delegation: {
            ...role.delegation,
            assignments: [{ ...assignment, tools: ["bash" as const] }],
          } as unknown as DelegationPolicy,
        },
      ],
    });

    expect(report.errors.map((error) => error.code)).toContain(
      "delegation-assignment-tools-not-authorized",
    );
  });

  it("rejects assignment lists on the legacy interface", () => {
    const source = manifest("");
    const role = source.roles[0];
    if (role === undefined || role.delegation === undefined) throw new Error("missing test role");

    const report = validateManifest({
      ...source,
      roles: [
        {
          ...role,
          tools: ["handoff", "end", "delegate"],
          delegation: {
            ...role.delegation,
            interface: "legacy_v1",
          } as unknown as DelegationPolicy,
        },
      ],
    });

    expect(report.errors.map((error) => error.code)).toContain(
      "delegation-legacy-assignment-config",
    );
  });
});
