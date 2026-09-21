/**
 * Manifest `jev_assessment` policy tests — issue #139 Jev comment
 * (optional opt-in layer).
 *
 * Covers (TDD RED — the policy block does not exist yet):
 *  - Omission compatibility (legacy manifests parse unchanged).
 *  - Valid block with every documented bound.
 *  - Unknown key rejection.
 *  - Wrong literal rejection (schema_version, provider).
 *  - Out-of-range integer rejection (request_timeout_ms, max_attempts).
 *  - Model length bound (1–128 characters).
 */

import { describe, expect, it } from "vitest";
import { parseManifest } from "../../src/manifest/parse.js";
import { ManifestParseError } from "../../src/manifest/types.js";

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

function validBlock(extras: string = ""): string {
  return minimalManifest(`
jev_assessment:
  schema_version: 1
  provider: typesafe_jev
  model: jev-latest
  request_timeout_ms: 5000
  max_attempts: 2
${extras}
`);
}

describe("parseManifest jev_assessment policy", () => {
  it("omits jev_assessment when not configured", () => {
    const m = parseManifest(minimalManifest());
    expect(m.jev_assessment).toBeUndefined();
  });

  it("parses a valid jev_assessment block with frozen objects", () => {
    const m = parseManifest(validBlock());
    expect(m.jev_assessment).toEqual({
      schema_version: 1,
      provider: "typesafe_jev",
      model: "jev-latest",
      request_timeout_ms: 5000,
      max_attempts: 2,
    });
    expect(Object.isFrozen(m.jev_assessment)).toBe(true);
  });

  it("rejects unknown keys", () => {
    expect(() =>
      parseManifest(
        minimalManifest(`
jev_assessment:
  schema_version: 1
  provider: typesafe_jev
  model: jev-latest
  request_timeout_ms: 5000
  max_attempts: 2
  verdict_boost: true
`),
      ),
    ).toThrow(ManifestParseError);
  });

  it("rejects wrong literals", () => {
    expect(() =>
      parseManifest(
        minimalManifest(`
jev_assessment:
  schema_version: 2
  provider: typesafe_jev
  model: jev-latest
  request_timeout_ms: 5000
  max_attempts: 2
`),
      ),
    ).toThrow(ManifestParseError);
    expect(() =>
      parseManifest(
        minimalManifest(`
jev_assessment:
  schema_version: 1
  provider: other_provider
  model: jev-latest
  request_timeout_ms: 5000
  max_attempts: 2
`),
      ),
    ).toThrow(ManifestParseError);
  });

  it("rejects out-of-range integers", () => {
    expect(() =>
      parseManifest(
        minimalManifest(`
jev_assessment:
  schema_version: 1
  provider: typesafe_jev
  model: jev-latest
  request_timeout_ms: 50
  max_attempts: 2
`),
      ),
    ).toThrow(ManifestParseError);
    expect(() =>
      parseManifest(
        minimalManifest(`
jev_assessment:
  schema_version: 1
  provider: typesafe_jev
  model: jev-latest
  request_timeout_ms: 5000
  max_attempts: 9
`),
      ),
    ).toThrow(ManifestParseError);
  });

  it("rejects empty and overlong models", () => {
    expect(() =>
      parseManifest(
        minimalManifest(`
jev_assessment:
  schema_version: 1
  provider: typesafe_jev
  model: ""
  request_timeout_ms: 5000
  max_attempts: 2
`),
      ),
    ).toThrow(ManifestParseError);
    expect(() =>
      parseManifest(
        minimalManifest(`
jev_assessment:
  schema_version: 1
  provider: typesafe_jev
  model: "${"m".repeat(129)}"
  request_timeout_ms: 5000
  max_attempts: 2
`),
      ),
    ).toThrow(ManifestParseError);
  });
});
