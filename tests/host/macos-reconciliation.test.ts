import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureToolAdmission,
  restoreToolAdmission,
} from "../../src/host/execution/tool-admission.js";
import {
  inspectToolExecutionCleanup,
  reconcileToolExecutionCleanup,
} from "../../src/host/execution/tool-execution-reconciliation.js";
import { FileRecordLog } from "../../src/host/log-file.js";
import type { ToolExecutionStartedRecord } from "../../src/persistence/tool-execution.js";

describe.runIf(process.platform === "darwin")("Darwin original-evidence recovery", () => {
  it("inspects and explicitly confirms absent owned processes without replacing the baseline", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "pi-conductor-macos-reconcile-"));
    try {
      const admission = await captureToolAdmission();
      const started: ToolExecutionStartedRecord = {
        type: "tool_execution_started",
        schema_version: 1,
        run_id: "run",
        execution_id: "execution",
        supervision_id: randomUUID(),
        logical_session_id: "logical",
        role_session_id: "role",
        tool_call_id: "call",
        tool_name: "bash",
        timeout_ms: 1_000,
        recovery_count: 0,
        ts: Date.now(),
        admission,
      };
      new FileRecordLog({ baseDir }).append(started);
      const path = join(baseDir, "run.jsonl");
      const original = await readFile(path, "utf8");
      const inspection = await inspectToolExecutionCleanup("run", { baseDir });
      expect(inspection.currentProcesses).toEqual([]);
      expect(await readFile(path, "utf8")).toBe(original);
      const confirmation = await reconcileToolExecutionCleanup("run", "execution", {
        baseDir,
        acknowledgment: true,
        operatorNote: "Inspected original processes and partial effects; no workload was launched.",
      });
      expect(confirmation.type).toBe("tool_execution_cleanup_confirmed");
      expect((await readFile(path, "utf8")).startsWith(original)).toBe(true);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("rejects malformed session witnesses rather than reconstructing them from current state", async () => {
    const admission = await captureToolAdmission();
    if (admission.schema_version !== 2) throw new Error("expected Darwin origin");
    const witness = admission.preexisting_sessions[0];
    if (witness === undefined) throw new Error("expected an original session witness");
    await expect(
      restoreToolAdmission({
        ...admission,
        preexisting_sessions: [{ ...witness, session_id: witness.pid + 1 }],
      }),
    ).rejects.toMatchObject({ code: "admission_evidence_invalid" });
    await expect(
      restoreToolAdmission({ ...admission, preexisting_sessions: [witness, witness] }),
    ).rejects.toMatchObject({ code: "admission_evidence_invalid" });
  });
});
