import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as processIdentity from "../../src/host/execution/supervised-process-identity.js";
import {
  inspectToolExecutionCleanup,
  reconcileToolExecutionCleanup,
  type ToolExecutionCleanupInspection,
  type ToolExecutionReconciliationError,
} from "../../src/host/execution/tool-execution-reconciliation.js";
import { FileRecordLog } from "../../src/host/log-file.js";
import type {
  ToolExecutionFinishedRecord,
  ToolExecutionStartedRecord,
} from "../../src/persistence/tool-execution.js";

function executionRecords(
  runId: string,
  supervisionId: string,
): [ToolExecutionStartedRecord, ToolExecutionFinishedRecord] {
  const started: ToolExecutionStartedRecord = {
    type: "tool_execution_started",
    schema_version: 1,
    run_id: runId,
    execution_id: "execution-1",
    supervision_id: supervisionId,
    logical_session_id: "logical-1",
    role_session_id: "role-1",
    tool_call_id: "call-1",
    tool_name: "bash",
    timeout_ms: 1000,
    recovery_count: 0,
    ts: Date.now(),
  };
  return [
    started,
    {
      type: "tool_execution_finished",
      schema_version: 1,
      run_id: runId,
      execution_id: started.execution_id,
      supervision_id: supervisionId,
      logical_session_id: started.logical_session_id,
      role_session_id: started.role_session_id,
      tool_call_id: started.tool_call_id,
      tool_name: started.tool_name,
      elapsed_ms: 10,
      recovery_count: 0,
      outcome: "cleanup_unconfirmed",
      cleanup: "unconfirmed",
      ts: started.ts + 1,
    },
  ];
}

describe("tool execution reconciliation API", () => {
  it("rejects malformed run IDs before creating a run file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-conductor-reconcile-"));
    try {
      await expect(
        inspectToolExecutionCleanup("../escape", { baseDir: dir }),
      ).rejects.toMatchObject({
        code: "invalid_request",
      } satisfies Partial<ToolExecutionReconciliationError>);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses inspection while the run lease is held", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-conductor-reconcile-"));
    const log = new FileRecordLog({ baseDir: dir });
    // Seed a valid run file so the second caller reaches lease admission.
    log.append({ type: "run_seeded", run_id: "run-1", goal: "test", ts: Date.now() });
    const lease = await log.acquireRunLease("run-1");
    try {
      await expect(inspectToolExecutionCleanup("run-1", { baseDir: dir })).rejects.toMatchObject({
        code: "run-in-progress",
      });
    } finally {
      await lease.release();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses confirmation when the log has a torn trailing record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-conductor-reconcile-"));
    const log = new FileRecordLog({ baseDir: dir });
    log.append({ type: "run_seeded", run_id: "run-1", goal: "test", ts: Date.now() });
    const path = join(dir, "run-1.jsonl");
    const bytes = readFileSync(path, "utf8");
    await writeFile(path, `${bytes}{"type":"tool_execution_started"`, "utf8");
    await expect(
      reconcileToolExecutionCleanup("run-1", "execution-1", {
        baseDir: dir,
        acknowledgment: true,
        operatorNote: "inspected original host and effects",
      }),
    ).rejects.toMatchObject({ code: "incomplete_log" });
    await rm(dir, { recursive: true, force: true });
  });

  it("observes and then reconciles a test-owned marked process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-conductor-reconcile-"));
    const supervisionId = `reconcile-test-${process.pid}-${Date.now()}`;
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      env: { ...process.env, PI_CONDUCTOR_EXECUTION_ID: supervisionId },
      stdio: "ignore",
    });
    let restoreScan: (() => void) | undefined;
    try {
      const log = new FileRecordLog({ baseDir: dir });
      const [started, finished] = executionRecords("run-1", supervisionId);
      log.append({ type: "run_seeded", run_id: "run-1", goal: "test", ts: Date.now() });
      log.append(started);
      log.append(finished);
      const scan = vi
        .spyOn(processIdentity, "findProcessesByOwnerToken")
        .mockImplementation(async (token) => {
          const identity = await processIdentity.readProcessIdentity(child.pid ?? -1, token);
          return identity === null ? [] : [identity];
        });
      restoreScan = () => scan.mockRestore();
      const inspection: ToolExecutionCleanupInspection = await inspectToolExecutionCleanup(
        "run-1",
        { baseDir: dir },
      );
      expect(inspection.unresolved[0]?.currentProcesses.some((p) => p.pid === child.pid)).toBe(
        true,
      );
      const path = join(dir, "run-1.jsonl");
      const before = readFileSync(path, "utf8");
      await expect(
        reconcileToolExecutionCleanup("run-1", "execution-1", {
          baseDir: dir,
          acknowledgment: true,
          operatorNote: "Original namespaces and effects inspected; all processes stopped.",
        }),
      ).rejects.toMatchObject({ code: "live_processes" });
      expect(readFileSync(path, "utf8")).toBe(before);
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
      const confirmed = await reconcileToolExecutionCleanup("run-1", "execution-1", {
        baseDir: dir,
        acknowledgment: true,
        operatorNote: "Original namespaces and effects inspected; all processes stopped.",
      });
      expect(confirmed.cleanup).toBe("confirmed");
      const reopened = new FileRecordLog({ baseDir: dir }).records("run-1");
      expect(reopened.map((record) => record.type)).toContain("tool_execution_cleanup_confirmed");
      expect(reopened.map((record) => record.type)).toContain("tool_execution_finished");
    } finally {
      restoreScan?.();
      if (!child.killed) child.kill("SIGKILL");
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["false acknowledgment", { acknowledgment: false, operatorNote: "valid note" }],
    ["blank note", { acknowledgment: true, operatorNote: "   " }],
    ["overlong note", { acknowledgment: true, operatorNote: "x".repeat(1001) }],
  ] as const)("rejects %s without appending", async (_label, options) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-conductor-reconcile-"));
    try {
      const log = new FileRecordLog({ baseDir: dir });
      const [started, finished] = executionRecords("run-1", "never-marked");
      log.append({ type: "run_seeded", run_id: "run-1", goal: "test", ts: Date.now() });
      log.append(started);
      log.append(finished);
      const before = readFileSync(join(dir, "run-1.jsonl"), "utf8");
      await expect(
        reconcileToolExecutionCleanup("run-1", "execution-1", {
          ...options,
          baseDir: dir,
        } as never),
      ).rejects.toMatchObject({
        code: options.acknowledgment ? "invalid_request" : "acknowledgment_required",
      });
      expect(readFileSync(join(dir, "run-1.jsonl"), "utf8")).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
