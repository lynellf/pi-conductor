import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EndGuardRunRequest, EndGuardRunResult } from "../../src/host/end-guard-runner.js";
import { StubHost } from "../../src/host/index.js";
import type { StubStep } from "../../src/host/stub-provider.js";
import {
  type CheckpointSnapshot,
  FileRecordLog,
  type Host,
  type HostFactoryContext,
  resumeRun,
  startRun,
} from "../../src/index.js";
import {
  type EndGuardFinishedRecord,
  type EndGuardStartedRecord,
  endGuardRequestId,
} from "../../src/persistence/end-guard.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

const UNGATED_MANIFEST = `
version: 1
end_guard:
  command: check
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [end]
`;

const GATED_MANIFEST = `
version: 1
end_request_roles: [worker]
end_guard:
  command: check
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end]
  - name: worker
    max_visits: 2
    tools: [handoff, end]
`;

const TOOL_POLICY_MANIFEST = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tool_execution:
      timeout_seconds: 17
      max_recoverable_timeouts: 4
      termination_grace_seconds: 5
    tools: [end]
subagents:
  - name: helper
    models: [stub:model]
    max_session_cost_usd: 1
    system_prompt: .pi/roles/helper.md
    tool_execution:
      timeout_seconds: 23
`;

let workdir: string;
let baseDir: string;

async function writeManifest(contents: string): Promise<string> {
  const piDir = join(workdir, ".pi");
  await mkdir(piDir, { recursive: true });
  const path = join(piDir, "conductor.yaml");
  await writeFile(path, contents, "utf8");
  return path;
}

function guardedHost(
  context: HostFactoryContext,
  steps: readonly StubStep[],
  outcome: "passed" | "failed" = "passed",
): Host {
  const host = new StubHost({
    runId: context.runId,
    log: context.log,
    loadedManifest: context.loadedManifest,
    steps,
    agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-end-guard-resume-"),
  }) as StubHost & {
    runEndGuard: (request: EndGuardRunRequest) => Promise<EndGuardRunResult>;
  };
  host.runEndGuard = async (request) => ({
    attemptId: request.attemptId,
    roleSessionId: request.roleSessionId,
    outcome,
    exitCode: outcome === "passed" ? 0 : 1,
    signal: null,
    elapsedMs: 1,
    output: outcome,
    truncated: false,
    cleanup: "confirmed",
  });
  return host;
}

async function completedRun(manifestText = UNGATED_MANIFEST): Promise<{
  readonly manifestPath: string;
  readonly runId: string;
  readonly log: FileRecordLog;
}> {
  const manifestPath = await writeManifest(manifestText);
  const handle = await startRun(manifestPath, {
    goal: "resume end guard",
    baseDir,
    hostFactory: (context) => guardedHost(context, [{ kind: "emit_end", reason: "done" }]),
  });
  await handle.completion();
  return { manifestPath, runId: handle.runId, log: new FileRecordLog({ baseDir }) };
}

function appendFailure(
  log: FileRecordLog,
  runId: string,
  requestId: string,
  ordinal: number,
): void {
  const attemptId = `attempt-${ordinal}`;
  const started: EndGuardStartedRecord = {
    type: "end_guard_started",
    schema_version: 1,
    run_id: runId,
    attempt_id: attemptId,
    supervision_id: `supervision-${attemptId}`,
    request_id: requestId,
    role: "orchestrator",
    role_session_id: `role-session-${ordinal}`,
    session_file: `/tmp/end-guard-${ordinal}.jsonl`,
    timeout_ms: 60_000,
    ts: ordinal * 2,
  };
  const finished: EndGuardFinishedRecord = {
    type: "end_guard_finished",
    schema_version: 1,
    run_id: runId,
    attempt_id: attemptId,
    supervision_id: started.supervision_id,
    request_id: requestId,
    role: started.role,
    role_session_id: started.role_session_id,
    session_file: started.session_file,
    elapsed_ms: 1,
    outcome: "failed",
    exit_code: 1,
    signal: null,
    diagnostic: "repair required",
    truncated: false,
    cleanup: "confirmed",
    ts: ordinal * 2 + 1,
  };
  log.append(started);
  log.append(finished);
}

function appendUnconfirmed(log: FileRecordLog, runId: string): void {
  const started: EndGuardStartedRecord = {
    type: "end_guard_started",
    schema_version: 1,
    run_id: runId,
    attempt_id: "unconfirmed-attempt",
    supervision_id: "unconfirmed-supervision",
    request_id: JSON.stringify([runId, 1, null, null, null]),
    role: "orchestrator",
    role_session_id: "unconfirmed-role-session",
    session_file: "/tmp/unconfirmed-end-guard.jsonl",
    timeout_ms: 60_000,
    ts: 1,
  };
  const finished: EndGuardFinishedRecord = {
    type: "end_guard_finished",
    schema_version: 1,
    run_id: runId,
    attempt_id: started.attempt_id,
    supervision_id: started.supervision_id,
    request_id: started.request_id,
    role: started.role,
    role_session_id: started.role_session_id,
    session_file: started.session_file,
    elapsed_ms: 1,
    outcome: "cleanup_unconfirmed",
    exit_code: null,
    signal: null,
    diagnostic: "owner unknown",
    truncated: false,
    cleanup: "unconfirmed",
    ts: 2,
  };
  log.append(started);
  log.append(finished);
}

describe("public end-guard resume boundaries", () => {
  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "pi-conductor-end-guard-resume-"));
    baseDir = join(workdir, "runs");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("keeps the pinned guard when the current YAML is edited", async () => {
    const manifestPath = await writeManifest(UNGATED_MANIFEST);
    const started = await startRun(manifestPath, {
      goal: "pinned guard",
      baseDir,
      hostFactory: (context) => guardedHost(context, [{ kind: "emit_end" }]),
    });
    await writeManifest(UNGATED_MANIFEST.replace("command: check", "command: changed"));

    let observed: string | undefined;
    const resumed = await resumeRun(manifestPath, started.runId, {
      goal: "",
      baseDir,
      hostFactory: (context) => {
        observed = context.loadedManifest.manifest.end_guard?.command;
        return guardedHost(context, []);
      },
    });
    await resumed.completion();
    expect(observed).toBe("check");
  });

  it("keeps pinned role and profile tool policies when current YAML changes", async () => {
    const manifestPath = await writeManifest(TOOL_POLICY_MANIFEST);
    const started = await startRun(manifestPath, {
      goal: "pinned tool policy",
      baseDir,
      hostFactory: (context) => guardedHost(context, [{ kind: "emit_end" }]),
    });
    await writeManifest(
      TOOL_POLICY_MANIFEST.replace("timeout_seconds: 17", "timeout_seconds: 91").replace(
        "timeout_seconds: 23",
        "timeout_seconds: 92",
      ),
    );

    let observed:
      | {
          readonly roleTimeout: number | undefined;
          readonly roleRecoveries: number | undefined;
          readonly roleGrace: number | undefined;
          readonly profileTimeout: number | undefined;
          readonly profileRecoveries: number | undefined;
          readonly profileGrace: number | undefined;
        }
      | undefined;
    const resumed = await resumeRun(manifestPath, started.runId, {
      goal: "",
      baseDir,
      hostFactory: (context) => {
        const role = context.loadedManifest.manifest.roles[0];
        const profile = context.loadedManifest.manifest.subagents?.[0];
        observed = {
          roleTimeout: role?.tool_execution?.timeout_seconds,
          roleRecoveries: role?.tool_execution?.max_recoverable_timeouts,
          roleGrace: role?.tool_execution?.termination_grace_seconds,
          profileTimeout: profile?.tool_execution?.timeout_seconds,
          profileRecoveries: profile?.tool_execution?.max_recoverable_timeouts,
          profileGrace: profile?.tool_execution?.termination_grace_seconds,
        };
        return guardedHost(context, []);
      },
    });
    await resumed.completion();
    expect(observed).toEqual({
      roleTimeout: 17,
      roleRecoveries: 4,
      roleGrace: 5,
      profileTimeout: 23,
      profileRecoveries: 2,
      profileGrace: 2,
    });
  });

  it("rejects unfinished and cleanup-unconfirmed guards before host construction", async () => {
    for (const kind of ["unfinished", "unconfirmed"] as const) {
      const { manifestPath, runId, log } = await completedRun();
      if (kind === "unfinished") {
        const requestId = endGuardRequestId({ runId, epoch: 1 });
        const startedRecord: EndGuardStartedRecord = {
          type: "end_guard_started",
          schema_version: 1,
          run_id: runId,
          attempt_id: "unfinished-attempt",
          supervision_id: "unfinished-supervision",
          request_id: requestId,
          role: "orchestrator",
          role_session_id: "unfinished-role-session",
          session_file: "/tmp/unfinished.jsonl",
          timeout_ms: 60_000,
          ts: 1,
        };
        log.append(startedRecord);
      } else {
        appendUnconfirmed(log, runId);
      }
      let constructed = false;
      await expect(
        resumeRun(manifestPath, runId, {
          goal: "",
          baseDir,
          hostFactory: (context) => {
            constructed = true;
            return guardedHost(context, []);
          },
        }),
      ).rejects.toThrow(/unknown ownership/);
      expect(constructed).toBe(false);
    }
  });

  it("resets exhausted ungated epochs and preserves partial budgets", async () => {
    const { manifestPath, runId, log } = await completedRun();
    const epochOne = endGuardRequestId({ runId, epoch: 1 });
    appendFailure(log, runId, epochOne, 1);
    appendFailure(log, runId, epochOne, 2);
    appendFailure(log, runId, epochOne, 3);

    let firstResumeReset = false;
    const first = await resumeRun(manifestPath, runId, {
      goal: "",
      baseDir,
      hostFactory: (context) => {
        firstResumeReset = context.log
          .records(runId)
          .some((record) => record.type === "end_guard_budget_reset" && record.epoch === 2);
        return guardedHost(context, []);
      },
    });
    await first.completion();
    expect(firstResumeReset).toBe(true);

    const epochTwo = endGuardRequestId({ runId, epoch: 2 });
    appendFailure(log, runId, epochTwo, 4);
    let secondReset = false;
    const second = await resumeRun(manifestPath, runId, {
      goal: "",
      baseDir,
      hostFactory: (context) => {
        secondReset = context.log
          .records(runId)
          .some((record) => record.type === "end_guard_budget_reset");
        return guardedHost(context, []);
      },
    });
    await second.completion();
    expect(secondReset).toBe(true);
    expect(
      new FileRecordLog({ baseDir })
        .records(runId)
        .filter((record) => record.type === "end_guard_finished" && record.request_id === epochTwo),
    ).toHaveLength(1);

    appendFailure(log, runId, epochTwo, 5);
    appendFailure(log, runId, epochTwo, 6);
    let thirdReset = false;
    const third = await resumeRun(manifestPath, runId, {
      goal: "",
      baseDir,
      hostFactory: (context) => {
        thirdReset = context.log
          .records(runId)
          .some((record) => record.type === "end_guard_budget_reset" && record.epoch === 3);
        return guardedHost(context, []);
      },
    });
    await third.completion();
    expect(thirdReset).toBe(true);
  });

  it("does not reset a gated exhausted request or launch another guard attempt", async () => {
    const gated = await completedRun(GATED_MANIFEST);
    const requestId = endGuardRequestId({
      runId: gated.runId,
      epoch: 1,
      ordinal: 0,
      role: "worker",
      file: "/tmp/worker-review.jsonl",
    });
    appendFailure(gated.log, gated.runId, requestId, 1);
    appendFailure(gated.log, gated.runId, requestId, 2);
    appendFailure(gated.log, gated.runId, requestId, 3);
    const gatedCheckpoint = gated.log.latestCheckpoint(gated.runId);
    if (gatedCheckpoint === null) throw new Error("expected gated checkpoint");
    gated.log.append({
      type: "checkpoint_snapshot",
      checkpoint: {
        ...gatedCheckpoint,
        current_role: "orchestrator",
        end_request: { role: "worker", session_file: "/tmp/worker-review.jsonl" },
        updated_at: Date.now(),
      },
    });
    let gatedReset = false;
    let guardRuns = 0;
    const gatedResume = await resumeRun(gated.manifestPath, gated.runId, {
      goal: "",
      baseDir,
      hostFactory: (context) => {
        gatedReset = context.log
          .records(gated.runId)
          .some((record) => record.type === "end_guard_budget_reset");
        const host = guardedHost(context, [
          { kind: "emit_end", reason: "same request" },
        ]) as Host & {
          runEndGuard: NonNullable<Host["runEndGuard"]>;
        };
        const runEndGuard = host.runEndGuard;
        host.runEndGuard = async (request) => {
          guardRuns += 1;
          return runEndGuard(request);
        };
        return host;
      },
    });
    const gatedResult = await gatedResume.completion();
    expect(gatedReset).toBe(false);
    expect(gatedResult.exitReason).toBe("session_failed");
    expect(guardRuns).toBe(0);

    const ungated = await completedRun();
    appendFailure(
      ungated.log,
      ungated.runId,
      endGuardRequestId({ runId: ungated.runId, epoch: 1 }),
      1,
    );
    let nullPendingReset = false;
    const nullPending = await resumeRun(ungated.manifestPath, ungated.runId, {
      goal: "",
      baseDir,
      hostFactory: (context) => {
        nullPendingReset = context.log
          .records(ungated.runId)
          .some((record) => record.type === "end_guard_budget_reset");
        return guardedHost(context, []);
      },
    });
    await nullPending.completion();
    expect(nullPendingReset).toBe(false);
  });

  it("repairs through a fresh worker request and uses a new gated budget identity", async () => {
    const gated = await completedRun(GATED_MANIFEST);
    const oldRequestId = endGuardRequestId({
      runId: gated.runId,
      epoch: 1,
      ordinal: 0,
      role: "worker",
      file: "/tmp/old-worker.jsonl",
    });
    appendFailure(gated.log, gated.runId, oldRequestId, 1);
    appendFailure(gated.log, gated.runId, oldRequestId, 2);
    appendFailure(gated.log, gated.runId, oldRequestId, 3);
    const checkpoint = gated.log.latestCheckpoint(gated.runId);
    if (checkpoint === null) throw new Error("expected gated checkpoint");
    gated.log.append({
      type: "checkpoint_snapshot",
      checkpoint: {
        ...checkpoint,
        current_role: "orchestrator",
        end_request: { role: "worker", session_file: "/tmp/old-worker.jsonl" },
        updated_at: Date.now(),
      },
    });

    const resumed = await resumeRun(gated.manifestPath, gated.runId, {
      goal: "",
      baseDir,
      hostFactory: (context) =>
        guardedHost(context, [
          { kind: "emit_handoff", target_role: "worker", reason: "repair" },
          {
            kind: "emit_tool_calls",
            calls: [
              {
                name: "handoff",
                arguments: {
                  target_role: "orchestrator",
                  status: "complete",
                  objective: "Approve the repaired workspace.",
                  summary: "The repaired workspace is ready.",
                  requested_action: "Complete the repaired run.",
                  request_end: true,
                },
              },
            ],
          },
          { kind: "emit_end", reason: "repaired" },
        ]),
    });
    const result = await resumed.completion();
    expect(result.exitReason).toBe("done");
    const requestIds = new FileRecordLog({ baseDir })
      .records(gated.runId)
      .filter((record): record is EndGuardFinishedRecord => record.type === "end_guard_finished")
      .map((record) => record.request_id);
    expect(requestIds).toHaveLength(4);
    expect(requestIds.slice(0, 3)).toEqual([oldRequestId, oldRequestId, oldRequestId]);
    const repairedRequestId = requestIds[3];
    expect(repairedRequestId).toBeDefined();
    expect(repairedRequestId).not.toBe(oldRequestId);
    expect(JSON.parse(repairedRequestId as string)[2]).toBe(1);
    expect(
      new FileRecordLog({ baseDir })
        .records(gated.runId)
        .some((record) => record.type === "end_guard_budget_reset"),
    ).toBe(false);
  });

  it("rejects a manifest/checkpoint version mismatch without resetting budget", async () => {
    const { manifestPath, runId, log } = await completedRun();
    const checkpoint = log.latestCheckpoint(runId);
    if (checkpoint === null) throw new Error("expected checkpoint");
    log.append({
      type: "checkpoint_snapshot",
      checkpoint: { ...checkpoint, manifest_version: "999" },
    } satisfies CheckpointSnapshot);
    appendFailure(log, runId, endGuardRequestId({ runId, epoch: 1 }), 1);
    let constructed = false;
    await expect(
      resumeRun(manifestPath, runId, {
        goal: "",
        baseDir,
        hostFactory: (context) => {
          constructed = true;
          return guardedHost(context, []);
        },
      }),
    ).rejects.toThrow(/manifest_version mismatch/);
    expect(constructed).toBe(false);
    expect(log.records(runId).some((record) => record.type === "end_guard_budget_reset")).toBe(
      false,
    );
  });
});
