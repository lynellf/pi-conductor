/**
 * File-backed persistence.
 *
 * Original coverage (issue #22 / PR #31):
 *  - normalizes an older checkpoint snapshot without `end_request`
 *    (exercises `normalizeCheckpoint` in `latestCheckpoint`)
 *  - replays `file_mutation` records without losing file telemetry.
 *
 * Issue #37, Finding 1 (HIGH) — torn-log recovery + typed boundary:
 *  - recovers the latest checkpoint when the trailing JSONL record is torn
 *    (crash mid-`appendFileSync`, §11.1)
 *  - throws a typed `RecordLogError` (not a raw `SyntaxError`) for a
 *    malformed non-trailing record
 *  - throws `RecordLogError` for an unknown record `type` (schema drift),
 *    mirroring `ManifestParseError`.
 */

import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Checkpoint } from "../../src/core/types.js";
import { type FileMutationRecord, FileRecordLog, RecordLogError } from "../../src/index.js";

let baseDir: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (baseDir !== undefined) {
    await rm(baseDir, { force: true, recursive: true });
    baseDir = undefined;
  }
});

function checkpoint(runId: string): Checkpoint {
  return {
    run_id: runId,
    manifest_version: "1",
    current_role: "orchestrator",
    visit_count: Object.freeze({}),
    end_request: null,
    active_role_session: null,
    updated_at: 1,
  };
}

describe("FileRecordLog", () => {
  it("normalizes an older checkpoint snapshot without end_request", async () => {
    baseDir = await mkdtemp(join(tmpdir(), "conductor-file-record-log-"));
    const log = new FileRecordLog({ baseDir });
    const legacyCheckpoint = {
      run_id: "legacy-run",
      manifest_version: "1",
      current_role: "orchestrator",
      visit_count: {},
      active_role_session: null,
      updated_at: 0,
    } as Checkpoint;
    log.append({ type: "checkpoint_snapshot", checkpoint: legacyCheckpoint });

    expect(log.latestCheckpoint("legacy-run")?.end_request).toBeNull();
  });

  it("replays file-mutation records without losing file telemetry", async () => {
    baseDir = await mkdtemp(join(tmpdir(), "conductor-file-record-log-"));
    const log = new FileRecordLog({ baseDir });
    const record: FileMutationRecord = {
      type: "file_mutation",
      run_id: "run-22",
      role: "worker",
      session_id: "session-22",
      session_file: "/tmp/session-22.jsonl",
      tool_name: "write",
      files: [
        {
          path: "/app/config.ts",
          additions: 11,
          deletions: 0,
          hunks: [{ lineNumber: 1, content: "+const x = 1", kind: "add" }],
        },
      ],
      ts: 1_700_000_000_000,
    };

    log.append(record);

    expect(log.records("run-22")).toEqual([record]);
  });
});

describe("FileRecordLog (issue #37 — torn-log recovery + typed boundary)", () => {
  it("recovers the latest checkpoint when the trailing JSONL record is torn", () => {
    baseDir = mkdtempSync(join(tmpdir(), "pi-conductor-log-"));
    const runId = "run-1";
    const path = join(baseDir, `${runId}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({ type: "checkpoint_snapshot", checkpoint: checkpoint(runId) })}\n`,
      "utf8",
    );
    // Append a half-written record with NO trailing newline — this is the
    // line that was being written when the process died (§11.1 crash case).
    appendFileSync(path, '{"type":"checkpoint_snap', "utf8");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = new FileRecordLog({ baseDir });

    expect(log.latestCheckpoint(runId)).toEqual(checkpoint(runId));
    expect(log.records(runId)).toHaveLength(1);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("torn"));
  });

  it("throws RecordLogError for a malformed non-trailing record", () => {
    baseDir = mkdtempSync(join(tmpdir(), "pi-conductor-log-"));
    const runId = "run-1";
    // A torn line in the MIDDLE of the file is a hard error, not a crash
    // artifact — it is genuine corruption.
    writeFileSync(
      join(baseDir, `${runId}.jsonl`),
      '{"type":"checkpoint_snap\n{"type":"run_seeded","run_id":"run-1","goal":"goal","ts":1}\n',
      "utf8",
    );
    const log = new FileRecordLog({ baseDir });

    expect(() => log.records(runId)).toThrow(RecordLogError);
    try {
      log.records(runId);
    } catch (error) {
      expect(error).toBeInstanceOf(RecordLogError);
      expect(error).toMatchObject({ runId, line: 1 });
      expect((error as RecordLogError).cause).toBeInstanceOf(SyntaxError);
    }
  });

  it("throws RecordLogError for an unknown persisted record type (schema drift)", () => {
    baseDir = mkdtempSync(join(tmpdir(), "pi-conductor-log-"));
    const runId = "run-1";
    writeFileSync(
      join(baseDir, `${runId}.jsonl`),
      '{"type":"future_record","run_id":"run-1"}\n',
      "utf8",
    );
    const log = new FileRecordLog({ baseDir });

    expect(() => log.records(runId)).toThrow(RecordLogError);
    expect(() => log.records(runId)).toThrow(/Unknown persisted record type/);
  });
});
