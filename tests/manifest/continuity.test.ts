/**
 * Manifest continuity policy tests — durable-continuity spec §5.
 *
 * Covers parsing, unknown-key rejection, bounds enforcement, and the
 * reachable-minimal-subagent compatibility rule.
 */

import { describe, expect, it } from "vitest";
import { validateContinuityPolicy } from "../../src/manifest/continuity.js";
import { parseManifest } from "../../src/manifest/parse.js";
import { ManifestParseError } from "../../src/manifest/types.js";
import { validateManifest } from "../../src/manifest/validate.js";

function minimalManifest(extras: string = ""): string {
  return `
version: 2
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: parent
    max_visits: 1
${extras}
`;
}

describe("parseManifest continuity policy", () => {
  it("omits continuity when not configured", () => {
    const m = parseManifest(minimalManifest());
    expect(m.continuity).toBeUndefined();
  });

  it("parses a valid continuity policy with frozen objects", () => {
    const yaml = minimalManifest(`
continuity:
  schema_version: 1
  require_handoff: true
  require_delegated_result: true
  seed_max_utf8_bytes: 32768
`);
    const m = parseManifest(yaml);
    expect(m.continuity).toEqual({
      schema_version: 1,
      require_handoff: true,
      require_delegated_result: true,
      seed_max_utf8_bytes: 32768,
    });
    expect(Object.isFrozen(m.continuity)).toBe(true);
  });

  it("rejects an unknown key under continuity", () => {
    const yaml = minimalManifest(`
continuity:
  schema_version: 1
  require_handoff: true
  require_delegated_result: true
  seed_max_utf8_bytes: 16384
  unknown_key: 1
`);
    expect(() => parseManifest(yaml)).toThrow(ManifestParseError);
  });

  it("rejects an unknown schema_version", () => {
    const yaml = minimalManifest(`
continuity:
  schema_version: 2
  require_handoff: true
  require_delegated_result: false
  seed_max_utf8_bytes: 16384
`);
    expect(() => parseManifest(yaml)).toThrow(ManifestParseError);
  });

  it("rejects a non-boolean require_handoff", () => {
    const yaml = minimalManifest(`
continuity:
  schema_version: 1
  require_handoff: "yes"
  require_delegated_result: false
  seed_max_utf8_bytes: 16384
`);
    expect(() => parseManifest(yaml)).toThrow(ManifestParseError);
  });

  it("rejects a non-integer seed_max_utf8_bytes", () => {
    const yaml = minimalManifest(`
continuity:
  schema_version: 1
  require_handoff: false
  require_delegated_result: false
  seed_max_utf8_bytes: 16000.5
`);
    expect(() => parseManifest(yaml)).toThrow(ManifestParseError);
  });

  it("rejects a seed_max_utf8_bytes below the minimum bound", () => {
    const yaml = minimalManifest(`
continuity:
  schema_version: 1
  require_handoff: false
  require_delegated_result: false
  seed_max_utf8_bytes: 8000
`);
    expect(() => parseManifest(yaml)).toThrow(ManifestParseError);
  });

  it("rejects a seed_max_utf8_bytes above the maximum bound", () => {
    const yaml = minimalManifest(`
continuity:
  schema_version: 1
  require_handoff: false
  require_delegated_result: false
  seed_max_utf8_bytes: 70000
`);
    expect(() => parseManifest(yaml)).toThrow(ManifestParseError);
  });

  it("accepts the inclusive byte-budget boundaries", () => {
    for (const value of [8192, 65536]) {
      const yaml = minimalManifest(`
continuity:
  schema_version: 1
  require_handoff: false
  require_delegated_result: false
  seed_max_utf8_bytes: ${value}
`);
      expect(() => parseManifest(yaml)).not.toThrow();
    }
  });

  it("rejects a non-mapping continuity entry", () => {
    const yaml = minimalManifest(`
continuity: []
`);
    expect(() => parseManifest(yaml)).toThrow(ManifestParseError);
  });
});

