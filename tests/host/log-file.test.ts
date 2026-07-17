/** File-backed persistence preserves issue #22 file-mutation records. */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { type FileMutationRecord, FileRecordLog } from "../../src/index.js";

let baseDir: string | undefined;

afterEach(async () => {
  if (baseDir !== undefined) {
    await rm(baseDir, { force: true, recursive: true });
    baseDir = undefined;
  }
});

describe("FileRecordLog", () => {
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
