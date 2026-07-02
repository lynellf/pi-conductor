/**
 * File-backed `RecordLog` — spec §11.1, plan Task 13.5.
 *
 * One JSONL file per `run_id` under `baseDir/<run_id>.jsonl`. Each
 * line is a single JSON-encoded `PersistedRecord`. Append-only;
 * line ordering is preserved within a single `run_id`.
 *
 * ## Sync writes for the test surface (v1)
 *
 * The interface inherits the sync `append(record): void` signature
 * from `RecordLog` (Phase 3 Task 12). The file-backed impl uses
 * `fs.appendFileSync` so the call site stays synchronous — the
 * loop's `host.persistRecord(record)` doesn't need `await`.
 *
 * This is acceptable for the Phase 4 test surface (small files,
 * few records). Production's persistent log (Phase 5, beyond
 * Task 13.5) can be backed by an async tail/append pattern, an
 * embedded store like SQLite, or an external log service if scale
 * demands it. The `RecordLog` interface is preserved across all
 * impls so the swap is transparent to the loop.
 *
 * ## Crash semantics
 *
 * Append-only means a crashed run's records are intact on disk
 * and recoverable by `resumeRun`. `latestCheckpoint(runId)` walks
 * the file in reverse to find the last `checkpoint_snapshot`
 * without replaying events — per §11.1 ("the snapshot *is* the
 * state").
 *
 * The base directory is created on construction (idempotent
 * `mkdirSync({ recursive: true })`).
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Checkpoint } from "../core/types.js";
import type { PersistedRecord, RecordLog } from "../persistence/log.js";

export interface FileRecordLogOptions {
  /** Directory holding the run_id-keyed JSONL files. Created on construction. */
  readonly baseDir: string;
}

export class FileRecordLog implements RecordLog {
  private readonly baseDir: string;

  constructor(opts: FileRecordLogOptions) {
    this.baseDir = opts.baseDir;
    mkdirSync(this.baseDir, { recursive: true });
  }

  append(record: PersistedRecord): void {
    const runId = runIdOf(record);
    const line = `${JSON.stringify(record)}\n`;
    appendFileSync(this.filePath(runId), line, "utf8");
  }

  latestCheckpoint(runId: string): Checkpoint | null {
    const records = this.records(runId);
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      if (r && r.type === "checkpoint_snapshot") {
        return r.checkpoint;
      }
    }
    return null;
  }

  latestRunSeed(runId: string): string | null {
    const records = this.records(runId);
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      if (r && r.type === "run_seeded") {
        return r.goal;
      }
    }
    return null;
  }

  records(runId: string): readonly PersistedRecord[] {
    const filePath = this.filePath(runId);
    if (!existsSync(filePath)) return Object.freeze([]);
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    const records: PersistedRecord[] = [];
    for (const line of lines) {
      // Each line is a single JSON-encoded record. Schema changes
      // between SDK / core versions surface here as parse errors
      // — fail loud, no silent fallbacks (AGENTS.md).
      records.push(JSON.parse(line) as PersistedRecord);
    }
    return Object.freeze(records);
  }

  listRunIds(): readonly string[] {
    if (!existsSync(this.baseDir)) return Object.freeze([]);
    const files = readdirSync(this.baseDir);
    const ids = files.filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -".jsonl".length));
    return Object.freeze(ids);
  }

  close(): void {
    // Sync impl: no file descriptor held open. No-op.
  }

  private filePath(runId: string): string {
    return join(this.baseDir, `${runId}.jsonl`);
  }
}

/** Extract the run_id from a record. CheckpointSnapshot carries it on the wrapped Checkpoint. */
function runIdOf(record: PersistedRecord): string {
  return record.type === "checkpoint_snapshot" ? record.checkpoint.run_id : record.run_id;
}
