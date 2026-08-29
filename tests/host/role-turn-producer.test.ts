/**
 * RoleTurnProducer resume + trajectory reconstruction — issue #68.
 *
 * Proves the producer seeds its run-scoped sequence, counters, and per-logical
 * session identity from the durable `role_turn` stream (spec §7.5 / §3.2), rather
 * than inventing order or reusing a dead host's in-memory counters. These tests
 * exercise the producer through its own seed path against an in-memory log, which
 * is the exact stream a resumed host reads.
 */

import { appendFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileRecordLog } from "../../src/host/log-file.js";
import { RoleTurnProducer } from "../../src/host/role-turn-producer.js";
import { InMemoryRecordLog, type PersistedRecord } from "../../src/index.js";
import {
  DEFAULT_ROLE_TURN_LIMITS,
  RoleTurnConfigurationError,
  type RoleTurnRecord,
  RoleTurnRunMismatchError,
  type RoleTurnTelemetryLimits,
  RoleTurnTelemetryLogError,
} from "../../src/persistence/role-turn.js";

/** Minimal assistant message the producer reads (content, timestamp, stopReason). */
function shortMessage(text: string, timestamp = 2000): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp,
  } as unknown as AssistantMessage;
}

/** A producer context whose `persist` records each call in an array for assertions. */
/** A single durable role_turn with `sequence` and per-session identity patched. */
function roleTurn(sequence: number, overrides: Partial<RoleTurnRecord> = {}): RoleTurnRecord {
  return {
    type: "role_turn",
    schema_version: 1,
    run_id: "run-seed",
    role: "worker",
    role_session_id: "sess-A",
    conversation_id: "phys-common",
    session_file: "/tmp/phys-common.jsonl",
    sequence,
    ts: 1_700_000_000_000 + sequence,
    blocks: [
      {
        kind: "text",
        text: "t",
        original_utf8_bytes: 1,
        original_characters: 1,
        truncated: false,
        truncated_by: [],
      },
    ],
    capture: {
      limits: DEFAULT_ROLE_TURN_LIMITS,
      source: { utf8_bytes: 1, characters: 1, blocks: 1 },
      captured: { utf8_bytes: 1, characters: 1, blocks: 1 },
      omitted: { utf8_bytes: 0, characters: 0, blocks: 0 },
      limit_causes: [],
      saturated: [],
    },
    ...overrides,
  };
}

/** A role_turn whose captured byte count is 10 (used to cross a session-byte limit). */
function bigByteRoleTurn(sequence: number): RoleTurnRecord {
  const text = "x".repeat(10);
  return roleTurn(sequence, {
    role_session_id: "sess-B",
    blocks: [
      {
        kind: "text",
        text,
        original_utf8_bytes: 10,
        original_characters: 10,
        truncated: false,
        truncated_by: [],
      },
    ],
    capture: {
      limits: DEFAULT_ROLE_TURN_LIMITS,
      source: { utf8_bytes: 10, characters: 10, blocks: 1 },
      captured: { utf8_bytes: 10, characters: 10, blocks: 1 },
      omitted: { utf8_bytes: 0, characters: 0, blocks: 0 },
      limit_causes: [],
      saturated: [],
    },
  });
}

/** Append role_turn records to a fresh in-memory log. */
function logWith(...records: RoleTurnRecord[]): InMemoryRecordLog {
  const log = new InMemoryRecordLog();
  for (const record of records) {
    (log as unknown as { append: (r: PersistedRecord) => void }).append(record as PersistedRecord);
  }
  return log;
}

/** Durable role_turn records, filtered to one logical session for byte asserts. */
function assertOne(turns: readonly RoleTurnRecord[]): RoleTurnRecord {
  expect(turns).toHaveLength(1);
  const [turn] = turns;
  if (turn === undefined) throw new Error("expected exactly one role_turn");
  return turn;
}

/** Read back the durable role_turn records in append order. */
function durable(log: InMemoryRecordLog) {
  return log.records("run-seed").filter((r): r is RoleTurnRecord => r.type === "role_turn");
}

