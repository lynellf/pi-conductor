import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { FileRecordLog } from "../../src/host/log-file.js";
import { InMemoryRecordLog } from "../../src/persistence/in-memory-log.js";
import {
  assertOrchestratorContextRecord,
  type ContextBoundaryCommittedRecord,
  type ContextBoundaryReference,
  type ContextCompactionRecord,
  type ContextDeliveryCommittedRecord,
  type ContextEpochStartedRecord,
  type ContextInvocationStartedRecord,
} from "../../src/persistence/orchestrator-context.js";

const boundary: ContextBoundaryReference = {
  role_session_id: "session-1",
  conversation_id: "conversation-1",
  session_file: "/tmp/session.jsonl",
  leaf_id: "leaf-1",
  history_sha256: "a".repeat(64),
};

const records = [
  {
    schema_version: 1,
    type: "context_epoch_started",
    run_id: "run-1",
    role: "orchestrator",
    epoch: 1,
    reason: "start",
    previous_epoch: null,
    compaction: { enabled: true, reserve_tokens: 100, keep_recent_tokens: 200 },
    ts: 1,
  } satisfies ContextEpochStartedRecord,
  {
    schema_version: 1,
    type: "context_invocation_started",
    run_id: "run-1",
    role: "orchestrator",
    epoch: 1,
    role_session_id: "session-1",
    conversation_id: "conversation-1",
    session_file: "/tmp/session.jsonl",
    model: "stub:model",
    source_boundary: boundary,
    ts: 2,
  } satisfies ContextInvocationStartedRecord,
  {
    schema_version: 1,
    type: "context_delivery_committed",
    run_id: "run-1",
    role: "orchestrator",
    epoch: 1,
    role_session_id: "session-1",
    conversation_id: "conversation-1",
    session_file: "/tmp/session.jsonl",
    delivery_id: "delivery-1",
    seed_sha256: "b".repeat(64),
    leaf_id: "leaf-1",
    ts: 3,
  } satisfies ContextDeliveryCommittedRecord,
  {
    schema_version: 1,
    type: "context_boundary_committed",
    run_id: "run-1",
    role: "orchestrator",
    epoch: 1,
    role_session_id: "session-1",
    conversation_id: "conversation-1",
    session_file: "/tmp/session.jsonl",
    leaf_id: "leaf-1",
    history_sha256: "a".repeat(64),
    ts: 4,
  } satisfies ContextBoundaryCommittedRecord,
  {
    schema_version: 1,
    type: "context_compaction",
    run_id: "run-1",
    role: "orchestrator",
    epoch: 1,
    role_session_id: "session-1",
    request_id: "request-1",
    outcome: "completed",
    usage: { input: 1, output: 2, cache_read: 3, cache_write: 4, tokens: 5, cost: 0.1 },
    diagnostic: null,
    before_leaf_id: "leaf-1",
    after_leaf_id: "leaf-2",
    ts: 5,
  } satisfies ContextCompactionRecord,
] as const;

describe("orchestrator context persistence records", () => {
  it.each(["memory", "file"] as const)("round-trips valid records through %s log", async (kind) => {
    let log: InMemoryRecordLog | FileRecordLog;
    let cleanup: (() => Promise<void>) | undefined;
    if (kind === "memory") log = new InMemoryRecordLog();
    else {
      const directory = await mkdtemp(join(tmpdir(), "pi-context-records-"));
      log = new FileRecordLog({ baseDir: directory });
      cleanup = () => rm(directory, { recursive: true, force: true });
    }
    try {
      for (const record of records) {
        assertOrchestratorContextRecord(record);
        log.append(record);
      }
      expect(log.records("run-1")).toHaveLength(records.length);
      expect(log.records("run-1")[4]).toMatchObject({ type: "context_compaction" });
    } finally {
      log.close();
      await cleanup?.();
    }
  });

  it.each([
    ["unknown type", { ...records[0], type: "context_unknown" }],
    [
      "missing schema version",
      (() => {
        const { schema_version: _version, ...record } = records[0];
        return record;
      })(),
    ],
    ["unsupported schema version", { ...records[0], schema_version: 2 }],
    ["non-finite timestamp", { ...records[0], ts: Number.POSITIVE_INFINITY }],
    ["bad digest", { ...records[3], history_sha256: "bad" }],
    ["non-finite usage", { ...records[4], usage: { ...records[4].usage, cost: Number.NaN } }],
    ["negative usage", { ...records[4], usage: { ...records[4].usage, cost: -1 } }],
  ])("rejects %s", (_name, record) => {
    expect(() => assertOrchestratorContextRecord(record)).toThrow();
  });

  it("requires known usage for successful compaction and a diagnostic for failure", () => {
    expect(() => assertOrchestratorContextRecord({ ...records[0], epoch: 2 })).toThrow();
    expect(() =>
      assertOrchestratorContextRecord({ ...records[4], outcome: "completed", usage: null }),
    ).toThrow();
    expect(() =>
      assertOrchestratorContextRecord({ ...records[4], outcome: "failed", diagnostic: null }),
    ).toThrow();
  });
});
