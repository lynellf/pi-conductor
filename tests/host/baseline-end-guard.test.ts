import { expect, it } from "vitest";
import { EndGuardRunner } from "../../src/host/end-guard-runner.js";
import { assertEndGuardRecord } from "../../src/persistence/end-guard.js";

const common = {
  attemptId: "attempt",
  supervisionId: "correlation-only",
  roleSessionId: "session",
};
it("runs the configured baseline guard instead of skipping it", async () => {
  const runner = new EndGuardRunner(process.cwd(), undefined, "baseline");
  const result = await runner.run({
    ...common,
    config: {
      command: `"${process.execPath}" -e "process.stdout.write('guard-ran')"`,
      timeout_seconds: 3,
    },
  });
  expect(result).toMatchObject({
    outcome: "passed",
    exitCode: 0,
    cleanup: "not-guaranteed",
    output: "guard-ran",
  });
});
it("keeps baseline guard failures correctable without claiming cleanup", async () => {
  const runner = new EndGuardRunner(process.cwd(), undefined, "baseline");
  const result = await runner.run({
    ...common,
    config: { command: `"${process.execPath}" -e "process.exit(2)"`, timeout_seconds: 3 },
  });
  expect(result).toMatchObject({ outcome: "failed", exitCode: 2, cleanup: "not-guaranteed" });
});
it("bounds baseline guard timeout and permits an explicit correction after observed close", async () => {
  const runner = new EndGuardRunner(process.cwd(), undefined, "baseline");
  const config = {
    command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"`,
    timeout_seconds: 0.1,
  };
  expect(await runner.run({ ...common, config })).toMatchObject({
    outcome: "timed_out",
    foregroundStatus: "closed",
    cleanup: "not-guaranteed",
  });
  await expect(
    runner.run({
      ...common,
      attemptId: "replacement",
      config: { command: "true", timeout_seconds: 1 },
    }),
  ).resolves.toMatchObject({ outcome: "passed", cleanup: "not-guaranteed" });
});
it("permits only explicitly baseline passed records without confirmed cleanup", () => {
  const record = {
    type: "end_guard_finished",
    schema_version: 1,
    run_id: "run",
    attempt_id: "attempt",
    supervision_id: "correlation",
    request_id: "request",
    role: "orchestrator",
    role_session_id: "session",
    session_file: "session.jsonl",
    execution_tier: "baseline",
    elapsed_ms: 1,
    outcome: "passed",
    exit_code: 0,
    signal: null,
    diagnostic: "",
    truncated: false,
    cleanup: "not-guaranteed",
    ts: 1,
  };
  expect(() => assertEndGuardRecord(record)).not.toThrow();
  const { execution_tier: _tier, ...legacy } = record;
  expect(() => assertEndGuardRecord(legacy)).toThrow();
  expect(() => assertEndGuardRecord({ ...record, cleanup: "confirmed" })).toThrow();
});