describe("RoleTurnProducer — resume seeds sequence + counters (spec §7.5)", () => {
  it("seeds next sequence, run counters, and per-logical-session identity from durable records", () => {
    // Two logical sessions share one physical conversation/file, as on a
    // trajectory chain (spec §3.2). Sequences 1..4 must reconstruct.
    const log = logWith(
      roleTurn(1, { role_session_id: "sess-A" }),
      roleTurn(2, { role_session_id: "sess-A" }),
      roleTurn(3, { role_session_id: "sess-A" }),
      bigByteRoleTurn(4),
    );

    // Constructing the producer reconstructs the ledger from the durable stream.
    expect(() => new RoleTurnProducer({ runId: "run-seed", log, telemetry: {} })).not.toThrow();

    // The reconstructed counters are observable through the durable stream: the
    // three A records share sess-A, and sess-B's single record captured 10 bytes.
    expect(durable(log).map((r) => r.sequence)).toEqual([1, 2, 3, 4]);
    const sessB = durable(log).filter((r) => r.role_session_id === "sess-B");
    expect(assertOne(sessB).capture.captured.utf8_bytes).toBe(10);
  });

  it("starts at sequence 1 for a fresh run with no durable role_turn", () => {
    const log = logWith();
    expect(() => new RoleTurnProducer({ runId: "run-seed", log, telemetry: {} })).not.toThrow();
    expect(durable(log)).toHaveLength(0);
  });
});

describe("RoleTurnProducer — resume reconstruction rejects malformed streams (spec §7.5)", () => {
  it("throws RoleTurnConfigurationError when the supplied limits differ from prior records", () => {
    const log = logWith(roleTurn(1));
    const otherLimits: RoleTurnTelemetryLimits = {
      ...DEFAULT_ROLE_TURN_LIMITS,
      max_run_turns: 400,
    };

    expect(
      () => new RoleTurnProducer({ runId: "run-seed", log, telemetry: { limits: otherLimits } }),
    ).toThrow(RoleTurnConfigurationError);
  });

  it("throws RoleTurnTelemetryLogError on a non-contiguous sequence", () => {
    const log = logWith(roleTurn(1), roleTurn(3));

    expect(() => new RoleTurnProducer({ runId: "run-seed", log, telemetry: {} })).toThrow(
      RoleTurnTelemetryLogError,
    );
  });
});

describe("RoleTurnProducer — record-count suppression (spec §5.4)", () => {
  const base = {
    runId: "run-bounds",
    role: "worker",
    conversationId: "physical-1",
    sessionFile: "/tmp/physical-1.jsonl",
  };
  it("suppresses later run_turns once the run quota is full: no sequence, no persist event", () => {
    const log = new InMemoryRecordLog();
    // Two logical sessions each reach the run quota together; session_turns
    // stays below its (equal) cap per session, isolating the run boundary.
    const runLimits: RoleTurnTelemetryLimits = {
      ...DEFAULT_ROLE_TURN_LIMITS,
      max_run_turns: 2,
      max_session_turns: 2,
    };

    const producer = new RoleTurnProducer({
      runId: "run-bounds",
      log,
      telemetry: { limits: runLimits },
    });

    // The durable log is the proof: persist appends so the log carries records.
    let persistCalls = 0;
    const append = (record: RoleTurnRecord) => {
      persistCalls += 1;
      (log as unknown as { append: (r: PersistedRecord) => void }).append(
        record as PersistedRecord,
      );
    };

    const sessA = { ...base, persist: append, roleSessionId: "logical-1" };
    const sessB = { ...base, persist: append, roleSessionId: "logical-2" };

    // Two turns across two logical sessions fill the run quota.
    producer.capture(sessA, shortMessage("a"));
    producer.capture(sessB, shortMessage("b"));

    const durable = log.records("run-bounds").filter((r) => r.type === "role_turn");
    expect(durable).toHaveLength(2);
    expect(persistCalls).toBe(2);

    // The final allowed record marks run_turns saturated but leaves each
    // session's record count below its (equal) per-session cap.
    expect(durable[1]?.capture.saturated).toContain("run_turns");
    expect(durable[1]?.capture.saturated).not.toContain("session_turns");

    // A third turn in an existing session is suppressed: no persist event.
    producer.capture(sessA, shortMessage("c"));
    expect(persistCalls).toBe(2);

    // A brand-new logical session in the same run is also suppressed.
    producer.capture({ ...base, persist: append, roleSessionId: "logical-3" }, shortMessage("d"));
    expect(persistCalls).toBe(2);
    expect(log.records("run-bounds").filter((r) => r.type === "role_turn")).toHaveLength(2);
  });

  it("suppresses later session_turns once the logical-session quota is full", () => {
    const log = new InMemoryRecordLog();
    // max_session_turns: 1 satisfies the chain (session <= run = default 512).
    const limits: RoleTurnTelemetryLimits = { ...DEFAULT_ROLE_TURN_LIMITS, max_session_turns: 1 };
    const producer = new RoleTurnProducer({
      runId: "run-sess",
      log,
      telemetry: { limits },
    });

    const append = (record: RoleTurnRecord) => {
      (log as unknown as { append: (r: PersistedRecord) => void }).append(
        record as PersistedRecord,
      );
    };

    // Two turns in the same logical session: the first fills the session quota.
    producer.capture(
      { ...base, persist: append, runId: "run-sess", roleSessionId: "logical-s" },
      shortMessage("a"),
    );
    producer.capture(
      { ...base, persist: append, runId: "run-sess", roleSessionId: "logical-s" },
      shortMessage("b"),
    );

    const durable = log.records("run-sess").filter((r) => r.type === "role_turn");
    expect(durable).toHaveLength(1);
    expect(durable[0]?.capture.saturated).toContain("session_turns");
    expect(durable[0]?.capture.saturated).not.toContain("run_turns");

    // A different logical session starts fresh and is NOT suppressed.
    producer.capture(
      { ...base, persist: append, runId: "run-sess", roleSessionId: "logical-s2" },
      shortMessage("other"),
    );
    expect(log.records("run-sess").filter((r) => r.type === "role_turn")).toHaveLength(2);
  });
});

