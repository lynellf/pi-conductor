/** Issue #154 Phase A persistence boundary regression. */

import { expect, it } from "vitest";
import { materializePersistedRecord } from "../../src/persistence/record-materialization.js";

it("rejects task text on an otherwise valid dispatch advisory", () => {
  const record = {
    type: "delegation_dispatch_advisory",
    schema_version: 1,
    run_id: "run-1",
    logical_parent_id: "parent-1",
    child_id: "child-1",
    task_id: "task-1",
    subagent: "coder",
    input_sha256: "a".repeat(64),
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
      profile_fit: { omitted: "single_profile" },
    },
    requested_model: "jev-latest",
    actual_model: "jev-1.13.0",
    usage: { input_tokens: 100, output_tokens: 20 },
    ts: 1700,
    objective: "unredacted private task text",
  };

  expect(() => materializePersistedRecord(record)).toThrow();
});
