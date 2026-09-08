import { describe, expect, it } from "vitest";
import { runEndGuardAttempt } from "../../src/host/end-guard-loop.js";
import type { EndGuardRunResult } from "../../src/host/end-guard-runner.js";
import type { Host, RoleSession } from "../../src/host/host.js";
import type { EndGuardRecord } from "../../src/persistence/end-guard.js";
import { InMemoryRecordLog, type PersistedRecord } from "../../src/persistence/log.js";

const session = {
  role: "orchestrator",
  sessionId: "session-1",
  sessionFile: "/tmp/session-1.jsonl",
  model: null,
  effort: "medium",
} as RoleSession;

function hostWith(results: readonly EndGuardRunResult[]): { host: Host; calls: number[] } {
  let index = 0;
  const calls: number[] = [];
  const host = {
    runEndGuard: async (request: {
      attemptId: string;
      roleSessionId: string;
    }): Promise<EndGuardRunResult> => {
      calls.push(index);
      const result = results[index];
      index += 1;
      if (result === undefined) throw new Error("unexpected extra guard call");
      return { ...result, attemptId: request.attemptId, roleSessionId: request.roleSessionId };
    },
  } as unknown as Host;
  return { host, calls };
}

function result(
  attemptId: string,
  outcome: EndGuardRunResult["outcome"],
  output: string,
  cleanup: EndGuardRunResult["cleanup"] = "confirmed",
): EndGuardRunResult {
  return {
    attemptId,
    roleSessionId: session.sessionId,
    outcome,
    exitCode: outcome === "passed" ? 0 : null,
    signal: null,
    elapsedMs: 4,
    output,
    truncated: false,
    cleanup,
  };
}

function attempt(host: Host, log: InMemoryRecordLog): ReturnType<typeof runEndGuardAttempt> {
  const records = (): readonly EndGuardRecord[] =>
    log
      .records("run-1")
      .filter(
        (record): record is EndGuardRecord =>
          record.type === "end_guard_started" ||
          record.type === "end_guard_finished" ||
          record.type === "end_guard_budget_reset",
      );
  return runEndGuardAttempt({
    host,
    session,
    runId: "run-1",
    role: "orchestrator",
    requestId: "request-1",
    config: { command: "printf guard", timeout_seconds: 1 },
    records,
    persist: (record: PersistedRecord) => log.append(record),
  });
}

describe("end-guard loop admission", () => {
  it("persists start before finish, includes diagnostics, and exhausts on the third failure", async () => {
    const log = new InMemoryRecordLog();
    const { host } = hostWith([
      result("ignored", "failed", "first failure"),
      result("ignored", "timed_out", "second failure"),
      result("ignored", "spawn_error", "third failure"),
    ]);
    expect((await attempt(host, log)).kind).toBe("retry");
    expect((await attempt(host, log)).kind).toBe("retry");
    const exhausted = await attempt(host, log);
    expect(exhausted.kind).toBe("exhausted");
    expect(exhausted.diagnostic).toContain("third failure");
    expect(log.records("run-1").map((record) => record.type)).toEqual([
      "end_guard_started",
      "end_guard_finished",
      "end_guard_started",
      "end_guard_finished",
      "end_guard_started",
      "end_guard_finished",
    ]);
  });

  it("does not cache success and stops on unconfirmed cleanup", async () => {
    const log = new InMemoryRecordLog();
    const { host, calls } = hostWith([
      result("ignored", "passed", "ok"),
      result("ignored", "failed", "second attempt"),
      result("ignored", "cleanup_unconfirmed", "ownership lost", "unconfirmed"),
    ]);
    expect((await attempt(host, log)).kind).toBe("passed");
    expect((await attempt(host, log)).kind).toBe("retry");
    expect((await attempt(host, log)).kind).toBe("fatal");
    expect(calls).toEqual([0, 1, 2]);
  });

  it("fails closed when either durable append is ambiguous", async () => {
    const firstLog = new InMemoryRecordLog();
    const first = hostWith([result("ignored", "passed", "ok")]);
    let firstAppends = 0;
    await expect(
      runEndGuardAttempt({
        host: first.host,
        session,
        runId: "run-1",
        role: "orchestrator",
        requestId: "request-1",
        config: { command: "printf guard", timeout_seconds: 1 },
        records: () => [],
        persist: (record) => {
          firstAppends += 1;
          if (firstAppends === 1) throw new Error("start append failed");
          firstLog.append(record);
        },
      }),
    ).rejects.toThrow("start append failed");
    expect(first.calls).toHaveLength(0);

    const secondLog = new InMemoryRecordLog();
    const second = hostWith([result("ignored", "passed", "ok")]);
    let secondAppends = 0;
    await expect(
      runEndGuardAttempt({
        host: second.host,
        session,
        runId: "run-1",
        role: "orchestrator",
        requestId: "request-1",
        config: { command: "printf guard", timeout_seconds: 1 },
        records: () => [],
        persist: (record) => {
          secondAppends += 1;
          if (secondAppends === 2) throw new Error("finish append failed");
          secondLog.append(record);
        },
      }),
    ).rejects.toThrow("finish append failed");
    expect(second.calls).toHaveLength(1);
  });
});