describe("RoleTurnProducer — trajectory continuation identity (spec §3.2.6 / §5.4)", () => {
  // Mirrors the production/shared-host `continueTrajectory` contract: a single
  // run-owned producer serves the source context, then (after detaching the
  // source subscription) a new target context with a fresh logical id but the
  // same physical conversation/file. The producer owns sequence, counters, and
  // per-logical identity, so this is the contract boundary the trajectory path
  // relies on (spec §6.1 / §9).
  const source = {
    runId: "run-traj",
    role: "orchestrator",
    conversationId: "phys-common",
    sessionFile: "/tmp/phys-common.jsonl",
  };

  it("gives the successor a fresh logical id, shares physical identity, resets session counters, and continues the run sequence", () => {
    const log = new InMemoryRecordLog();
    const producer = new RoleTurnProducer({
      runId: "run-traj",
      log,
      telemetry: {},
    });

    const append = (record: RoleTurnRecord) => {
      (log as unknown as { append: (r: PersistedRecord) => void }).append(
        record as PersistedRecord,
      );
    };

    // Source logical invocation, before detach.
    producer.capture(
      { ...source, persist: append, roleSessionId: "source-logical" },
      shortMessage("first", 3000),
    );
    const afterSource = log.records("run-traj").filter((r) => r.type === "role_turn");
    expect(afterSource).toHaveLength(1);
    expect(afterSource[0]?.role_session_id).toBe("source-logical");

    // ContinueTrajectory detaches the source subscription and binds a new context
    // for the new target logical id, retaining the same conversation/file.
    producer.capture(
      {
        runId: "run-traj",
        role: "worker",
        roleSessionId: "worker-logical",
        conversationId: "phys-common",
        sessionFile: "/tmp/phys-common.jsonl",
        persist: append,
      },
      shortMessage("second", 4000),
    );

    const turns = log
      .records("run-traj")
      .filter((r) => r.type === "role_turn")
      .sort((a, b) => a.sequence - b.sequence);
    expect(turns).toHaveLength(2);

    const [first, second] = turns;
    if (!first || !second) throw new Error("expected two role_turn records");

    // Distinct logical ids, shared physical identity (spec §3.2.6).
    expect(first.role_session_id).toBe("source-logical");
    expect(second.role_session_id).toBe("worker-logical");
    expect(first.conversation_id).toBe("phys-common");
    expect(second.conversation_id).toBe("phys-common");
    expect(first.session_file).toBe("/tmp/phys-common.jsonl");
    expect(second.session_file).toBe("/tmp/phys-common.jsonl");

    // Continuous run-scoped sequence across the logical boundary (spec §5.5).
    expect(turns.map((t) => t.sequence)).toEqual([1, 2]);
    // Fresh per-logical-session counters: the successor is its own invocation.
    expect(second.role_session_id).not.toBe(first.role_session_id);
    // No duplicates and no reread of prior history.
    expect(new Set(turns.map((t) => t.sequence)).size).toBe(2);
  });
});

