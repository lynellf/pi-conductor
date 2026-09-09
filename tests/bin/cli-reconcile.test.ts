import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { runReconcileCli } from "../../src/bin/cli-reconcile.js";
import { runCli } from "../../src/bin/conduct.js";
import * as identity from "../../src/host/execution/supervised-process-identity.js";
import { FileRecordLog } from "../../src/host/log-file.js";
import type {
  ToolExecutionFinishedRecord,
  ToolExecutionStartedRecord,
} from "../../src/persistence/tool-execution.js";

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
    await expect(readFile(join(dir, "run-reconcile.jsonl"), "utf8")).resolves.toBe(before);
  });

  it("returns nonzero and does not mutate for an unknown run", async () => {
    const dir = await fixture();
    const out = output();
    expect(await runReconcileCli(["reconcile-tools", "--log-dir", dir, "typo-run"], out)).toBe(1);
    expect(new FileRecordLog({ baseDir: dir }).records("run-reconcile")).toHaveLength(2);
  });
});
