/**
 * Manifest `context_enrichment` policy tests — jev-context-ranking spec §5.
 *
 * Covers:
 *  - Omission compatibility (legacy manifests parse unchanged).
 *  - Valid block with every documented bound.
 *  - Unknown key rejection.
 *  - Wrong literal rejection (schema_version, provider, strategy).
 *  - Out-of-range integer rejection (candidate_limit, max_parallel,
 *    request_timeout_ms, max_attempts).
 *  - Enrichment without continuity rejection (static validation).
 *  - Model length bound (1–128 characters).
 */

import { describe, expect, it } from "vitest";
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

describe("parseManifest context_enrichment policy", () => {
  it("omits context_enrichment when not configured", () => {
    const m = parseManifest(minimalManifest());
    expect(m.context_enrichment).toBeUndefined();
  });

  it("parses a valid context_enrichment block with frozen objects", () => {
    const yaml = minimalManifest(`
continuity:
  schema_version: 1
  require_handoff: false
  require_delegated_result: false
  seed_max_utf8_bytes: 32768
context_enrichment:
  schema_version: 1
  provider: typesafe_jev
  model: jev-latest
  strategy: recipient_relevance_rank
  candidate_limit: 32
  max_parallel: 8
  request_timeout_ms: 5000
  max_attempts: 3
`);
    const m = parseManifest(yaml);
    expect(m.context_enrichment).toEqual({
      schema_version: 1,
      provider: "typesafe_jev",
      model: "jev-latest",
      strategy: "recipient_relevance_rank",
      candidate_limit: 32,
      max_parallel: 8,
      request_timeout_ms: 5000,
      max_attempts: 3,
    });
    expect(Object.isFrozen(m.context_enrichment)).toBe(true);
  });

  it("rejects an unknown key under context_enrichment", () => {
    const yaml = minimalManifest(`
continuity:
  schema_version: 1
  require_handoff: false
  require_delegated_result: false
  seed_max_utf8_bytes: 16384
context_enrichment:
  schema_version: 1
  provider: typesafe_jev
  model: jev-latest
  strategy: recipient_relevance_rank
  candidate_limit: 32
  max_parallel: 8
  request_timeout_ms: 5000
  max_attempts: 3
  unknown_key: 1
`);
    expect(() => parseManifest(yaml)).toThrow(ManifestParseError);
  });

  it("rejects a missing required field (e.g. model)", () => {
    const yaml = minimalManifest(`
continuity:
  schema_version: 1
  require_handoff: false
  require_delegated_result: false
  seed_max_utf8_bytes: 16384
context_enrichment:
  schema_version: 1
  provider: typesafe_jev
  strategy: recipient_relevance_rank
  candidate_limit: 32
  max_parallel: 8
  request_timeout_ms: 5000
  max_attempts: 3
`);
    expect(() => parseManifest(yaml)).toThrow(ManifestParseError);
  });

  it("rejects an unknown schema_version literal", () => {
    const yaml = minimalManifest(`
continuity:
  schema_version: 1
  require_handoff: false
  require_delegated_result: false
  seed_max_utf8_bytes: 16384
context_enrichment:
  schema_version: 2
  provider: typesafe_jev
  model: jev-latest
  strategy: recipient_relevance_rank
  candidate_limit: 32
  max_parallel: 8
  request_timeout_ms: 5000
  max_attempts: 3
`);
    expect(() => parseManifest(yaml)).toThrow(ManifestParseError);
  });

  it("rejects an unknown provider literal", () => {
    const yaml = minimalManifest(`
continuity:
  schema_version: 1
  require_handoff: false
  require_delegated_result: false
  seed_max_utf8_bytes: 16384
context_enrichment:
  schema_version: 1
  provider: openai_score
  model: jev-latest
  strategy: recipient_relevance_rank
  candidate_limit: 32
  max_parallel: 8
  request_timeout_ms: 5000
  max_attempts: 3
`);
    expect(() => parseManifest(yaml)).toThrow(ManifestParseError);
  });

  it("rejects an unknown strategy literal", () => {
    const yaml = minimalManifest(`
continuity:
  schema_version: 1
  require_handoff: false
  require_delegated_result: false
  seed_max_utf8_bytes: 16384
context_enrichment:
  schema_version: 1
  provider: typesafe_jev
  model: jev-latest
  strategy: global_relevance_rank
  candidate_limit: 32
  max_parallel: 8
  request_timeout_ms: 5000
  max_attempts: 3
`);
    expect(() => parseManifest(yaml)).toThrow(ManifestParseError);
  });

  it("rejects an empty model string", () => {
    const yaml = minimalManifest(`
continuity:
  schema_version: 1
  require_handoff: false
  require_delegated_result: false
  seed_max_utf8_bytes: 16384
context_enrichment:
  schema_version: 1
  provider: typesafe_jev
  model: ""
  strategy: recipient_relevance_rank
  candidate_limit: 32
  max_parallel: 8
  request_timeout_ms: 5000
  max_attempts: 3
`);
    expect(() => parseManifest(yaml)).toThrow(ManifestParseError);
  });

  it("rejects a model string longer than 128 characters", () => {
    const yaml = minimalManifest(`
continuity:
  schema_version: 1
  require_handoff: false
  require_delegated_result: false
  seed_max_utf8_bytes: 16384
context_enrichment:
  schema_version: 1
  provider: typesafe_jev
  model: "${"a".repeat(129)}"
  strategy: recipient_relevance_rank
  candidate_limit: 32
  max_parallel: 8
  request_timeout_ms: 5000
  max_attempts: 3
`);
    expect(() => parseManifest(yaml)).toThrow(ManifestParseError);
  });

  it("accepts the inclusive model length boundaries (1 and 128 characters)", () => {
    for (const length of [1, 128]) {
      const yaml = minimalManifest(`
continuity:
  schema_version: 1
  require_handoff: false
  require_delegated_result: false
  seed_max_utf8_bytes: 16384
context_enrichment:
  schema_version: 1
  provider: typesafe_jev
  model: "${"a".repeat(length)}"
  strategy: recipient_relevance_rank
  candidate_limit: 32
  max_parallel: 8
  request_timeout_ms: 5000
  max_attempts: 3
`);
      expect(() => parseManifest(yaml)).not.toThrow();
    }
  });

  it("rejects candidate_limit below 1 or above 64", () => {
    for (const value of [0, 65]) {
      const yaml = minimalManifest(`
continuity:
  schema_version: 1
  require_handoff: false
  require_delegated_result: false
  seed_max_utf8_bytes: 16384
context_enrichment:
  schema_version: 1
  provider: typesafe_jev
  model: jev-latest
  strategy: recipient_relevance_rank
  candidate_limit: ${value}
  max_parallel: 8
  request_timeout_ms: 5000
  max_attempts: 3
`);
      expect(() => parseManifest(yaml)).toThrow(ManifestParseError);
    }
  });

  it("accepts candidate_limit inclusive boundaries (1 and 64)", () => {
    for (const value of [1, 64]) {
      const yaml = minimalManifest(`
continuity:
  schema_version: 1
  require_handoff: false
  require_delegated_result: false
  seed_max_utf8_bytes: 16384
context_enrichment:
  schema_version: 1
  provider: typesafe_jev
  model: jev-latest
  strategy: recipient_relevance_rank
  candidate_limit: ${value}
  max_parallel: 8
  request_timeout_ms: 5000
  max_attempts: 3
`);
      expect(() => parseManifest(yaml)).not.toThrow();
    }
  });

  it("rejects non-integer candidate_limit", () => {
    const yaml = minimalManifest(`
continuity:
  schema_version: 1
  require_handoff: false
  require_delegated_result: false
  seed_max_utf8_bytes: 16384
context_enrichment:
  schema_version: 1
  provider: typesafe_jev
  model: jev-latest
  strategy: recipient_relevance_rank
  candidate_limit: 32.5
  max_parallel: 8
  request_timeout_ms: 5000
  max_attempts: 3
`);
    expect(() => parseManifest(yaml)).toThrow(ManifestParseError);
  });

  it("rejects max_parallel below 1 or above 16", () => {
    for (const value of [0, 17]) {
      const yaml = minimalManifest(`
continuity:
  schema_version: 1
  require_handoff: false
  require_delegated_result: false
  seed_max_utf8_bytes: 16384
context_enrichment:
  schema_version: 1
  provider: typesafe_jev
  model: jev-latest
  strategy: recipient_relevance_rank
  candidate_limit: 32
  max_parallel: ${value}
  request_timeout_ms: 5000
  max_attempts: 3
`);
      expect(() => parseManifest(yaml)).toThrow(ManifestParseError);
    }
  });

  it("rejects request_timeout_ms below 100 or above 30000", () => {
    for (const value of [99, 30001]) {
      const yaml = minimalManifest(`
continuity:
  schema_version: 1
  require_handoff: false
  require_delegated_result: false
  seed_max_utf8_bytes: 16384
context_enrichment:
  schema_version: 1
  provider: typesafe_jev
  model: jev-latest
  strategy: recipient_relevance_rank
  candidate_limit: 32
  max_parallel: 8
  request_timeout_ms: ${value}
  max_attempts: 3
`);
      expect(() => parseManifest(yaml)).toThrow(ManifestParseError);
    }
  });

  it("accepts request_timeout_ms inclusive boundaries (100 and 30000)", () => {
    for (const value of [100, 30000]) {
      const yaml = minimalManifest(`
continuity:
  schema_version: 1
  require_handoff: false
  require_delegated_result: false
  seed_max_utf8_bytes: 16384
context_enrichment:
  schema_version: 1
  provider: typesafe_jev
  model: jev-latest
  strategy: recipient_relevance_rank
  candidate_limit: 32
  max_parallel: 8
  request_timeout_ms: ${value}
  max_attempts: 3
`);
      expect(() => parseManifest(yaml)).not.toThrow();
    }
  });

  it("rejects max_attempts below 1 or above 5", () => {
    for (const value of [0, 6]) {
      const yaml = minimalManifest(`
continuity:
  schema_version: 1
  require_handoff: false
  require_delegated_result: false
  seed_max_utf8_bytes: 16384
context_enrichment:
  schema_version: 1
  provider: typesafe_jev
  model: jev-latest
  strategy: recipient_relevance_rank
  candidate_limit: 32
  max_parallel: 8
  request_timeout_ms: 5000
  max_attempts: ${value}
`);
      expect(() => parseManifest(yaml)).toThrow(ManifestParseError);
    }
  });

  it("rejects a non-mapping context_enrichment entry", () => {
    const yaml = minimalManifest(`
continuity:
  schema_version: 1
  require_handoff: false
  require_delegated_result: false
  seed_max_utf8_bytes: 16384
context_enrichment: []
`);
    expect(() => parseManifest(yaml)).toThrow(ManifestParseError);
  });
});

describe("validateManifest context_enrichment requires continuity", () => {
  it("rejects context_enrichment without a continuity policy", () => {
    const yaml = minimalManifest(`
context_enrichment:
  schema_version: 1
  provider: typesafe_jev
  model: jev-latest
  strategy: recipient_relevance_rank
  candidate_limit: 32
  max_parallel: 8
  request_timeout_ms: 5000
  max_attempts: 3
`);
    const report = validateManifest(parseManifest(yaml));
    const codes = report.errors.map((error) => error.code);
    expect(codes).toContain("context-enrichment-requires-continuity");
  });

  it("accepts context_enrichment paired with continuity policy", () => {
    const yaml = minimalManifest(`
continuity:
  schema_version: 1
  require_handoff: false
  require_delegated_result: false
  seed_max_utf8_bytes: 32768
context_enrichment:
  schema_version: 1
  provider: typesafe_jev
  model: jev-latest
  strategy: recipient_relevance_rank
  candidate_limit: 32
  max_parallel: 8
  request_timeout_ms: 5000
  max_attempts: 3
`);
    const report = validateManifest(parseManifest(yaml));
    expect(report.errors).toEqual([]);
  });
});