describe("RoleTurnProducer — durability + content selection (spec §4.2 / §5.5)", () => {
  it("can retry the same object with sequence 1 after a persist failure", () => {
    // A failed append must not advance the sequence, so the exact same object
    // retries against the unchanged next sequence (spec §5.5). Per-attachment
    // re-fire dedup that collapses a provider abort's identical re-fired object
    // lives in `attachSessionEventHandler` (spec §6), not here.
    const log = new InMemoryRecordLog();
    const producer = new RoleTurnProducer({ runId: "run-retry", log, telemetry: {} });
    let attempts = 0;
    const failingAppend = (record: RoleTurnRecord) => {
      attempts += 1;
      if (attempts === 1) throw new Error("durable append failed");
      log.append(record as PersistedRecord);
    };
    const ctx = {
      runId: "run-retry",
      role: "worker",
      roleSessionId: "s1",
      conversationId: "c1",
      sessionFile: "/tmp/c1.jsonl",
      persist: failingAppend,
    };
    expect(() => producer.capture(ctx, shortMessage("retry", 42))).toThrow("durable append failed");
    expect(log.records("run-retry").filter((r) => r.type === "role_turn")).toHaveLength(0);
    // Retry the exact same object; sequence must still be 1.
    producer.capture(ctx, shortMessage("retry", 42));
    const turns = log.records("run-retry").filter((r) => r.type === "role_turn");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.sequence).toBe(1);
  });

  it("never lets redacted thinking enter the durable record (remediation §2 / §4.2)", () => {
    const log = new InMemoryRecordLog();
    const producer = new RoleTurnProducer({ runId: "run-redact-prod", log, telemetry: {} });
    let persists = 0;
    const append = (record: RoleTurnRecord) => {
      persists += 1;
      log.append(record as PersistedRecord);
    };
    const msg = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "SUPER_SECRET_REASONING", redacted: true },
        { type: "text", text: "kept" },
      ],
      stopReason: "stop",
      timestamp: 1,
    } as unknown as AssistantMessage;
    producer.capture(
      {
        runId: "run-redact-prod",
        role: "worker",
        roleSessionId: "s1",
        conversationId: "c1",
        sessionFile: "/tmp/c1.jsonl",
        persist: append,
      },
      msg,
    );
    expect(persists).toBe(1);
    const turns = log.records("run-redact-prod").filter((r) => r.type === "role_turn");
    expect(turns).toHaveLength(1);
    expect(JSON.stringify(turns)).not.toContain("SUPER_SECRET_REASONING");
  });
});

describe("RoleTurnProducer — disabled telemetry still validates prior stream (remediation §3)", () => {
  it("still reconstructs + rejects a malformed prior stream when disabled", () => {
    const log = logWith(roleTurn(1), roleTurn(3));
    expect(
      () => new RoleTurnProducer({ runId: "run-seed", log, telemetry: { enabled: false } }),
    ).toThrow(RoleTurnTelemetryLogError);
  });

  it("writes no record when disabled but still reconstructs a valid prior stream", () => {
    const log = logWith(roleTurn(1));
    const producer = new RoleTurnProducer({
      runId: "run-seed",
      log,
      telemetry: { enabled: false },
    });
    // A valid prior stream reconstructs without throwing.
    expect(
      () => new RoleTurnProducer({ runId: "run-seed", log, telemetry: { enabled: false } }),
    ).not.toThrow();
    let persists = 0;
    const append = (record: RoleTurnRecord) => {
      persists += 1;
      log.append(record as PersistedRecord);
    };
    producer.capture(
      {
        runId: "run-seed",
        role: "worker",
        roleSessionId: "sess-A",
        conversationId: "c1",
        sessionFile: "/tmp/s1.jsonl",
        persist: append,
      },
      shortMessage("nope", 7000),
    );
    // Disabled telemetry emits no new record even after a valid reconstruction.
    expect(persists).toBe(0);
    // The single pre-existing record is untouched (not duplicated or rewritten).
    expect(log.records("run-seed").filter((r) => r.type === "role_turn")).toHaveLength(1);
  });
});