describe("validateContinuityPolicy", () => {
  it("returns an empty list when policy is absent", () => {
    const m = parseManifest(minimalManifest());
    expect(validateContinuityPolicy(m)).toEqual([]);
  });

  it("accepts a require_delegated_result manifest that allows no subagents", () => {
    const yaml = minimalManifest(`
continuity:
  schema_version: 1
  require_handoff: false
  require_delegated_result: true
  seed_max_utf8_bytes: 16384
`);
    expect(validateContinuityPolicy(parseManifest(yaml))).toEqual([]);
  });

  it("accepts report_result-only delegation when require_delegated_result is true", () => {
    const yaml = minimalManifest(`
subagents:
  - name: focused
    models: [stub:model]
    max_session_cost_usd: 1
    system_prompt: .pi/subagents/focused.md
delegation:
  allowed_subagents: [focused]
  max_children_per_session: 1
  max_parallel: 1
continuity:
  schema_version: 1
  require_handoff: false
  require_delegated_result: true
  seed_max_utf8_bytes: 16384
`);
    // delegation needs to be inside the parent role:
    const yamlWithRole = yaml.replace(
      "- name: parent\n    max_visits: 1\n",
      `- name: parent
    max_visits: 1
    delegation:
      allowed_subagents: [focused]
      max_children_per_session: 1
      max_parallel: 1
`,
    );
    expect(validateContinuityPolicy(parseManifest(yamlWithRole))).toEqual([]);
  });

  it("rejects a reachable minimal subagent when require_delegated_result is true", () => {
    const yaml = minimalManifest(`
subagents:
  - name: minimal
    models: [stub:model]
    max_session_cost_usd: 1
    system_prompt: .pi/subagents/minimal.md
    completion_protocol: minimal
delegation:
  allowed_subagents: [minimal]
  max_children_per_session: 1
  max_parallel: 1
continuity:
  schema_version: 1
  require_handoff: false
  require_delegated_result: true
  seed_max_utf8_bytes: 16384
`);
    const yamlWithRole = yaml.replace(
      "- name: parent\n    max_visits: 1\n",
      `- name: parent
    max_visits: 1
    delegation:
      allowed_subagents: [minimal]
      max_children_per_session: 1
      max_parallel: 1
`,
    );
    const errors = validateContinuityPolicy(parseManifest(yamlWithRole));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("continuity-reachable-minimal-subagent");
  });

  it("accepts an unreachable minimal subagent even when require_delegated_result is true", () => {
    const yaml = minimalManifest(`
subagents:
  - name: minimal-unused
    models: [stub:model]
    max_session_cost_usd: 1
    system_prompt: .pi/subagents/min.md
    completion_protocol: minimal
delegation:
  allowed_subagents: []
  max_children_per_session: 1
  max_parallel: 1
continuity:
  schema_version: 1
  require_handoff: false
  require_delegated_result: true
  seed_max_utf8_bytes: 16384
`);
    const yamlWithRole = yaml.replace(
      "- name: parent\n    max_visits: 1\n",
      `- name: parent
    max_visits: 1
    delegation:
      allowed_subagents: []
      max_children_per_session: 1
      max_parallel: 1
`,
    );
    expect(validateContinuityPolicy(parseManifest(yamlWithRole))).toEqual([]);
  });
});

describe("validateManifest integrates continuity errors", () => {
  it("surfaces continuity errors through the manifest report", () => {
    const yaml = minimalManifest(`
subagents:
  - name: minimal
    models: [stub:model]
    max_session_cost_usd: 1
    system_prompt: .pi/subagents/min.md
    completion_protocol: minimal
delegation:
  allowed_subagents: [minimal]
  max_children_per_session: 1
  max_parallel: 1
continuity:
  schema_version: 1
  require_handoff: false
  require_delegated_result: true
  seed_max_utf8_bytes: 16384
`);
    const yamlWithRole = yaml.replace(
      "- name: parent\n    max_visits: 1\n",
      `- name: parent
    max_visits: 1
    delegation:
      allowed_subagents: [minimal]
      max_children_per_session: 1
      max_parallel: 1
`,
    );
    const report = validateManifest(parseManifest(yamlWithRole));
    const codes = report.errors.map((e) => e.code);
    expect(codes).toContain("continuity-reachable-minimal-subagent");
  });
});
