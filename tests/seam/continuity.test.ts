/**
 * Continuity packet TypeBox schema tests — durable-continuity spec §6, §7.
 *
 * Pure schema shape tests. The semantic validators (duplicate IDs,
 * supersession, evidence authority) live in tests/persistence/continuity-contract.test.ts.
 */

import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  CONTINUITY_CONSTRAINTS,
  continuityEvaluationSchema,
  continuityFindingSchema,
  continuityNextStepSchema,
  continuityPacketV1Schema,
  continuityQuestionSchema,
  evidenceRefSchema,
} from "../../src/seam/continuity.js";

function packet(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    summary: "Investigated and patched issue X.",
    findings: [
      {
        id: "f-1",
        kind: "decision",
        confidence: "observed",
        statement: "We chose to use TypeBox.",
        evidence: [
          {
            kind: "repository",
            path: "src/seam/schema.ts",
            commit: "a".repeat(40),
          },
        ],
        supersedes: [],
      },
    ],
    evaluations: [
      {
        id: "e-1",
        label: "pnpm test",
        execution_id: "exec-1",
        supersedes: [],
      },
    ],
    open_questions: [
      {
        id: "q-1",
        question: "Should we retain raw packet prose in the seed?",
        blocking: false,
        evidence: [
          {
            kind: "external",
            url: "https://example.com/spec",
            title: "Spec link",
          },
        ],
        supersedes: [],
      },
    ],
    next_steps: [
      {
        id: "n-1",
        action: "Wire continuity into the handoff seam.",
        owner: "parent",
        evidence: [],
        supersedes: [],
      },
    ],
    okf_candidate_ids: [],
    ...overrides,
  };
}

describe("continuityPacketV1Schema", () => {
  it("accepts a structurally valid packet", () => {
    expect(Value.Check(continuityPacketV1Schema, packet())).toBe(true);
  });

  it("rejects an unknown schema_version", () => {
    expect(Value.Check(continuityPacketV1Schema, packet({ schema_version: 2 }))).toBe(false);
  });

  it("rejects unknown top-level keys", () => {
    expect(Value.Check(continuityPacketV1Schema, packet({ hidden: "yes" }))).toBe(false);
  });

  it("rejects an empty summary", () => {
    expect(Value.Check(continuityPacketV1Schema, packet({ summary: "" }))).toBe(false);
  });

  it("rejects a summary above the 2048-character cap", () => {
    expect(Value.Check(continuityPacketV1Schema, packet({ summary: "x".repeat(2049) }))).toBe(
      false,
    );
  });

  it.each([
    [
      "facts-collection-overflow",
      () => ({
        findings: Array.from({ length: 33 }, (_, index) => ({
          id: `f-${index}`,
          kind: "fact",
          confidence: "observed",
          statement: "x",
          evidence: [],
          supersedes: [],
        })),
      }),
    ],
    [
      "evaluations-collection-overflow",
      () => ({
        evaluations: Array.from({ length: 33 }, (_, index) => ({
          id: `e-${index}`,
          label: "x",
          execution_id: `exec-${index}`,
          supersedes: [],
        })),
      }),
    ],
    [
      "questions-collection-overflow",
      () => ({
        open_questions: Array.from({ length: 33 }, (_, index) => ({
          id: `q-${index}`,
          question: "x",
          blocking: false,
          evidence: [],
          supersedes: [],
        })),
      }),
    ],
    [
      "next-steps-collection-overflow",
      () => ({
        next_steps: Array.from({ length: 33 }, (_, index) => ({
          id: `n-${index}`,
          action: "x",
          owner: "parent",
          evidence: [],
          supersedes: [],
        })),
      }),
    ],
    [
      "okf-candidates-collection-overflow",
      () => ({ okf_candidate_ids: Array.from({ length: 17 }, (_, i) => `f-${i}`) }),
    ],
    ["okf-candidates-not-unique", () => ({ okf_candidate_ids: ["f-1", "f-1"] })],
    ["okf-candidate-bad-id-format", () => ({ okf_candidate_ids: ["0bad"] })],
  ])("rejects the %s case", (_name, mutate) => {
    expect(Value.Check(continuityPacketV1Schema, packet(mutate()))).toBe(false);
  });
});

