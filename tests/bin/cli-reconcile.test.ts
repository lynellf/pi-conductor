import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/bin/cli-main.js";
import { RECONCILE_USAGE, runReconcileCli } from "../../src/bin/cli-reconcile.js";
import * as actionRepair from "../../src/host/controller/action-reconciliation.js";
import * as identity from "../../src/host/execution/supervised-process-identity.js";
import { FileRecordLog } from "../../src/host/log-file.js";
import type {
  ToolExecutionFinishedRecord,
  ToolExecutionStartedRecord,
} from "../../src/persistence/tool-execution.js";
import { sandboxReadyFixture } from "../host/fixtures/sandbox-ready-fixture.js";

function output() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    log: (...args: unknown[]) => lines.push(args.map(String).join(" ")),
    error: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
  };
}

function records(): { started: ToolExecutionStartedRecord; finished: ToolExecutionFinishedRecord } {
  return {
    started: {
      type: "tool_execution_started",
      schema_version: 1,
      run_id: "run-reconcile",
      execution_id: "execution-1",
      supervision_id: "supervision-never-live",
      logical_session_id: "logical-1",
      role_session_id: "role-1",
      tool_call_id: "call-1",
      tool_name: "bash",
      timeout_ms: 1_000,
      recovery_count: 0,
      ts: 10,
    },
    finished: {
      type: "tool_execution_finished",
      schema_version: 1,
      run_id: "run-reconcile",
      execution_id: "execution-1",
      supervision_id: "supervision-never-live",
      logical_session_id: "logical-1",
      role_session_id: "role-1",
      tool_call_id: "call-1",
      tool_name: "bash",
      elapsed_ms: 100,
      recovery_count: 0,
      outcome: "cleanup_unconfirmed",
      cleanup: "unconfirmed",
      ts: 20,
    },
  };
}

