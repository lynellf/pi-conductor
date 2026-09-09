import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import * as processIdentity from "../../src/host/execution/supervised-process-identity.js";
import {
  assertNoUnfinishedToolExecutions,
  ToolExecutionController,
} from "../../src/host/execution/tool-execution-controller.js";
import { FileRecordLog } from "../../src/host/log-file.js";
import { reconcileToolExecutionCleanup, resumeRun, StubHost, startRun } from "../../src/index.js";
import { DEFAULT_TOOL_EXECUTION_POLICY } from "../../src/manifest/execution-policy.js";
import {
  isToolExecutionRecord,
  type ToolExecutionRecord,
} from "../../src/persistence/tool-execution.js";

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const manifest = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end]
`;

describe("issue 97 disk-backed restart recovery", () => {
  it("rejects legacy unconfirmed work, then resumes fresh work after audited confirmation", async () => {
    // The fixture has no real owner marker; process identity behavior is
    // covered by the dedicated reconciliation tests.
    vi.spyOn(processIdentity, "findProcessesByOwnerToken").mockResolvedValue([]);
    const directory = mkdtempSync(join(tmpdir(), "pi-conductor-issue-97-restart-"));
    directories.push(directory);
    const workdir = mkdtempSync(join(tmpdir(), "pi-conductor-issue-97-work-"));
    directories.push(workdir);
    const manifestPath = join(workdir, "conductor.yaml");
    writeFileSync(manifestPath, manifest, "utf8");

    const first = await startRun(manifestPath, {
      goal: "recover executable work",
      baseDir: directory,
      hostFactory: ({ runId, log, loadedManifest }) =>
        new StubHost({
          runId,
          log,
          loadedManifest,
          steps: [{ kind: "fail", errorMessage: "simulated process restart" }],
        }),
    });
    const firstResult = await first.completion();
    expect(firstResult.finalCheckpoint.current_role).toBe("orchestrator");
    expect(firstResult.exitReason).toBe("session_failed");

    const log = new FileRecordLog({ baseDir: directory });
    const started: ToolExecutionRecord = {
      type: "tool_execution_started",
      schema_version: 1,
      run_id: first.runId,
      execution_id: "execution-legacy",
      supervision_id: "supervision-legacy",
      logical_session_id: "logical-legacy",
      role_session_id: "role-legacy",
      tool_call_id: "call-original",
      tool_name: "write",
      timeout_ms: 1_000,
      recovery_count: 0,
      ts: 10,
    };
    const finished: ToolExecutionRecord = {
      type: "tool_execution_finished",
      schema_version: 1,
      run_id: first.runId,
      execution_id: started.execution_id,
      supervision_id: started.supervision_id,
      logical_session_id: started.logical_session_id,
      role_session_id: started.role_session_id,
      tool_call_id: started.tool_call_id,
      tool_name: started.tool_name,
      elapsed_ms: 1,
      recovery_count: 0,
      outcome: "cleanup_unconfirmed",
      cleanup: "unconfirmed",
      ts: 11,
    };
    log.append(started);
    log.append(finished);

    await expect(
      resumeRun(manifestPath, first.runId, {
        goal: "recover executable work",
        baseDir: directory,
        hostFactory: ({ runId, log: resumedLog, loadedManifest }) =>
          new StubHost({
            runId,
            log: resumedLog,
            loadedManifest,
            steps: [{ kind: "emit_end", reason: "unexpected replay" }],
          }),
      }),
    ).rejects.toThrow(/execution_id=execution-legacy/);

    await reconcileToolExecutionCleanup(first.runId, started.execution_id, {
      baseDir: directory,
      acknowledgment: true,
      operatorNote:
        "stopped all original processes, inspected the original host and PID namespace, and reviewed partial effects; no owner marker remains",
    });

    const sessionsBeforeResume = log
      .records(first.runId)
      .filter((record) => record.type === "session_started").length;
    let freshOperationCount = 0;
    const resumed = await resumeRun(manifestPath, first.runId, {
      goal: "recover executable work",
      baseDir: directory,
      hostFactory: ({ runId, log: resumedLog, loadedManifest }) => {
        const host = new StubHost({
          runId,
          log: resumedLog,
          loadedManifest,
          steps: [{ kind: "emit_end", reason: "no automatic replay" }],
        });
        const spawnRole = host.spawnRole.bind(host);
        host.spawnRole = async (role, options) => {
          if (freshOperationCount === 0) {
            const priorRecords = resumedLog.records(first.runId).filter(isToolExecutionRecord);
            assertNoUnfinishedToolExecutions(priorRecords);
            const controller = new ToolExecutionController({
              runId: first.runId,
              logicalSessionId: "logical-fresh",
              roleSessionId: "role-fresh",
              policy: { ...DEFAULT_TOOL_EXECUTION_POLICY, timeout_seconds: 1 },
              persist: (record) => resumedLog.append(record),
              priorRecords,
              idFactory: (() => {
                let next = 0;
                return () => `fresh-${++next}`;
              })(),
            });
            await expect(
              controller.run("read", "call-fresh", async () => "fresh-result"),
            ).resolves.toBe("fresh-result");
            freshOperationCount += 1;
          }
          return spawnRole(role, options);
        };
        return host;
      },
    });
    await resumed.completion();
    expect(freshOperationCount).toBe(1);
    const finalRecords = log.records(first.runId);
    expect(finalRecords.filter((record) => record.type === "session_started")).toHaveLength(
      sessionsBeforeResume + 1,
    );
    const finalToolRecords = finalRecords.filter(isToolExecutionRecord);
    expect(
      finalToolRecords.filter((record) => record.tool_call_id === "call-original"),
    ).toHaveLength(3);
    expect(finalToolRecords.filter((record) => record.tool_call_id === "call-fresh")).toHaveLength(
      2,
    );
  });
});
