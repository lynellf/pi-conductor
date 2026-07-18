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

  it("parses and freezes end_request_roles when configured", () => {
    const manifest = parseManifest(`
version: 2
end_request_roles: [reviewer, okf-curator]
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: reviewer
    max_visits: 1
  - name: okf-curator
    max_visits: 1
`);

    expect(manifest.end_request_roles).toEqual(["reviewer", "okf-curator"]);
    expect(Object.isFrozen(manifest.end_request_roles)).toBe(true);
  });

  it("preserves legacy mode when end_request_roles is omitted", () => {
    const manifest = parseManifest(VALID_YAML);
    expect(manifest.end_request_roles).toBeUndefined();
  });

  it("rejects a non-array end_request_roles field", () => {
    expect(() =>
      parseManifest(`
version: 2
end_request_roles: reviewer
roles:
  - name: orchestrator
    is_orchestrator: true
`),
    ).toThrow("end_request_roles");
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