describe("reconcile-tools CLI", () => {
  it("requires action-effect acknowledgment and routes an explicit controller repair separately", async () => {
    const repair = vi.spyOn(actionRepair, "reconcileControllerActionEffects").mockResolvedValue([]);
    const out = output();
    const args = ["reconcile-tools", "--log-dir", "/private/runs", "run", "--action", "prepare"];
    expect(await runReconcileCli(args, out)).toBe(1);
    expect(repair).not.toHaveBeenCalled();
    expect(
      await runReconcileCli(
        [
          ...args,
          "--confirm-cleanup",
          "--note",
          "Inspected retained staging",
          "--partial-effects",
          "inspected_unpublished",
        ],
        out,
      ),
    ).toBe(0);
    expect(repair).toHaveBeenCalledWith("run", "prepare", {
      baseDir: "/private/runs",
      acknowledgment: true,
      operatorNote: "Inspected retained staging",
      partialEffects: "inspected_unpublished",
    });
  });
  const directories: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function fixture(): Promise<string> {
    vi.spyOn(identity, "findProcessesByOwnerToken").mockResolvedValue([]);
    const dir = await mkdtemp(join(tmpdir(), "pi-conductor-cli-reconcile-"));
    directories.push(dir);
    const log = new FileRecordLog({ baseDir: dir });
    const { started, finished } = records();
    log.append(started);
    log.append(finished);
    return dir;
  }

  it("inspects through runCli dispatch without appending", async () => {
    const dir = await fixture();
    const before = await readFile(join(dir, "run-reconcile.jsonl"), "utf8");
    const out = output();
    const code = await runCli(["reconcile-tools", "--log-dir", dir, "run-reconcile"], {
      console: { ...console, log: out.log, error: out.error },
      exit: () => {},
      cwd: process.cwd(),
      modelRegistry: {} as never,
      startRun: (() => undefined) as never,
    });
    expect(out.errors).toEqual([]);
    expect(code).toBe(0);
    expect(JSON.parse(out.lines[0] ?? "{}").unresolved).toHaveLength(1);
    await expect(readFile(join(dir, "run-reconcile.jsonl"), "utf8")).resolves.toBe(before);
  });

  it("inspects a selected sandbox without scanning unrelated legacy processes or mutating", async () => {
    const dir = await fixture();
    const log = new FileRecordLog({ baseDir: dir });
    log.append(sandboxReadyFixture("run-reconcile", "sandbox-execution").started);
    vi.mocked(identity.findProcessesByOwnerToken).mockRejectedValue(
      new Error("unrelated denied process"),
    );
    const before = await readFile(join(dir, "run-reconcile.jsonl"), "utf8");
    const out = output();
    expect(
      await runReconcileCli(
        ["reconcile-tools", "--log-dir", dir, "run-reconcile", "--execution", "sandbox-execution"],
        out,
      ),
    ).toBe(0);
    expect(out.errors).toEqual([]);
    const result = JSON.parse(out.lines[0] ?? "{}");
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]).toMatchObject({ sandbox: { status: "missing_ready" } });
    expect(identity.findProcessesByOwnerToken).not.toHaveBeenCalled();
    await expect(readFile(join(dir, "run-reconcile.jsonl"), "utf8")).resolves.toBe(before);
  });

  it("rejects an unknown targeted inspection without claiming cleanup or scanning", async () => {
    const dir = await fixture();
    const out = output();
    expect(
      await runReconcileCli(
        ["reconcile-tools", "--log-dir", dir, "run-reconcile", "--execution", "typo"],
        out,
      ),
    ).toBe(1);
    expect(out.errors.join("\n")).toContain("unknown or already clean");
    expect(out.lines).toEqual([]);
    expect(identity.findProcessesByOwnerToken).not.toHaveBeenCalled();
    expect(new FileRecordLog({ baseDir: dir }).records("run-reconcile")).toHaveLength(2);
  });

  it("appends confirmation for a dead-process fixture", async () => {
    const dir = await fixture();
    const out = output();
    const code = await runReconcileCli(
      [
        "reconcile-tools",
        "--log-dir",
        dir,
        "run-reconcile",
        "--execution",
        "execution-1",
        "--confirm-cleanup",
        "--note",
        "Inspected original host and effects; all processes are stopped.",
      ],
      out,
    );
    expect(out.errors).toEqual([]);
    expect(code).toBe(0);
    expect(JSON.parse(out.lines[0] ?? "{}")).toMatchObject({
      type: "tool_execution_cleanup_confirmed",
      execution_id: "execution-1",
      cleanup: "confirmed",
    });
    expect(new FileRecordLog({ baseDir: dir }).records("run-reconcile")).toHaveLength(3);
  });

  it("prints help successfully without filesystem or model dependencies", async () => {
    const out = output();
    expect(await runReconcileCli(["reconcile-tools", "--help"], out)).toBe(0);
    expect(out.lines.join("\n")).toMatch(/reconcile-tools/);
  });

  it.each([
    ["missing acknowledgment", ["--execution", "execution-1", "--note", "note"]],
    ["missing note", ["--execution", "execution-1", "--confirm-cleanup"]],
    ["unknown option", ["--wat"]],
    ["duplicate option", ["--confirm-cleanup", "--confirm-cleanup"]],
    ["missing value", ["--log-dir"]],
    ["operator typo", ["--operator", "someone"]],
  ] as const)("rejects %s without mutation", async (_name, args) => {
    const dir = await fixture();
    const before = await readFile(join(dir, "run-reconcile.jsonl"), "utf8");
    const out = output();
    expect(
      await runReconcileCli(["reconcile-tools", "--log-dir", dir, "run-reconcile", ...args], out),
    ).toBe(1);
    expect(out.errors).toEqual([RECONCILE_USAGE]);
    await expect(readFile(join(dir, "run-reconcile.jsonl"), "utf8")).resolves.toBe(before);
  });

  it("explains that a permission-denied environment read does not prove service ownership", async () => {
    const dir = await fixture();
    vi.mocked(identity.findProcessesByOwnerToken).mockRejectedValue(
      new identity.ProcessObservationError("read_environ", { code: "EACCES" }, 123, {
        startTime: "98765",
        processGroupId: 120,
      }),
    );

    const out = output();
    expect(await runReconcileCli(["reconcile-tools", "--log-dir", dir, "run-reconcile"], out)).toBe(
      1,
    );
    const diagnostic = out.errors.join("\n");
    expect(diagnostic).toContain(
      "A service association from PPID, cgroup, or systemd MainPID is not lifecycle proof",
    );
    expect(diagnostic).toContain("tool_execution_started.admission.preexisting_before");
    expect(diagnostic).toContain("socket-activated external service or an escaped descendant");
  });

  it("returns nonzero and does not mutate for an unknown run", async () => {
    const dir = await fixture();
    const out = output();
    expect(await runReconcileCli(["reconcile-tools", "--log-dir", dir, "typo-run"], out)).toBe(1);
    expect(new FileRecordLog({ baseDir: dir }).records("run-reconcile")).toHaveLength(2);
    expect(out.errors.join("\n")).not.toContain("Usage:");
  });

  it.each([
    ["read_environ", "EACCES", 123, { startTime: "98765", processGroupId: 120 }],
    ["read_status", "EPERM", 123, undefined],
    ["read_stat", "EIO", 123, undefined],
    ["list_processes", "EACCES", undefined, undefined],
  ] as const)("reports safe %s evidence and recovery steps", async (operation, code, pid, details) => {
    const dir = await fixture();
    const before = await readFile(join(dir, "run-reconcile.jsonl"), "utf8");
    const error = new identity.ProcessObservationError(operation, { code }, pid, details);
    Object.assign(error, {
      message: "PRIVATE raw error",
      stack: "PRIVATE stack",
      ownerToken: "PRIVATE marker",
      environ: "PRIVATE credentials",
      command: "PRIVATE arguments",
    });
    vi.mocked(identity.findProcessesByOwnerToken).mockRejectedValue(error);
    const out = output();
    expect(await runReconcileCli(["reconcile-tools", "--log-dir", dir, "run-reconcile"], out)).toBe(
      1,
    );
    const diagnostic = out.errors.join("\n");
    expect(diagnostic).toContain(`operation=${operation}`);
    expect(diagnostic).toContain(`code=${code}`);
    if (pid !== undefined) {
      expect(diagnostic).toContain(`pid=${pid}`);
      expect(diagnostic).toContain(`ps -p ${pid} -o pid=,ppid=,pgid=,sid=,uid=,stat=`);
    } else {
      expect(diagnostic).not.toContain("ps -p");
    }
    if (details !== undefined) {
      expect(diagnostic).toContain(`start_time=${details.startTime}`);
      expect(diagnostic).toContain(`process_group_id=${details.processGroupId}`);
    }
    expect(diagnostic).toContain("ownership is unverified");
    expect(diagnostic).toContain("original Linux host");
    expect(diagnostic).toContain("conduct reconcile-tools --log-dir <path> <run-id>");
    expect(diagnostic).not.toContain("PRIVATE");
    expect(diagnostic).not.toContain("Usage:");
    expect(out.lines).toEqual([]);
    await expect(readFile(join(dir, "run-reconcile.jsonl"), "utf8")).resolves.toBe(before);
    vi.mocked(identity.findProcessesByOwnerToken).mockResolvedValue([]);
    expect(
      await runReconcileCli(["reconcile-tools", "--log-dir", dir, "run-reconcile"], output()),
    ).toBe(0);
  });

  it("keeps confirmation blocked and the log untouched when observation fails", async () => {
    const dir = await fixture();
    const before = await readFile(join(dir, "run-reconcile.jsonl"), "utf8");
    vi.mocked(identity.findProcessesByOwnerToken).mockRejectedValue(
      new identity.ProcessObservationError("read_environ", { code: "EACCES" }, 123),
    );
    const out = output();
    expect(
      await runReconcileCli(
        [
          "reconcile-tools",
          "--log-dir",
          dir,
          "run-reconcile",
          "--execution",
          "execution-1",
          "--confirm-cleanup",
          "--note",
          "operator note",
        ],
        out,
      ),
    ).toBe(1);
    expect(out.errors.join("\n")).toContain("Cleanup remains unconfirmed");
    expect(out.errors.join("\n")).toContain("Omit --execution, --confirm-cleanup, and --note.");
    expect(out.lines).toEqual([]);
    await expect(readFile(join(dir, "run-reconcile.jsonl"), "utf8")).resolves.toBe(before);
    vi.mocked(identity.findProcessesByOwnerToken).mockResolvedValue([]);
    const retry = output();
    expect(
      await runReconcileCli(["reconcile-tools", "--log-dir", dir, "run-reconcile"], retry),
    ).toBe(0);
    expect(retry.errors).toEqual([]);
    await expect(readFile(join(dir, "run-reconcile.jsonl"), "utf8")).resolves.toBe(before);
  });

  it("omits malformed process fields rather than rendering unsafe identity text", async () => {
    const dir = await fixture();
    const error = new identity.ProcessObservationError(
      "read_stat",
      { code: "PRIVATE_SECRET" },
      -1,
      {
        startTime: "PRIVATE\nstart",
        processGroupId: Number.NaN,
      },
    );
    vi.mocked(identity.findProcessesByOwnerToken).mockRejectedValue(error);
    const out = output();
    expect(await runReconcileCli(["reconcile-tools", "--log-dir", dir, "run-reconcile"], out)).toBe(
      1,
    );
    const diagnostic = out.errors.join("\n");
    expect(diagnostic).toContain("code=UNKNOWN");
    expect(diagnostic).not.toMatch(/PRIVATE|NaN|pid=-1|start_time=|ps -p/);
  });
});
