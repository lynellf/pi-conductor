import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runReconcileCli } from "../../src/bin/cli-reconcile.js";
import { FileRecordLog } from "../../src/host/log-file.js";

it("does not hide interrupted baseline calls or accept a cleanup acknowledgment", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "baseline-reconcile-"));
  try {
    const log = new FileRecordLog({ baseDir });
    log.append({
      type: "baseline_execution_started",
      schema_version: 1,
      execution_tier: "baseline",
      run_id: "run",
      logical_session_id: "logical",
      role_session_id: "physical",
      execution_id: "execution",
      tool_call_id: "call",
      tool_name: "bash",
      timeout_ms: 1000,
      ts: 1,
    });
    const output = { log: vi.fn(), error: vi.fn() };
    expect(await runReconcileCli(["reconcile-tools", "--log-dir", baseDir, "run"], output)).toBe(1);
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining("baseline"));
    expect(
      await runReconcileCli(
        [
          "reconcile-tools",
          "--log-dir",
          baseDir,
          "run",
          "--execution",
          "execution",
          "--confirm-cleanup",
          "--note",
          "inspected",
        ],
        output,
      ),
    ).toBe(1);
    expect(log.records("run")).toHaveLength(1);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
