import { describe, expect, it } from "vitest";
import {
  ContinuityItemIndexError,
  continuityItemIndexFromRecords,
} from "../../src/persistence/continuity-item-index.js";
import type { PersistedRecord } from "../../src/persistence/log.js";

const packet = {
  schema_version: 1 as const,
  summary: "durable packet",
  findings: [
    {
      id: "durable-finding",
      kind: "fact" as const,
      confidence: "observed" as const,
      statement: "host metadata is required",
      evidence: [],
      supersedes: [],
    },
  ],
  evaluations: [],
  open_questions: [],
  next_steps: [],
  okf_candidate_ids: [],
};

function handoff(metadata: "none" | "partial" | "complete"): PersistedRecord {
  return {
    type: "transition_accepted",
    run_id: "run-1",
    from: "orchestrator",
    to: "implementer",
    event: "handoff",
    target_role: "implementer",
    request_end: false,
    end_authority: null,
    end_requested_by: null,
    role: "orchestrator",
    suggests_next: null,
    payload_summary: { field_names: ["summary"] },
    guard: null,
    effect: [],
    session_file: "session.jsonl",
    accepted_handoff: {
      schema_version: 1,
      recipient_role: "implementer",
      payload: { continuity: packet },
      utf8_bytes: 1,
      ...(metadata === "partial" || metadata === "complete"
        ? { continuity_packet_utf8_bytes: JSON.stringify(packet).length }
        : {}),
      ...(metadata === "complete" ? { continuity_evidence: [] } : {}),
    },
    ts: 1,
  };
}

describe("continuityItemIndexFromRecords", () => {
  it("leaves legacy generic handoff payload continuity out of known item IDs", () => {
    expect(continuityItemIndexFromRecords([handoff("none")], "run-1").ids).toEqual(new Set());
  });

  it("indexes only a complete host-metadata continuity envelope", () => {
    expect(continuityItemIndexFromRecords([handoff("complete")], "run-1").ids).toEqual(
      new Set(["durable-finding"]),
    );
  });

  it("fails closed when durable metadata is partial", () => {
    expect(() => continuityItemIndexFromRecords([handoff("partial")], "run-1")).toThrow(
      ContinuityItemIndexError,
    );
  });
});
