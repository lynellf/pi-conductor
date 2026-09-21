/**
 * Issue #139 Jev assessment, Phase A RED: strict `jev_assessment`
 * persistence record.
 *
 * Covers (TDD RED — the record module does not exist yet):
 *  - valid completed / unavailable records validate;
 *  - closed schema rejects unknown keys (including any `verdict`,
 *    `gate_state`, or check-outcome field — the record type cannot
 *    encode approval by construction);
 *  - semantic rules: completed requires judgments + model + usage and
 *    forbids failure; unavailable requires failure and forbids
 *    judgments; probability distributions sum to one;
 *  - replay identity is exact (run + role + visit + packet/reason
 *    shas); stale shas fail closed via `assertJevAssessmentFresh`;
 *  - union membership: `materializePersistedRecord` accepts the new
 *    record type once wired.
 */

import { describe, expect, it } from "vitest";
import {
  assertJevAssessmentFresh,
  assertJevAssessmentRecord,
  findJevAssessmentReplay,
  isJevAssessmentRecord,
  type JevAssessmentRecord,
  JevAssessmentStaleError,
  sha256HexString,
} from "../../src/persistence/jev-assessment-record.js";
import type { PersistedRecord } from "../../src/persistence/log.js";
import { materializePersistedRecord } from "../../src/persistence/record-materialization.js";

const PACKET_SHA = sha256HexString("packet-rendered-body");
const REASON_SHA = sha256HexString("ship the thing");
const INPUT_SHA = sha256HexString("full-jev-state");

function makeCompleted(overrides: Partial<JevAssessmentRecord> = {}): JevAssessmentRecord {
  return {
    type: "jev_assessment",
    schema_version: 1,
    run_id: "run-1",
    recipient_role: "implementer",
    recipient_visit_index: 2,
    packet_sha256: PACKET_SHA,
    reason_sha256: REASON_SHA,
    input_sha256: INPUT_SHA,
    dispatch_source_kind: "accepted_handoff",
    dispatch_source_ts: 1700,
    status: "completed",
    judgments: {
      relevance: {
        choice: "relevant",
        confidence: 0.9,
        probabilities: { relevant: 0.9, partially_relevant: 0.07, irrelevant: 0.03 },
      },
      consistency: {
        choice: "consistent",
        confidence: 0.8,
        probabilities: { consistent: 0.8, contradicted: 0.1, not_assessable: 0.1 },
      },
      actionable: { noul: 0.85 },
      next_action: {
        choice: "review",
        confidence: 0.7,
        probabilities: { review: 0.7, remediate: 0.15, block: 0.05, complete: 0.1 },
      },
    },
    requested_model: "jev-latest",
    actual_model: "jev-1.13.0",
    usage: { input_tokens: 100, output_tokens: 20 },
    ts: 1701,
    ...overrides,
  } as JevAssessmentRecord;
}

function makeUnavailable(overrides: Partial<JevAssessmentRecord> = {}): JevAssessmentRecord {
  const { judgments: _dropped, actual_model: _am, usage: _u, ...rest } = makeCompleted(overrides);
  return {
    ...rest,
    status: "unavailable",
    failure: { code: "request_timeout", attempts: 2 },
  } as JevAssessmentRecord;
}