describe("continuity item schemas", () => {
  it.each([
    [
      "finding",
      continuityFindingSchema,
      {
        id: "f-1",
        kind: "fact",
        confidence: "observed",
        statement: "x",
        evidence: [],
        supersedes: [],
      },
    ],
    [
      "evaluation",
      continuityEvaluationSchema,
      { id: "e-1", label: "x", execution_id: "exec", supersedes: [] },
    ],
    [
      "question",
      continuityQuestionSchema,
      {
        id: "q-1",
        question: "x",
        blocking: false,
        evidence: [],
        supersedes: [],
      },
    ],
    [
      "next-step",
      continuityNextStepSchema,
      { id: "n-1", action: "x", owner: "parent", evidence: [], supersedes: [] },
    ],
  ])("accepts the minimal %s", (_name, schema, value) => {
    expect(Value.Check(schema, value)).toBe(true);
  });

  it.each([
    [
      "unknown kind",
      {
        id: "f-1",
        kind: "opinion",
        confidence: "observed",
        statement: "x",
        evidence: [],
        supersedes: [],
      },
    ],
    [
      "unknown confidence",
      {
        id: "f-1",
        kind: "fact",
        confidence: "rumored",
        statement: "x",
        evidence: [],
        supersedes: [],
      },
    ],
    [
      "empty statement",
      {
        id: "f-1",
        kind: "fact",
        confidence: "observed",
        statement: "",
        evidence: [],
        supersedes: [],
      },
    ],
    [
      "bad id format",
      {
        id: "0bad",
        kind: "fact",
        confidence: "observed",
        statement: "x",
        evidence: [],
        supersedes: [],
      },
    ],
  ])("rejects %s on finding", (_name, value) => {
    expect(Value.Check(continuityFindingSchema, value)).toBe(false);
  });

  it("rejects unknown owner literal on next-step", () => {
    expect(
      Value.Check(continuityNextStepSchema, {
        id: "n-1",
        action: "x",
        owner: "ghost",
        evidence: [],
        supersedes: [],
      }),
    ).toBe(false);
  });

  it("rejects over-sized supersedes", () => {
    const supersedes = Array.from({ length: 9 }, (_, i) => `prev-${i}`);
    expect(
      Value.Check(continuityFindingSchema, {
        id: "f-1",
        kind: "fact",
        confidence: "observed",
        statement: "x",
        evidence: [],
        supersedes,
      }),
    ).toBe(false);
  });

  it("rejects over-sized evidence references", () => {
    const evidence = Array.from(
      { length: 9 },
      (_, i) => ({ kind: "external", url: "https://example.com", title: `t-${i}` }) as const,
    );
    expect(
      Value.Check(continuityFindingSchema, {
        id: "f-1",
        kind: "fact",
        confidence: "observed",
        statement: "x",
        evidence,
        supersedes: [],
      }),
    ).toBe(false);
  });
});

describe("evidenceRefSchema", () => {
  it.each([
    ["tool_execution", { kind: "tool_execution", execution_id: "exec-1" }],
    ["context_artifact", { kind: "context_artifact", artifact_id: "doc", sha256: "a".repeat(64) }],
    ["repository", { kind: "repository", path: "src/x.ts", commit: "b".repeat(40) }],
    ["external", { kind: "external", url: "https://example.com/spec", title: "Spec" }],
  ])("accepts %s reference", (_name, value) => {
    expect(Value.Check(evidenceRefSchema, value)).toBe(true);
  });

  it("rejects an http (non-https) external URL", () => {
    expect(
      Value.Check(evidenceRefSchema, { kind: "external", url: "http://example.com", title: "x" }),
    ).toBe(false);
  });

  it("rejects a malformed commit", () => {
    expect(
      Value.Check(evidenceRefSchema, {
        kind: "repository",
        path: "src/x.ts",
        commit: "not-a-commit",
      }),
    ).toBe(false);
  });

  it("rejects a malformed sha256 digest", () => {
    expect(
      Value.Check(evidenceRefSchema, {
        kind: "context_artifact",
        artifact_id: "doc",
        sha256: "short",
      }),
    ).toBe(false);
  });

  it("rejects an unsafe repository path", () => {
    expect(
      Value.Check(evidenceRefSchema, {
        kind: "repository",
        path: "../escape",
        commit: "c".repeat(40),
      }),
    ).toBe(false);
  });
});

describe("CONTINUITY_CONSTRAINTS", () => {
  it("pins the public byte budget and collection caps", () => {
    expect(CONTINUITY_CONSTRAINTS.MAX_PACKET_BYTES).toBe(32 * 1024);
    expect(CONTINUITY_CONSTRAINTS.MAX_SUMMARY_LENGTH).toBe(2_048);
    expect(CONTINUITY_CONSTRAINTS.MAX_COLLECTION_ITEMS).toBe(32);
    expect(CONTINUITY_CONSTRAINTS.MAX_ITEM_TEXT_LENGTH).toBe(2_048);
    expect(CONTINUITY_CONSTRAINTS.MAX_EVIDENCE_REFS_PER_ITEM).toBe(8);
    expect(CONTINUITY_CONSTRAINTS.MAX_SUPERSEDES_PER_ITEM).toBe(8);
    expect(CONTINUITY_CONSTRAINTS.MAX_OKF_CANDIDATES).toBe(16);
  });
});
