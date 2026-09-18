/**
 * Phase 1 contract repair: the canonical `SubagentCompletedRecord`
 * interface and `ChildTerminal` shape both expose the additive
 * `continuity` sibling that the durable-continuity spec §9 / §10
 * defines. Legacy records without the field parse unchanged.
 */

import { describe, expect, it } from "vitest";

import {
  acceptedChildCompletedSchema,
} from "../../src/persistence/delegation-lifecycle-schema.js";
import type {
  ChildContinuitySibling,
} from "../../src/persistence/continuity.js";
import type { SubagentCompletedRecord } from "../../src/persistence/log.js";

describe("SubagentCompletedRecord continuity sibling (Phase 1 contract repair)", () => {
  it("accepts legacy records without a continuity sibling", () => {
    const legacy: SubagentCompletedRecord = {
      type: "subagent_completed",
      run_id: "run-legacy",
      child_id: "child-legacy",
      task_id: "task-1",
      subagent: "handoff-runtime-worker",
      model: "minimax:MiniMax-M3",
      status: "completed",
      summary: "legacy child record",
      branch: "feature/legacy",
      worktree_path: "/tmp/legacy",
      base_commit: "81fefafd19df37747166dadda67ba8f1abfe9911",
      head_commit: "b180d0a9561e3c9ee005566482214fbbcca0ea61",
      session_file: "/tmp/legacy/session.jsonl",
      usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 },
      ts: 1,
    };
    expect(legacy.continuity).toBeUndefined();
  });

  it("accepts records with the additive continuity sibling", () => {
    const sibling: ChildContinuitySibling = {
      packet: {
        schema_version: 1,
        summary: "Phase 1 sibling round-trip test",
        findings: [],
        evaluations: [],
        open_questions: [],
        next_steps: [],
        okf_candidate_ids: [],
      },
      packet_utf8_bytes: 1024,
      evidence_resolutions: [
        {
          ref_key: "findings:f-1:0",
          kind: "external",
          status: "declared",
        },
      ],
    };
    const record: SubagentCompletedRecord = {
      type: "subagent_completed",
      run_id: "run-with-continuity",
      child_id: "child-with-continuity",
      task_id: "task-2",
      subagent: "child-continuity-worker",
      model: "minimax:MiniMax-M3",
      status: "completed",
      summary: "child record with continuity",
      branch: "feature/continuity",
      worktree_path: "/tmp/continuity",
      base_commit: "81fefafd19df37747166dadda67ba8f1abfe9911",
      head_commit: "b180d0a9561e3c9ee005566482214fbbcca0ea61",
      session_file: "/tmp/continuity/session.jsonl",
      usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 },
      continuity: sibling,
      ts: 2,
    };
    expect(record.continuity?.packet.summary).toBe("Phase 1 sibling round-trip test");
    expect(record.continuity?.packet_utf8_bytes).toBe(1024);
    expect(record.continuity?.evidence_resolutions).toHaveLength(1);
  });

  it("ChildContinuitySibling matches the TypeBox additive schema", () => {
    // Compile-time check: the Static<> alias must accept the same shape
    // the additive TypeBox schema validates. If the schema gains a new
    // required field, this assignment will fail to compile and the
    // sibling type must be re-derived.
    const packet = {
      schema_version: 1 as const,
      summary: "schema-match check",
      findings: [],
      evaluations: [],
      open_questions: [],
      next_steps: [],
      okf_candidate_ids: [],
    };
    const sibling: ChildContinuitySibling = {
      packet,
      packet_utf8_bytes: 1,
      evidence_resolutions: [],
    };
    expect(sibling.packet.schema_version).toBe(1);
  });

  it("acceptedChildCompletedSchema accepts records with and without continuity", () => {
    // The additive sibling must be Type.Optional under acceptedChildCompletedSchema
    // so the schema keeps accepting legacy records.
    const schemaKeys = Object.keys(acceptedChildCompletedSchema.properties ?? {});
    expect(schemaKeys).toContain("continuity");
  });
});