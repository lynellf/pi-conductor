/** Issue #154 Phase A RED: opt-in delegation advisory policy + descriptions. */

import { describe, expect, it } from "vitest";
import { toMachineDefinition } from "../../src/manifest/definition.js";
import { parseManifest } from "../../src/manifest/parse.js";
import { ManifestParseError } from "../../src/manifest/types.js";
import { validateManifest } from "../../src/manifest/validate.js";

function minimalManifest(extras = ""): string {
  return `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
${extras}
`;
}

function validPolicy(extras = ""): string {
  return minimalManifest(`
delegation_advisory:
  schema_version: 1
  provider: typesafe_jev
  model: jev-latest
  mode: shadow
  max_parallel: 4
  request_timeout_ms: 5000
  max_attempts: 1
${extras}`);
}

function subagentManifest(description = ""): string {
  return `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
delegation_advisory:
  schema_version: 1
  provider: typesafe_jev
  model: jev-latest
  mode: shadow
  max_parallel: 4
  request_timeout_ms: 5000
  max_attempts: 1
subagents:
  - name: coder
    models: [stub:coder]
    max_session_cost_usd: 1
    system_prompt: prompts/coder.md
${description}
`;
}

describe("parseManifest delegation_advisory policy (issue #154)", () => {
  it("omits the policy and leaves the MachineDefinition unchanged when disabled", () => {
    const manifest = parseManifest(minimalManifest());
    expect(manifest.delegation_advisory).toBeUndefined();
    expect(toMachineDefinition(manifest)).toEqual({
      manifest_version: "1",
      orchestrator: "orchestrator",
      workers: [],
      max_visits: {},
      end_request_roles: null,
      handoff_evidence: null,
    });
  });

  it("parses and freezes the complete shadow policy", () => {
    const policy = parseManifest(validPolicy()).delegation_advisory;
    expect(policy).toEqual({
      schema_version: 1,
      provider: "typesafe_jev",
      model: "jev-latest",
      mode: "shadow",
      max_parallel: 4,
      request_timeout_ms: 5000,
      max_attempts: 1,
    });
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it("rejects unknown keys and missing required keys", () => {
    expect(() => parseManifest(validPolicy("  verdict_boost: true\n"))).toThrow(ManifestParseError);
    for (const key of [
      "schema_version",
      "provider",
      "model",
      "mode",
      "max_parallel",
      "request_timeout_ms",
      "max_attempts",
    ]) {
      const block = validPolicy().replace(new RegExp(`^  ${key}:.*\\n`, "m"), "");
      expect(() => parseManifest(block), `missing ${key}`).toThrow(ManifestParseError);
    }
  });

  it.each([
    ["schema_version", "2"],
    ["provider", "other"],
    ["mode", "active"],
    ["max_parallel", "0"],
    ["max_parallel", "17"],
    ["request_timeout_ms", "99"],
    ["request_timeout_ms", "30001"],
    ["max_attempts", "0"],
    ["max_attempts", "6"],
  ])("rejects invalid %s value %s", (key, value) => {
    const block = validPolicy().replace(new RegExp(`^  ${key}:.*$`, "m"), `  ${key}: ${value}`);
    expect(() => parseManifest(block)).toThrow(ManifestParseError);
  });

  it("requires at least one role to declare delegation", () => {
    const manifest = parseManifest(validPolicy());
    expect(validateManifest(manifest).errors.map((error) => error.code)).toContain(
      "delegation-advisory-requires-delegation",
    );
  });
});

describe("subagent profile description (issue #154)", () => {
  it("keeps descriptions optional and trims configured descriptions", () => {
    const withoutDescription = parseManifest(subagentManifest());
    expect(withoutDescription.subagents?.[0]?.description).toBeUndefined();

    const described = parseManifest(
      subagentManifest('    description: "  Writes and tests code.  "'),
    );
    expect(described.subagents?.[0]?.description).toBe("Writes and tests code.");
  });

  it("accepts a trimmed description at the 500-character boundary", () => {
    const description = "d".repeat(500);
    const manifest = parseManifest(subagentManifest(`    description: "${description}"`));
    expect(manifest.subagents?.[0]?.description).toBe(description);
  });

  it.each(["", " ", "d".repeat(501)])("rejects empty or overlong descriptions", (description) => {
    const yamlValue = JSON.stringify(description);
    expect(() => parseManifest(subagentManifest(`    description: ${yamlValue}`))).toThrow(
      ManifestParseError,
    );
  });

  it("rejects a multi-paragraph description", () => {
    expect(() =>
      parseManifest(
        subagentManifest(`    description: |\n      First paragraph.\n\n      Second paragraph.`),
      ),
    ).toThrow(ManifestParseError);
  });
});
