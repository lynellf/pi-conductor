/** Issue #154 Phase A RED: strict, append-only shadow advisory records. */

import { describe, expect, it } from "vitest";
import { assertDelegationAdvisoryRecord } from "../../src/persistence/delegation-advisory-record.js";
import { InMemoryRecordLog } from "../../src/persistence/in-memory-log.js";
import type { PersistedRecord } from "../../src/persistence/log.js";
import { materializePersistedRecord } from "../../src/persistence/record-materialization.js";

const SHA = "a".repeat(64);

function dispatchRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "delegation_dispatch_advisory",
    schema_version: 1,
    run_id: "run-1",
    logical_parent_id: "parent-session-1",
    child_id: "child-1",
    task_id: "task-1",
    subagent: "coder",
    input_sha256: SHA,
    status: "completed",
    judgments: {
      objective_verifiable: { noul: 0.9 },
      output_checkable: { noul: 0.8 },
      self_contained: { noul: 0.7 },
      scope: {
        choice: "single_contract",
        confidence: 0.8,
        probabilities: {
          single_contract: 0.8,
          related_bundle: 0.1,
          unrelated_bundle: 0.1,
        },
      },
      profile_fit: {
        choice: "coder",
        confidence: 0.8,
        probabilities: { coder: 0.8, reviewer: 0.1, none_fit: 0.1 },
      },
    },
    requested_model: "jev-latest",
    actual_model: "jev-1.13.0",
    usage: { input_tokens: 100, output_tokens: 20 },
    ts: 1700,
    ...overrides,
  };
}

function resultRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...dispatchRecord(),
    type: "delegation_result_advisory",
    host_status: "completed",
    judgments: {
      claims_supported: {
        choice: "supported",
        confidence: 0.8,
        probabilities: { supported: 0.8, contradicted: 0.1, not_assessable: 0.1 },
      },
      objective_addressed: { noul: 0.9 },
    },
    ...overrides,
  };
}

function appendable(value: Record<string, unknown>): PersistedRecord {
  return value as unknown as PersistedRecord;
}

describe("delegation advisory record contract (issue #154)", () => {
  it("accepts completed dispatch and result records with only advisory outcomes", () => {
    expect(() => assertDelegationAdvisoryRecord(dispatchRecord())).not.toThrow();
    expect(() => assertDelegationAdvisoryRecord(resultRecord())).not.toThrow();
    expect(materializePersistedRecord(appendable(dispatchRecord())).record.type).toBe(
      "delegation_dispatch_advisory",
    );
    expect(materializePersistedRecord(appendable(resultRecord())).record.type).toBe(
      "delegation_result_advisory",
    );
  });

  it("accepts the explicit profile-fit omissions", () => {
    for (const omitted of ["single_profile", "missing_descriptions"] as const) {
      const record = dispatchRecord({
        judgments: {
          objective_verifiable: { noul: 0.9 },
          output_checkable: { noul: 0.8 },
          self_contained: { noul: 0.7 },
          scope: {
            choice: "single_contract",
            confidence: 0.8,
            probabilities: { single_contract: 0.8, related_bundle: 0.1, unrelated_bundle: 0.1 },
          },
          profile_fit: { omitted },
        },
      });
      expect(() => assertDelegationAdvisoryRecord(record)).not.toThrow();
    }
  });

  it("requires unavailable records to carry only a typed failure, not partial judgments", () => {
    const {
      judgments: _judgments,
      actual_model: _actualModel,
      usage: _usage,
      ...base
    } = dispatchRecord();
    const unavailable = {
      ...base,
      status: "unavailable",
      failure: { code: "request_timeout", attempts: 1 },
    };
    expect(() => assertDelegationAdvisoryRecord(unavailable)).not.toThrow();
    expect(() => assertDelegationAdvisoryRecord({ ...unavailable, judgments: {} })).toThrow();
    expect(() => assertDelegationAdvisoryRecord({ ...unavailable, failure: undefined })).toThrow();
  });

  it("rejects extra text-bearing or authoritative fields", () => {
    for (const extra of [
      { objective: "sensitive task text" },
      { summary: "child summary" },
      { task_text: "private task content" },
      { outbound_state: { objective: "not persisted" } },
      { admission: "accepted" },
      { verdict: "approved" },
      { routing: "coder" },
      { authoritative_status: "completed" },
    ]) {
      expect(() => assertDelegationAdvisoryRecord({ ...dispatchRecord(), ...extra })).toThrow();
    }
  });

  it("rejects malformed identifiers, hashes, outcomes, and probability distributions", () => {
    expect(() =>
      assertDelegationAdvisoryRecord(dispatchRecord({ input_sha256: "not-a-hash" })),
    ).toThrow();
    expect(() => assertDelegationAdvisoryRecord(dispatchRecord({ status: "admitted" }))).toThrow();
    expect(() =>
      assertDelegationAdvisoryRecord(resultRecord({ host_status: "admitted" })),
    ).toThrow();
    expect(() =>
      assertDelegationAdvisoryRecord(
        dispatchRecord({
          judgments: {
            objective_verifiable: { noul: 0.9 },
            output_checkable: { noul: 0.8 },
            self_contained: { noul: 0.7 },
            scope: {
              choice: "single_contract",
              confidence: 0.8,
              probabilities: { single_contract: 0.8, related_bundle: 0.1, unrelated_bundle: 0.2 },
            },
            profile_fit: { omitted: "single_profile" },
          },
        }),
      ),
    ).toThrow();
  });

  it("allows one record of each type per child and rejects duplicate records of a type", () => {
    const log = new InMemoryRecordLog();
    log.append(appendable(dispatchRecord()));
    log.append(appendable(resultRecord()));
    expect(log.records("run-1")).toHaveLength(2);
    expect(() => log.append(appendable(dispatchRecord()))).toThrow();
    expect(() => log.append(appendable(resultRecord()))).toThrow();
  });
});