describe("RoleTurnProducer — identity tracking across captures (remediation §3)", () => {
  it("rejects a repeated role_session_id whose identity changed before capturing", () => {
    const log = new InMemoryRecordLog();
    const producer = new RoleTurnProducer({ runId: "run-identity", log, telemetry: {} });
    const append = (record: RoleTurnRecord) => {
      log.append(record as PersistedRecord);
    };
    const first = {
      runId: "run-identity",
      role: "worker",
      roleSessionId: "s1",
      conversationId: "c1",
      sessionFile: "/tmp/c1.jsonl",
      persist: append,
    };
    const second = { ...first, conversationId: "c2", sessionFile: "/tmp/c2.jsonl" };
    producer.capture(first, shortMessage("first", 1));
    expect(() => producer.capture(second, shortMessage("second", 2))).toThrow(
      /identity changed across records/,
    );
    // No record was allocated for the mismatched identity (persist never called on 2nd).
    expect(log.records("run-identity").filter((r) => r.type === "role_turn")).toHaveLength(1);
  });

  it("accepts a repeated role_session_id whose identity is unchanged", () => {
    const log = new InMemoryRecordLog();
    const producer = new RoleTurnProducer({ runId: "run-identity-ok", log, telemetry: {} });
    const append = (record: RoleTurnRecord) => {
      log.append(record as PersistedRecord);
    };
    const ctx = {
      runId: "run-identity-ok",
      role: "worker",
      roleSessionId: "s1",
      conversationId: "c1",
      sessionFile: "/tmp/c1.jsonl",
      persist: append,
    };
    producer.capture(ctx, shortMessage("a", 1));
    producer.capture(ctx, shortMessage("b", 2));
    expect(log.records("run-identity-ok").filter((r) => r.type === "role_turn")).toHaveLength(2);
  });

  it("reconstructs identity on resume and rejects a resumed session whose identity changed", () => {
    const log = logWith(roleTurn(1));
    // The durable record carries role_session_id 's1', conversation 'phys-common',
    // file '/tmp/phys-common.jsonl' (see the roleTurn() fixture below).
    const producer = new RoleTurnProducer({ runId: "run-seed", log, telemetry: {} });
    const append = (record: RoleTurnRecord) => {
      log.append(record as PersistedRecord);
    };
    // Same identity as the reconstructed record: accepted.
    producer.capture(
      {
        runId: "run-seed",
        role: "worker",
        roleSessionId: "s1",
        conversationId: "phys-common",
        sessionFile: "/tmp/phys-common.jsonl",
        persist: append,
      },
      shortMessage("resumed", 8000),
    );
    expect(log.records("run-seed").filter((r) => r.type === "role_turn")).toHaveLength(2);
    // Now a changed identity for the same logical id is rejected before capture.
    expect(() =>
      producer.capture(
        {
          runId: "run-seed",
          role: "worker",
          roleSessionId: "s1",
          conversationId: "different",
          sessionFile: "/tmp/different.jsonl",
          persist: append,
        },
        shortMessage("wrong", 8001),
      ),
    ).toThrow(/identity changed across records/);
  });
});

describe("RoleTurnProducer — run id mismatch is a typed failure (remediation §3)", () => {
  it("throws RoleTurnRunMismatchError before the disabled early return when telemetry is disabled", () => {
    // A wiring error must surface even when telemetry happens to be disabled.
    const log = new InMemoryRecordLog();
    const producer = new RoleTurnProducer({ runId: "owned", log, telemetry: { enabled: false } });
    const badContext = {
      runId: "other",
      role: "worker",
      roleSessionId: "s1",
      conversationId: "c1",
      sessionFile: "/tmp/c1.jsonl",
      persist: () => {},
    };
    expect(() => producer.capture(badContext as never, shortMessage("x", 1))).toThrow(
      RoleTurnRunMismatchError,
    );
  });
  it("throws RoleTurnRunMismatchError when a context targets a different run", () => {
    const log = new InMemoryRecordLog();
    const producer = new RoleTurnProducer({ runId: "owned-run", log, telemetry: {} });
    const append = () => {
      throw new Error("persist must not be called on a run mismatch");
    };
    const badContext = {
      runId: "other-run",
      role: "worker",
      roleSessionId: "s1",
      conversationId: "c1",
      sessionFile: "/tmp/c1.jsonl",
      persist: append,
    };
    expect(() => producer.capture(badContext as never, shortMessage("x", 1))).toThrow(
      RoleTurnRunMismatchError,
    );
    // No sequence was allocated / no byte/turn counter advanced on the mismatch.
    expect(log.records("owned-run").filter((r) => r.type === "role_turn")).toHaveLength(0);
  });
});

describe("RoleTurnProducer — fail-closed log scan for cross-run role_turn (remediation §3)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "conductorrtp-logscan-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("throws RoleTurnTelemetryLogError when a durable role_turn carries a non-owned run_id", async () => {
    // A role_turn row written under the owned run file but carrying a different
    // run_id indicates cross-run log corruption; the producer must fail closed.
    await appendFileSync(
      join(dir, "owned-run.jsonl"),
      `${JSON.stringify(roleTurn(1, { run_id: "other-run" }))}\n`,
      "utf8",
    );
    const log = new FileRecordLog({ baseDir: dir });
    try {
      expect(() => new RoleTurnProducer({ runId: "owned-run", log, telemetry: {} })).toThrow(
        RoleTurnTelemetryLogError,
      );
    } finally {
      log.close();
    }
  });
});
