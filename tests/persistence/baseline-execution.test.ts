import { expect, it } from "vitest";
import {
  assertBaselineExecutionRecord,
  assertBaselineExecutionsSettled,
} from "../../src/persistence/baseline-execution.js";
import { InMemoryRecordLog } from "../../src/persistence/in-memory-log.js";

const started = {
  type: "baseline_execution_started",
  schema_version: 1,
  run_id: "run",
  execution_id: "one",
  logical_session_id: "logical",
  role_session_id: "physical",
  tool_call_id: "call",
  tool_name: "write",
  execution_tier: "baseline",
  timeout_ms: 1000,
  ts: 1,
} as const;
const finished = {
  type: "baseline_execution_finished",
  schema_version: 1,
  run_id: "run",
  execution_id: "one",
  logical_session_id: "logical",
  role_session_id: "physical",
  tool_call_id: "call",
  tool_name: "write",
  execution_tier: "baseline",
  elapsed_ms: 2,
  outcome: "completed",
  cleanup: "not-guaranteed",
  ts: 3,
} as const;

it("retains truthful baseline records through the log boundary", () => {
  const log = new InMemoryRecordLog();
  log.append(started);
  log.append(finished);
  expect(() => assertBaselineExecutionsSettled(log.records("run"))).not.toThrow();
  expect(log.records("run")[1]).toEqual(finished);
});
it.each([
  "timed_out",
  "aborted",
  "uncertain",
] as const)("blocks resume after baseline %s", (outcome) => {
  expect(() => assertBaselineExecutionsSettled([started, { ...finished, outcome }])).toThrow(
    "baseline",
  );
});
it("blocks unmatched baseline starts before replay", () => {
  expect(() => assertBaselineExecutionsSettled([started])).toThrow("baseline");
});
it.each([
  "confirmed",
  "unconfirmed",
  "not-started",
])("never accepts baseline cleanup=%s", (cleanup) => {
  expect(() => assertBaselineExecutionRecord({ ...finished, cleanup })).toThrow();
});
it("rejects terminal identity mismatch and duplicate terminals", () => {
  expect(() =>
    assertBaselineExecutionsSettled([started, { ...finished, tool_call_id: "other" }]),
  ).toThrow();
  expect(() => assertBaselineExecutionsSettled([started, finished, finished])).toThrow();
});
