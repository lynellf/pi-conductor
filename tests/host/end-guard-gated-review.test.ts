import { describe, expect, it } from "vitest";
import { createInitialCheckpoint } from "../../src/core/reduce.js";
import type { Checkpoint, MachineDefinition } from "../../src/core/types.js";
import type { EndGuardRunRequest, EndGuardRunResult } from "../../src/host/end-guard-runner.js";
import { runLoop } from "../../src/host/loop.js";
import { StubHost } from "../../src/host/stub-host.js";
import type { EndGuardRecord } from "../../src/persistence/end-guard.js";
import { InMemoryRecordLog } from "../../src/persistence/log.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

const DEF: MachineDefinition = {
  manifest_version: "1",
  orchestrator: "orchestrator",
  workers: ["worker"],
  max_visits: { worker: 2 },
  end_request_roles: ["worker"],
};

function fixture(checkpoint: Checkpoint) {
  const log = new InMemoryRecordLog();
  log.append({ type: "checkpoint_snapshot", checkpoint });
  let guardCalls = 0;
  const host = Object.assign(
    new StubHost({
      runId: checkpoint.run_id,
      log,
      steps: [{ kind: "emit_end" }, { kind: "emit_end" }, { kind: "emit_end" }],
      agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-gated-guard-review-"),
    }),
    {
      runEndGuard: async (request: EndGuardRunRequest): Promise<EndGuardRunResult> => {
        guardCalls += 1;
        expect(log.latestCheckpoint(checkpoint.run_id)?.end_request).toEqual(
          checkpoint.end_request,
        );
        return {
          attemptId: request.attemptId,
          roleSessionId: request.roleSessionId,
          outcome: "failed",
          exitCode: 1,
          signal: null,
          elapsedMs: 1,
          output: "repair required",
          truncated: false,
          cleanup: "confirmed",
        };
      },
    },
  );
  return {
    log,
    calls: () => guardCalls,
    run: () =>
      runLoop({
        def: DEF,
        initialCheckpoint: checkpoint,
        host,
        initialGoal: "verify completion",
        endGuard: {
          config: { command: "check" },
          requestId: () => "authorized-request-1",
          records: () =>
            log
              .records(checkpoint.run_id)
              .filter(
                (record): record is EndGuardRecord =>
                  record.type === "end_guard_started" ||
                  record.type === "end_guard_finished" ||
                  record.type === "end_guard_budget_reset",
              ),
        },
      }),
  };
}

describe("gated end-guard review", () => {
  it("does not execute the guard for an end without the required authorized request", async () => {
    const checkpoint = createInitialCheckpoint(DEF);
    const test = fixture(checkpoint);
    const result = await test.run();
    expect(result.exitReason).toBe("session_failed");
    expect(test.calls()).toBe(0);
    expect(
      test.log.records(checkpoint.run_id).some((record) => record.type === "transition_rejected"),
    ).toBe(true);
  });

  it("stops after three failures with the authorized request and role still pending", async () => {
    const checkpoint: Checkpoint = {
      ...createInitialCheckpoint(DEF),
      end_request: { role: "worker", session_file: "/tmp/authorized-review.jsonl" },
    };
    const test = fixture(checkpoint);
    const result = await test.run();
    expect(test.calls()).toBe(3);
    expect(result.exitReason).toBe("session_failed");
    expect(result.finalCheckpoint.current_role).toBe("orchestrator");
    expect(result.finalCheckpoint.active_role_session).toBeNull();
    expect(result.finalCheckpoint.end_request).toEqual(checkpoint.end_request);
    expect(test.log.latestCheckpoint(checkpoint.run_id)).toEqual(result.finalCheckpoint);
    expect(
      test.log.records(checkpoint.run_id).some((record) => record.type === "transition_accepted"),
    ).toBe(false);
    expect(
      test.log
        .records(checkpoint.run_id)
        .some(
          (record) =>
            record.type === "session_failed" && record.failure_reason === "end_guard_exhausted",
        ),
    ).toBe(true);
  });
});