describe("jev_assessment record contract (issue #139 Jev comment)", () => {
  it("accepts a valid completed record", () => {
    const record = makeCompleted();
    expect(() => assertJevAssessmentRecord(record)).not.toThrow();
    expect(isJevAssessmentRecord(record)).toBe(true);
  });

  it("accepts a valid unavailable record with failure and no judgments", () => {
    const record = makeUnavailable();
    expect(() => assertJevAssessmentRecord(record)).not.toThrow();
    expect(isJevAssessmentRecord(record)).toBe(true);
  });

  it.each([
    ["verdict field cannot smuggle approval", { verdict: "approved" }],
    ["gate_state field is not a record member", { gate_state: "approved" }],
    ["check-outcome field is not a record member", { checks_passed: true }],
  ])("rejects unknown keys: %s", (_label, extra) => {
    const record = { ...makeCompleted(), ...extra };
    expect(() => assertJevAssessmentRecord(record)).toThrow();
    expect(isJevAssessmentRecord(record)).toBe(false);
  });

  it("rejects completed without judgments", () => {
    const { judgments: _dropped, ...rest } = makeCompleted();
    expect(() => assertJevAssessmentRecord(rest as unknown as JevAssessmentRecord)).toThrow();
  });

  it("rejects completed with failure", () => {
    const record = {
      ...makeCompleted(),
      failure: { code: "network_error", attempts: 1 },
    } as unknown as JevAssessmentRecord;
    expect(() => assertJevAssessmentRecord(record)).toThrow();
  });

  it("rejects unavailable with judgments", () => {
    const record = {
      ...makeUnavailable(),
      judgments: makeCompleted().judgments,
    } as unknown as JevAssessmentRecord;
    expect(() => assertJevAssessmentRecord(record)).toThrow();
  });

  it("rejects unavailable without failure", () => {
    const { failure: _dropped, ...rest } = makeUnavailable();
    expect(() => assertJevAssessmentRecord(rest as unknown as JevAssessmentRecord)).toThrow();
  });

  it("rejects probability distributions that do not sum to one", () => {
    const record = makeCompleted({
      judgments: {
        relevance: {
          choice: "relevant",
          confidence: 0.9,
          probabilities: { relevant: 0.5, partially_relevant: 0.1, irrelevant: 0.1 },
        },
        consistency: {
          choice: "consistent",
          confidence: 0.8,
          probabilities: { consistent: 0.8, contradicted: 0.1, not_assessable: 0.1 },
        },
        actionable: { noul: 0.85 },
        next_action: {
          choice: "review",
          confidence: 0.7,
          probabilities: { review: 0.7, remediate: 0.15, block: 0.05, complete: 0.1 },
        },
      },
    });
    expect(() => assertJevAssessmentRecord(record)).toThrow();
  });

  it("rejects malformed sha identities", () => {
    expect(() => assertJevAssessmentRecord(makeCompleted({ packet_sha256: "xyz" }))).toThrow();
    expect(() => assertJevAssessmentRecord(makeCompleted({ reason_sha256: "ABC" }))).toThrow();
  });

  it("replays only on exact identity (run + role + visit + shas)", () => {
    const record = makeCompleted();
    const records = [record] as readonly PersistedRecord[];
    const identity = {
      run_id: "run-1",
      recipient_role: "implementer",
      recipient_visit_index: 2,
      packet_sha256: PACKET_SHA,
      reason_sha256: REASON_SHA,
    };
    expect(findJevAssessmentReplay(records, identity)).toBe(record);
    expect(
      findJevAssessmentReplay(records, { ...identity, packet_sha256: sha256HexString("other") }),
    ).toBeNull();
    expect(findJevAssessmentReplay(records, { ...identity, recipient_visit_index: 3 })).toBeNull();
    expect(findJevAssessmentReplay([], identity)).toBeNull();
  });

  it("fails closed on stale shas instead of reusing", () => {
    const record = makeCompleted();
    expect(() =>
      assertJevAssessmentFresh(record, { packet_sha256: PACKET_SHA, reason_sha256: REASON_SHA }),
    ).not.toThrow();
    expect(() =>
      assertJevAssessmentFresh(record, {
        packet_sha256: sha256HexString("stale-packet"),
        reason_sha256: REASON_SHA,
      }),
    ).toThrow(JevAssessmentStaleError);
    expect(() =>
      assertJevAssessmentFresh(record, {
        packet_sha256: PACKET_SHA,
        reason_sha256: sha256HexString("stale-reason"),
      }),
    ).toThrow(JevAssessmentStaleError);
  });

  it("enters the PersistedRecord union via materialization", () => {
    const materialized = materializePersistedRecord(makeCompleted());
    expect(materialized.record.type).toBe("jev_assessment");
  });
});
