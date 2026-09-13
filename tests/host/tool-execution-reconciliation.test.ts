import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as sandboxRecovery from "../../src/host/execution/sandbox/recovery.js";
import * as processIdentity from "../../src/host/execution/supervised-process-identity.js";
import { captureToolAdmission } from "../../src/host/execution/tool-admission.js";
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
import {
  isToolExecutionRecord,
  reconstructToolExecutionTimeline,
} from "../../src/persistence/tool-execution.js";
import { sandboxReadyFixture } from "./fixtures/sandbox-ready-fixture.js";

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
  it("confirms one sandbox without scanning or clearing a legacy sibling execution", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-conductor-reconcile-mixed-"));
    const { started, ready } = sandboxReadyFixture();
    const scan = vi
      .spyOn(processIdentity, "findProcessesByOwnerToken")
      .mockRejectedValue(new Error("unrelated inaccessible process"));
    const inspect = sandboxRecovery.inspectSandboxCleanup;
    const observer = structuredClone(ready.host_observer);
    observer.process.pid = 99;
    observer.process.nspid = [99];
    const sandbox = vi.spyOn(sandboxRecovery, "inspectSandboxCleanup").mockImplementation((entry) =>
      inspect(entry, {
        origin: async () => ({ bootId: ready.boot_id, observer }),
        classify: async () => "missing",
        observe: async () => {
          throw new Error("missing process must not be inspected");
        },
      }),
    );
    try {
      const log = new FileRecordLog({ baseDir: dir });
      const [legacy] = executionRecords("run", "legacy-supervision");
      log.append({ ...legacy, execution_id: "legacy" });
      log.append(started);
      log.append(ready);
      const view = await inspectToolExecutionCleanup("run", {
        baseDir: dir,
        executionId: "execution",
      });
      expect(view.unresolved).toHaveLength(1);
      expect(view.unresolved[0]?.sandbox?.status).toBe("attestation_required");
      const confirmation = await reconcileToolExecutionCleanup("run", "execution", {
        baseDir: dir,
        acknowledgment: true,
        operatorNote: "Inspected original processes, writers, and partial effects.",
      });
      expect(confirmation.verification).toBe("operator_confirmed_sandbox_cleanup");
      expect(scan).not.toHaveBeenCalled();
      const timeline = reconstructToolExecutionTimeline(
        new FileRecordLog({ baseDir: dir }).records("run").filter(isToolExecutionRecord),
      );
      expect(timeline.unresolved.map((entry) => entry.started.execution_id)).toEqual(["legacy"]);
      expect(
        timeline.entries.find((entry) => entry.started.execution_id === "execution")?.finished,
      ).toBeUndefined();
    } finally {
      sandbox.mockRestore();
      scan.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never applies marker-based cleanup to a sandbox execution", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-conductor-reconcile-sandbox-"));
    const scan = vi.spyOn(processIdentity, "findProcessesByOwnerToken").mockResolvedValue([]);
    try {
      const log = new FileRecordLog({ baseDir: dir });
      const [started] = executionRecords("sandbox-run", "sandbox-supervision");
      log.append({
        ...started,
        sandbox: {
          child_id: "child",
          descriptor: {
            backend: "bubblewrap",
            execution_policy_digest: "a".repeat(64),
            runtime_digest: "b".repeat(64),
            materialization_id: "materialization",
          },
        },
      });
      const path = join(dir, "sandbox-run.jsonl");
      const before = readFileSync(path, "utf8");
      await expect(
        inspectToolExecutionCleanup("sandbox-run", { baseDir: dir }),
      ).resolves.toMatchObject({
        unresolved: [{ sandbox: { status: "missing_ready" } }],
        currentProcesses: [],
      });
      await expect(
        reconcileToolExecutionCleanup("sandbox-run", started.execution_id, {
          baseDir: dir,
          acknowledgment: true,
          operatorNote: "test",
        }),
      ).rejects.toMatchObject({ code: "sandbox_cleanup_unconfirmed" });
      expect(scan).not.toHaveBeenCalled();
      expect(readFileSync(path, "utf8")).toBe(before);
    } finally {
      scan.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a different admission origin without scanning or changing the log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-conductor-reconcile-origin-"));
    const scan = vi.spyOn(processIdentity, "findProcessesByOwnerToken").mockResolvedValue([]);
    try {
      const log = new FileRecordLog({ baseDir: dir });
      const [started, finished] = executionRecords("run-origin", "origin-token");
      const admission = {
        ...(await captureToolAdmission()),
        boot_id: "00000000-0000-0000-0000-000000000000",
      };
      log.append({ ...started, admission });
      log.append(finished);
      const path = join(dir, "run-origin.jsonl");
      const before = readFileSync(path, "utf8");
      await expect(
        inspectToolExecutionCleanup("run-origin", { baseDir: dir }),
      ).rejects.toMatchObject({ code: "admission_origin_mismatch" });
      await expect(
        reconcileToolExecutionCleanup("run-origin", started.execution_id, {
          baseDir: dir,
          acknowledgment: true,
          operatorNote: "synthetic fixture",
        }),
      ).rejects.toMatchObject({ code: "admission_origin_mismatch" });
      expect(scan).not.toHaveBeenCalled();
      expect(readFileSync(path, "utf8")).toBe(before);
    } finally {
      scan.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

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
