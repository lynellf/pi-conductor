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
 * ## Crash semantics (issue #37 Finding 1)
 *
 * Append-only means a crashed run's records are intact on disk
 * and recoverable by `resumeRun`. `latestCheckpoint(runId)` walks
 * the file in reverse to find the last `checkpoint_snapshot`
 * without replaying events — per §11.1 ("the snapshot *is* the
 * state"). A crash mid-`appendFileSync` leaves a torn trailing
 * line: `records()` skips that single trailing line with a
 * surfaced warning (the line is, by construction, the one being
 * written when the process died) so resume can still reach the
 * last good snapshot. A torn line in the MIDDLE of the file, or an
 * unknown record `type` (schema drift), is a hard error surfaced
 * as a typed `RecordLogError` — never a silent fallback
 * (AGENTS.md), and never a bare `SyntaxError` (mirrors
 * `ManifestParseError` in src/manifest/types.ts).
 *
 * The base directory is created on construction (idempotent
 * `mkdirSync({ recursive: true })`).
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import type { Checkpoint } from "../core/types.js";
import { normalizeCheckpoint, type PersistedRecord, type RecordLog } from "../persistence/log.js";
import {
  assertPersistedRecordGuarantees,
  materializePersistedRecord,
} from "../persistence/record-materialization.js";

export interface FileRecordLogOptions {
  /** Directory holding the run_id-keyed JSONL files. Created on construction. */
  readonly baseDir: string;
}

/**
 * Typed failure while decoding a file-backed run log at the filesystem boundary.
 *
 * Mirrors `ManifestParseError` (src/manifest/types.ts): wraps the raw
 * `SyntaxError` (or a schema-drift error) with the `runId` and 1-based
 * `line` so callers can surface a diagnostic instead of a bare stack. Per
 * AGENTS.md ("No silent fallbacks: ambiguity → throw a typed error or
 * surface a warning"), the JSONL reader is the outlier that must NOT leak
 * a raw `SyntaxError` to `resumeRun` / `/conduct:list`.
 */
export class RecordLogError extends Error {
  readonly runId: string;
  readonly line: number;

  constructor(message: string, options: { cause?: unknown; runId: string; line: number }) {
    super(message, { cause: options.cause });
    this.name = "RecordLogError";
    this.runId = options.runId;
    this.line = options.line;
  }
}

/** Typed rejection for a second live execution of the same persisted run. */
export class RunInProgressError extends Error {
  readonly code = "run-in-progress";
  readonly runId: string;

  constructor(runId: string, options?: { cause?: unknown }) {
    super(`run '${runId}' already has an active execution lease`, options);
    this.name = "RunInProgressError";
    this.runId = runId;
  }
}

/** Typed failure when no crash-recoverable run lease can be bound. */
export class RunLeaseUnavailableError extends Error {
  readonly code = "run-lease-unavailable";
  readonly runId: string;

  constructor(runId: string, options?: { cause?: unknown }) {
    super(`run '${runId}' execution lease could not bind a loopback TCP candidate`, options);
    this.name = "RunLeaseUnavailableError";
    this.runId = runId;
  }
}

/** Exclusive live-execution lease for a single run. */
export interface RunExecutionLease {
  /** Release the lease once the bound orchestration loop terminates. */
  release(): Promise<void>;
}

export class FileRecordLog implements RecordLog {
  private readonly baseDir: string;

  constructor(opts: FileRecordLogOptions) {
    mkdirSync(opts.baseDir, { recursive: true });
    // Canonicalize equivalent relative/symlinked paths before deriving the
    // deterministic loopback candidate sequence below.
    this.baseDir = realpathSync(opts.baseDir);
  }

  append(record: PersistedRecord): void {
    const materialized = materializePersistedRecord(record);
    const runId = runIdOf(materialized.record);
    appendFileSync(this.filePath(runId), `${materialized.json}\n`, "utf8");
  }

  /**
   * Atomically claim this run's live execution before reading or appending its log.
   *
   * A deterministic bounded sequence of loopback TCP candidates lets every
   * supported Node platform use kernel-owned ports that disappear with an
   * exited (including SIGKILLed) process. This coordinates only this host and
   * loopback network namespace; it is not a distributed lock.
   */
  async acquireRunLease(runId: string): Promise<RunExecutionLease> {
    const digest = this.leaseDigest(runId);
    const identity = `${LEASE_IDENTITY_PREFIX}${digest.toString("hex")}`;
    let lastCause: unknown;

    for (const port of leaseCandidates(digest)) {
      const clients = new Set<Socket>();
      const server = createLeaseServer(identity, clients);
      try {
        await listen(server, port);
        return createLease(server, clients);
      } catch (cause) {
        lastCause = cause;
        if (!hasErrorCode(cause, "EADDRINUSE")) {
          throw new RunLeaseUnavailableError(runId, { cause });
        }
        if (await candidateHasIdentity(port, identity)) {
          throw new RunInProgressError(runId, { cause });
        }
      }
    }

    throw new RunLeaseUnavailableError(
      runId,
      lastCause === undefined ? undefined : { cause: lastCause },
    );
  }

  latestCheckpoint(runId: string): Checkpoint | null {
    const records = this.records(runId);
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      if (r && r.type === "checkpoint_snapshot") {
        return normalizeCheckpoint(r.checkpoint);
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
    // A well-formed file ends with a trailing newline (every `append` writes
    // `JSON.stringify(record) + "\n"`). A file that ends mid-record (no
    // trailing newline) is the signature of a crash mid-`appendFileSync` —
    // §11.1 promises resume recovers exactly this case. We tolerate the
    // single torn TRAILING line (with a surfaced warning) but treat a torn
    // line in the MIDDLE as genuine corruption (hard error). Blank lines
    // are skipped without warning.
    const hasTrailingNewline = content.endsWith("\n");
    const lines = content.split("\n");
    if (hasTrailingNewline) lines.pop();
    let lastNonEmptyLine = -1;
    for (let index = lines.length - 1; index >= 0; index--) {
      if (lines[index] !== "") {
        lastNonEmptyLine = index;
        break;
      }
    }
    const records: PersistedRecord[] = [];

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (line === undefined || line.length === 0) continue;
      const lineNumber = index + 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (cause) {
        if (!hasTrailingNewline && index === lastNonEmptyLine) {
          // The torn trailing record is, by construction, the line that was
          // being written when the process died. Skip it with a surfaced
          // warning — a deliberate §11.1 boundary decision, not a silent
          // fallback (AGENTS.md).
          console.warn(`Ignoring torn trailing record for run '${runId}' at line ${lineNumber}`);
          continue;
        }
        throw new RecordLogError(`Invalid JSON in run log '${runId}' at line ${lineNumber}`, {
          cause,
          runId,
          line: lineNumber,
        });
      }
      records.push(parsePersistedRecord(parsed, runId, lineNumber));
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

  private leaseDigest(runId: string): Buffer {
    return createHash("sha256").update(this.baseDir).update("\0").update(runId).digest();
  }
}

const LEASE_HOST = "127.0.0.1";
const LEASE_PORT_START = 49_152;
const LEASE_PORT_COUNT = 8_192;
const LEASE_CANDIDATE_LIMIT = 64;
const LEASE_PROBE_TIMEOUT_MS = 100;
const LEASE_IDENTITY_PREFIX = "pi-conductor-run-lease-v1:";

function leaseCandidates(digest: Buffer): readonly number[] {
  const offset = digest.readUInt32BE(0) % LEASE_PORT_COUNT;
  // An odd stride visits each member of this power-of-two port range once
  // before repeating, while keeping the bounded sequence deterministic.
  const stride = (digest.readUInt32BE(4) % LEASE_PORT_COUNT) | 1;
  return Array.from(
    { length: LEASE_CANDIDATE_LIMIT },
    (_, index) => LEASE_PORT_START + ((offset + index * stride) % LEASE_PORT_COUNT),
  );
}

function createLeaseServer(identity: string, clients: Set<Socket>): Server {
  return createServer((client) => {
    clients.add(client);
    client.once("close", () => clients.delete(client));
    // A probe only needs the deterministic identity. Ending immediately
    // prevents a well-behaved client from retaining the server connection;
    // release() force-destroys tracked sockets for a client that does not close.
    client.end(`${identity}\n`);
  });
}

function createLease(server: Server, clients: Set<Socket>): RunExecutionLease {
  let released = false;
  let releaseAttempt: Promise<void> | null = null;

  return {
    release: () => {
      if (released) return Promise.resolve();
      if (releaseAttempt !== null) return releaseAttempt;
      releaseAttempt = closeLease(server, clients).then(
        () => {
          released = true;
        },
        (cause: unknown) => {
          releaseAttempt = null;
          throw cause;
        },
      );
      return releaseAttempt;
    },
  };
}

function closeLease(server: Server, clients: ReadonlySet<Socket>): Promise<void> {
  for (const client of clients) client.destroy();
  return close(server);
}

function candidateHasIdentity(port: number, identity: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = createConnection({ host: LEASE_HOST, port });
    let response = "";
    let settled = false;
    const timeout = setTimeout(() => finish(false), LEASE_PROBE_TIMEOUT_MS);
    const finish = (matches: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.destroy();
      resolve(matches);
    };
    client.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
      if (response.length > identity.length + 1) {
        finish(false);
        return;
      }
      const newline = response.indexOf("\n");
      if (newline !== -1) finish(response.slice(0, newline) === identity);
    });
    client.once("end", () => finish(response === identity));
    client.once("error", () => finish(false));
    client.once("timeout", () => finish(false));
  });
}

