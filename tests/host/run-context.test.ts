import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileRecordLog } from "../../src/host/log-file.js";
import {
  type Host,
  type HostFactoryContext,
  type PersistedRecord,
  resumeRun,
  StubHost,
  startRun,
  subscribeToRecords,
} from "../../src/index.js";

const MANIFEST = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    system_prompt: roles/orchestrator.md
`;

function hostFactory({ runId, log, loadedManifest }: HostFactoryContext): Host {
  return new StubHost({
    runId,
    log,
    loadedManifest,
    steps: [{ kind: "emit_end", reason: "test complete" }],
  });
}

describe("run_context telemetry", () => {
  let workdir: string;
  let manifestPath: string;
  let baseDir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "pi-conductor-run-context-"));
    await mkdir(join(workdir, "roles"), { recursive: true });
    manifestPath = join(workdir, "manifest.yaml");
    baseDir = join(workdir, "runs");
    await writeFile(manifestPath, MANIFEST, "utf8");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("persists one context record with the trimmed, multiline goal", async () => {
    const delivered: PersistedRecord[] = [];
    const unsubscribe = subscribeToRecords((record) => {
      delivered.push(record);
    });

    try {
      const handle = await startRun(manifestPath, {
        goal: '  Ship the "report" & review\nwith the appendix  ',
        baseDir,
        hostFactory,
      });
      await handle.completion();

      const records = new FileRecordLog({ baseDir }).records(handle.runId);
      const contexts = records.filter((record) => record.type === "run_context");
      expect(contexts).toHaveLength(1);
      expect(contexts[0]).toMatchObject({
        type: "run_context",
        run_id: handle.runId,
        original_prompt: 'Ship the "report" & review\nwith the appendix',
      });
      expect(typeof contexts[0]?.ts).toBe("number");

      const deliveredTypes = delivered
        .filter(
          (record): record is Exclude<PersistedRecord, { type: "checkpoint_snapshot" }> =>
            record.type !== "checkpoint_snapshot" && record.run_id === handle.runId,
        )
        .map((record) => record.type);
      expect(deliveredTypes[0]).toBe("run_context");
      expect(deliveredTypes).toContain("session_started");
    } finally {
      unsubscribe();
    }
  });

  it("does not emit a second context record when resuming", async () => {
    const started = await startRun(manifestPath, {
      goal: "finish the release",
      baseDir,
      hostFactory,
    });
    await started.completion();

    const resumed = await resumeRun(manifestPath, started.runId, {
      goal: "ignored fallback",
      baseDir,
      hostFactory,
    });
    await resumed.completion();

    const records = new FileRecordLog({ baseDir }).records(started.runId);
    expect(records.filter((record) => record.type === "run_context")).toHaveLength(1);
    expect(records.filter((record) => record.type === "run_seeded")).toHaveLength(1);
  });

  it("keeps the public PersistedRecord union assignable for context records", () => {
    const record: PersistedRecord = {
      type: "run_context",
      run_id: "run-1",
      ts: 1786219200000,
      original_prompt: "Ship the report",
    };
    expect(record.type).toBe("run_context");
  });
});
