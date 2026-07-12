/**
 * parseManifest tests — spec §8, Phase 1 Task 3.
 *
 * Covers the structural layer (parse + shape). Semantic rules
 * (e.g. exactly-one-orchestrator, finite max_visits) live in
 * `validateManifest` (Phase 1 Task 4).
 */

import { describe, expect, it } from "vitest";

import { parseManifest } from "../../src/manifest/parse.js";
import { ManifestParseError } from "../../src/manifest/types.js";

// §8 example manifest verbatim. Mirrors the committed fixture at
// `.pi/conductor.yaml`. Kept inline so a parse-only test does not
// depend on the working tree.
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
    models:
      - model: anthropic:claude-opus-4-5
        effort: high
      - model: openai:gpt-4o
    system_prompt: .pi/roles/implementer.md
    tools: [read, edit, write, bash, handoff, end]
  - name: reviewer
    max_visits: 3
    system_prompt: .pi/roles/reviewer.md
    tools: [read, grep, handoff, end]
`;

describe("parseManifest", () => {
  it("parses the §8 example manifest into a typed Manifest", () => {
    const m = parseManifest(VALID_YAML);

    expect(m.version).toBe(1);
    expect(m.roles).toHaveLength(3);

    const [orch, impl, reviewer] = m.roles;
    expect(orch?.name).toBe("orchestrator");
    expect(orch?.is_orchestrator).toBe(true);
    expect(orch?.max_run_cost_usd).toBe(25.0);
    expect(orch?.system_prompt).toBe(".pi/roles/orchestrator.md");
    expect(orch?.models).toEqual([{ model: "anthropic:claude-sonnet-4-5", effort: "medium" }]);

    expect(impl?.name).toBe("implementer");
    expect(impl?.max_visits).toBe(3);
    expect(impl?.models).toEqual([
      { model: "anthropic:claude-opus-4-5", effort: "high" },
      { model: "openai:gpt-4o", effort: "medium" },
    ]);
    expect(impl?.max_session_cost_usd).toBe(5.0);

    expect(reviewer?.name).toBe("reviewer");
    expect(reviewer?.max_visits).toBe(3);
    // `models` and `max_session_cost_usd` omitted in source — not in object.
    expect(reviewer?.models).toBeUndefined();
    expect(reviewer?.max_session_cost_usd).toBeUndefined();
  });

  it("throws ManifestParseError on malformed YAML syntax", () => {
    // `:::` is not valid YAML mapping syntax; parser will throw.
    expect(() => parseManifest("version: 1\nroles: [ ::: ]\n")).toThrow(ManifestParseError);
  });

  it("throws ManifestParseError when roles[] is missing", () => {
    expect(() => parseManifest("version: 1\n")).toThrow(ManifestParseError);
  });

  it("throws ManifestParseError on invalid model effort", () => {
    expect(() =>
      parseManifest(
        `version: 1\nroles:\n  - name: orchestrator\n    is_orchestrator: true\n    models:\n      - model: anthropic:claude-sonnet-4-5\n        effort: turbo\n`,
      ),
    ).toThrow(ManifestParseError);
  });

  it("parses GPT-5.6 max effort", () => {
    const manifest = parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models:
      - model: openai:gpt-5.6
        effort: max
`);

    expect(manifest.roles[0]?.models).toEqual([{ model: "openai:gpt-5.6", effort: "max" }]);
  });

  it("parses bounded retry settings on model entries", () => {
    const manifest = parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models:
      - model: stub:primary
        retries: 2
        retry_delay_ms: 5000
`);

    expect(manifest.roles[0]?.models).toEqual([
      { model: "stub:primary", effort: "medium", retries: 2, retry_delay_ms: 5000 },
    ]);
  });

  it("rejects a retry delay above the bounded host limit", () => {
    expect(() =>
      parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models:
      - model: stub:primary
        retry_delay_ms: 60001
`),
    ).toThrow("retry_delay_ms must be between 0 and 60000 milliseconds");
  });

  it("rejects an unbounded retry allowance", () => {
    expect(() =>
      parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models:
      - model: stub:primary
        retries: 11
`),
    ).toThrow("retries must be between 0 and 10 additional attempts");
  });
});

// ─── Issue #17 delegation block parsing ──────────────────────────────

describe("parseManifest with delegation block (issue #17)", () => {
  it("parses a role with a valid delegation block", () => {
    const m = parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: implementer
    max_visits: 3
    tools: [read, edit, bash, handoff, end, delegate]
    delegation:
      max_parallel: 3
      max_children: 6
      max_depth: 1
      workspace_modes: [read_only, worktree]
      max_child_cost_usd: 2.00
`);
    const impl = m.roles[1];
    expect(impl?.delegation).toEqual({
      max_parallel: 3,
      max_children: 6,
      max_depth: 1 as const,
      workspace_modes: ["read_only", "worktree"],
      max_child_cost_usd: 2.0,
    });
  });

  it("parses a role without delegation (delegation field is undefined)", () => {
    const m = parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: reviewer
    max_visits: 3
    tools: [read, handoff, end]
`);
    expect(m.roles[1]?.delegation).toBeUndefined();
  });

  it("parses a role with only read_only workspace mode", () => {
    const m = parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 2
    tools: [read, handoff, end, delegate]
    delegation:
      max_parallel: 1
      max_children: 2
      max_depth: 1
      workspace_modes: [read_only]
      max_child_cost_usd: 0.50
`);
    expect(m.roles[1]?.delegation?.workspace_modes).toEqual(["read_only"]);
  });

  it("throws when max_depth is not the literal 1", () => {
    expect(() =>
      parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 2
    tools: [delegate]
    delegation:
      max_parallel: 1
      max_children: 2
      max_depth: 2
      workspace_modes: [read_only]
      max_child_cost_usd: 1.00
`),
    ).toThrow("must be the literal 1");
  });

  it("throws when max_depth is 0", () => {
    expect(() =>
      parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 2
    tools: [delegate]
    delegation:
      max_parallel: 1
      max_children: 2
      max_depth: 0
      workspace_modes: [read_only]
      max_child_cost_usd: 1.00
`),
    ).toThrow("must be the literal 1");
  });

  it("throws when max_parallel is zero", () => {
    expect(() =>
      parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 2
    tools: [delegate]
    delegation:
      max_parallel: 0
      max_children: 2
      max_depth: 1
      workspace_modes: [read_only]
      max_child_cost_usd: 1.00
`),
    ).toThrow("must be a positive integer (>= 1)");
  });

  it("throws when max_parallel is negative", () => {
    expect(() =>
      parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 2
    tools: [delegate]
    delegation:
      max_parallel: -1
      max_children: 2
      max_depth: 1
      workspace_modes: [read_only]
      max_child_cost_usd: 1.00
`),
    ).toThrow("must be a positive integer (>= 1)");
  });

  it("throws when max_children is zero", () => {
    expect(() =>
      parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 2
    tools: [delegate]
    delegation:
      max_parallel: 1
      max_children: 0
      max_depth: 1
      workspace_modes: [read_only]
      max_child_cost_usd: 1.00
`),
    ).toThrow("must be a positive integer (>= 1)");
  });

  it("throws when max_child_cost_usd is zero", () => {
    expect(() =>
      parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 2
    tools: [delegate]
    delegation:
      max_parallel: 1
      max_children: 2
      max_depth: 1
      workspace_modes: [read_only]
      max_child_cost_usd: 0
`),
    ).toThrow("must be a positive finite number");
  });

  it("throws when max_child_cost_usd is negative", () => {
    expect(() =>
      parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 2
    tools: [delegate]
    delegation:
      max_parallel: 1
      max_children: 2
      max_depth: 1
      workspace_modes: [read_only]
      max_child_cost_usd: -0.01
`),
    ).toThrow("must be a positive finite number");
  });

  it("throws when workspace_modes contains an invalid string", () => {
    expect(() =>
      parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 2
    tools: [delegate]
    delegation:
      max_parallel: 1
      max_children: 2
      max_depth: 1
      workspace_modes: [invalid_mode]
      max_child_cost_usd: 1.00
`),
    ).toThrow('must be "read_only" or "worktree"');
  });

  it("throws when workspace_modes is a non-array", () => {
    expect(() =>
      parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 2
    tools: [delegate]
    delegation:
      max_parallel: 1
      max_children: 2
      max_depth: 1
      workspace_modes: read_only
      max_child_cost_usd: 1.00
`),
    ).toThrow("must be an array");
  });

  it("throws when delegation block is a string instead of an object", () => {
    expect(() =>
      parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 2
    tools: [delegate]
    delegation: not_an_object
`),
    ).toThrow("must be a YAML mapping (object)");
  });
});