function hasErrorCode(cause: unknown, code: string): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { readonly code?: unknown }).code === code
  );
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (cause: Error) => {
      server.off("listening", onListening);
      reject(cause);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: LEASE_HOST, port });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((cause) => {
      if (cause === undefined) {
        resolve();
        return;
      }
      reject(cause);
    });
  });
}

/** Extract the run_id from a record. CheckpointSnapshot carries it on the wrapped Checkpoint. */
function runIdOf(record: PersistedRecord): string {
  return record.type === "checkpoint_snapshot" ? record.checkpoint.run_id : record.run_id;
}

/**
 * The full set of `PersistedRecord` `type` discriminants the current core +
 * persistence layer can emit. Used to validate the parsed value's `type` at
 * the filesystem boundary so a schema-drifted record (an older log read by
 * newer code, or vice versa) is caught as a typed `RecordLogError` rather
 * than silently bare-cast. A full TypeBox schema is possible later but is
 * not required to close this boundary (issue #37 Finding 1, smallest fix).
 */
const PERSISTED_RECORD_TYPES: ReadonlySet<string> = new Set([
  "transition_accepted",
  "transition_rejected",
  "session_started",
  "session_ended",
  "session_failed",
  "model_fallback",
  "model_retry",
  "checkpoint_snapshot",
  "run_seeded",
  "run_context",
  "handoff_validation_rejected",
  "progressive_disclosure",
  "subagent_started",
  "delegation_validation_rejected",
  "subagent_completed",
  "subagent_failed",
  "file_mutation",
  "role_turn",
  "snapshot_pinned",
  "workspace_provisioned",
  "artifact_collected",
  "artifact_rejected",
  "artifact_delivery",
  "manifest_snapshot",
  "handoff_transport_selected",
  "trajectory_handoff_failed",
  "trajectory_target_seed_delivered",
]);

/** Validate the parsed JSONL value's `type` discriminant before trusting it as a record. */
function parsePersistedRecord(value: unknown, runId: string, line: number): PersistedRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    typeof (value as { type?: unknown }).type !== "string" ||
    !PERSISTED_RECORD_TYPES.has((value as { type: string }).type)
  ) {
    const type =
      typeof value === "object" && value !== null && "type" in value
        ? (value as { type?: unknown }).type
        : undefined;
    const cause = new Error(`unknown persisted record type: ${String(type)}`);
    throw new RecordLogError(
      `Unknown persisted record type in run log '${runId}' at line ${line}`,
      {
        cause,
        runId,
        line,
      },
    );
  }
  const record = value as PersistedRecord;
  assertPersistedRecordGuarantees(record);
  return record;
}
