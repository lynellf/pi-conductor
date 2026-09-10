/** Issue #104: real file-worker observation must progress with a large status log. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createInitialCheckpoint } from "../../src/core/reduce.js";
import { startStatusPoller } from "../../src/extension/status.js";
import { runFileToolWorker } from "../../src/host/execution/file-tool-worker.js";
import { FileRecordLog } from "../../src/host/log-file.js";
import { loadManifestFromString } from "../../src/host/manifest.js";
import { RunHandle } from "../../src/host/run-handle.js";
import type { PersistedRecord } from "../../src/persistence/log.js";

it("finishes a read with normal status polling over 2,001 validated records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conductor-status-progress-"));
  const loadedManifest = loadManifestFromString(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [read, handoff, end]
`);
  const checkpoint = createInitialCheckpoint(loadedManifest.def);
  const runId = checkpoint.run_id;
  const records: PersistedRecord[] = [{ type: "checkpoint_snapshot", checkpoint }];
  for (let index = 0; index < 1_000; index++) {
    const identity = {
      schema_version: 1 as const,
      run_id: runId,
      execution_id: `execution-${index}`,
      supervision_id: `supervision-${index}`,
      logical_session_id: "logical",
      role_session_id: "role",
      tool_call_id: `call-${index}`,
      tool_name: "read",
      recovery_count: 0,
    };
    records.push(
      { ...identity, type: "tool_execution_started", timeout_ms: 10_000, ts: index * 2 },
      {
        ...identity,
        type: "tool_execution_finished",
        outcome: "completed",
        cleanup: "confirmed",
        elapsed_ms: 1,
        ts: index * 2 + 1,
      },
    );
  }
  let stop: (() => void) | undefined;
  try {
    await writeFile(
      join(directory, `${runId}.jsonl`),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    await writeFile(join(directory, "sample.txt"), "worker progress\n");
    const handle = new RunHandle({
      runId,
      def: loadedManifest.def,
      log: new FileRecordLog({ baseDir: directory }),
      loadedManifest,
      configOverrideContainer: { current: {} },
      requestAbort: async () => undefined,
      completionPromise: new Promise(() => undefined),
    });
    stop = startStatusPoller(handle, () => undefined);
    const result = await runFileToolWorker({
      toolName: "read",
      toolCallId: "progress-probe",
      params: { path: "sample.txt" },
      cwd: directory,
      supervision: {
        executionId: `progress-${runId}`,
        timeoutMs: 8_000,
        graceMs: 200,
        onStart: () => undefined,
      },
    });
    expect(result.content).toEqual([{ type: "text", text: "worker progress\n" }]);
  } finally {
    stop?.();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
