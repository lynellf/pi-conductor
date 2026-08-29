import { appendFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionLifecycleEvent } from "../../src/core/types.js";
import { FileRecordLog } from "../../src/host/log-file.js";
import { InMemoryRecordLog } from "../../src/persistence/log.js";
import { DEFAULT_ROLE_TURN_LIMITS, type RoleTurnRecord } from "../../src/persistence/role-turn.js";

const workspace = {
  backend: "worktree",
  guarantee: "confined" as const,
  path_or_image: "/tmp/isolated",
};

function terminalRecord(type: "session_ended" | "session_failed"): object {
  return {
    type,
    run_id: "run-1",
    role: "isolated",
    visit_index: 1,
    state: "isolated",
    model: "anthropic:claude-sonnet-4-5",
    session_file: "/tmp/isolated.jsonl",
    parent_session: null,
    usage: {
      input: 1,
      output: 1,
      cache_read: 0,
      cache_write: 0,
      tokens: 2,
      cost: 0.01,
    },
    workspace,
    ts: 1,
  };
}

describe("lifecycle workspace record materialization", () => {
  it.each([
    "session_ended",
    "session_failed",
  ] as const)("rejects confined workspace metadata on %s before retaining the terminal record", (type) => {
    const log = new InMemoryRecordLog();

    expect(() => log.append(terminalRecord(type) as never)).toThrow(
      "workspace metadata is only allowed on session_started",
    );
    expect(log.records("run-1")).toEqual([]);
  });

  it("retains a valid session_started workspace unchanged", () => {
    const log = new InMemoryRecordLog();
    const started: SessionLifecycleEvent = {
      type: "session_started",
      run_id: "run-1",
      role: "isolated",
      visit_index: 1,
      state: "isolated",
      model: "anthropic:claude-sonnet-4-5",
      session_file: "/tmp/isolated.jsonl",
      parent_session: null,
      workspace,
      ts: 1,
    };

    log.append(started);

    expect(log.records("run-1")).toEqual([started]);
  });
});

// ─── Issue #68 — role_turn materialization round-trip ─────────────────

function roleTurnRecord(overrides: Partial<RoleTurnRecord> = {}): RoleTurnRecord {
  return {
    type: "role_turn",
    schema_version: 1,
    run_id: "run-rt",
    role: "worker",
    role_session_id: "s1",
    conversation_id: "c1",
    session_file: "/tmp/s1.jsonl",
    sequence: 1,
    ts: 1_700_000_000_000,
    blocks: [
      {
        kind: "text",
        text: "hi",
        original_utf8_bytes: 2,
        original_characters: 2,
        truncated: false,
        truncated_by: [],
      },
    ],
    capture: {
      limits: DEFAULT_ROLE_TURN_LIMITS,
      source: { utf8_bytes: 2, characters: 2, blocks: 1 },
      captured: { utf8_bytes: 2, characters: 2, blocks: 1 },
      omitted: { utf8_bytes: 0, characters: 0, blocks: 0 },
      limit_causes: [],
      saturated: [],
    },
    ...overrides,
  };
}

describe("issue #68 — role_turn persistence contract", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "conductormat-rt-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a valid role_turn through the in-memory log as canonical JSON", () => {
    const log = new InMemoryRecordLog();
    const record = roleTurnRecord();

    expect(() => log.append(record)).not.toThrow();
    // The stored representation is the materialized JSON; re-reading yields an
    // equal record (key order preserved, no runtime objects smuggled in).
    expect(log.records("run-rt")).toEqual([record]);
  });

  it("round-trips a valid role_turn through the file-backed log", async () => {
    const fileLog = new FileRecordLog({ baseDir: dir });
    const record = roleTurnRecord();

    fileLog.append(record);
    fileLog.close();

    const read = new FileRecordLog({ baseDir: dir });
    const rows = read.records("run-rt");
    read.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(record);
  });

  it("rejects a role_turn with an extra raw-data key before retention", () => {
    const log = new InMemoryRecordLog();
    const bad = roleTurnRecord();
    (bad as unknown as Record<string, unknown>).transcript_fragment = "pii";

    expect(() => log.append(bad)).toThrow();
    expect(log.records("run-rt")).toEqual([]);
  });

  it("rejects a role_turn with an invalid measure/arithmetic at retention", () => {
    const log = new InMemoryRecordLog();
    const bad = roleTurnRecord({
      capture: {
        limits: DEFAULT_ROLE_TURN_LIMITS,
        source: { utf8_bytes: 10, characters: 2, blocks: 2 },
        captured: { utf8_bytes: 2, characters: 2, blocks: 1 },
        omitted: { utf8_bytes: 3, characters: 0, blocks: 1 },
        limit_causes: [],
        saturated: [],
      },
    });

    expect(() => log.append(bad)).toThrow();
    expect(log.records("run-rt")).toEqual([]);
  });

  it("rejects a role_turn whose captured blocks exceed the per-turn block cap at retention", () => {
    const log = new InMemoryRecordLog();
    const bad = roleTurnRecord({
      capture: {
        limits: { ...DEFAULT_ROLE_TURN_LIMITS, max_turn_blocks: 1 },
        source: { utf8_bytes: 4, characters: 4, blocks: 2 },
        captured: { utf8_bytes: 4, characters: 4, blocks: 2 },
        omitted: { utf8_bytes: 0, characters: 0, blocks: 0 },
        limit_causes: [],
        saturated: [],
      },
      blocks: [
        {
          kind: "text",
          text: "ab",
          original_utf8_bytes: 2,
          original_characters: 2,
          truncated: false,
          truncated_by: [],
        },
        {
          kind: "text",
          text: "cd",
          original_utf8_bytes: 2,
          original_characters: 2,
          truncated: false,
          truncated_by: [],
        },
      ],
    });

    expect(() => log.append(bad)).toThrow();
    expect(log.records("run-rt")).toEqual([]);
  });

  it("still reads a historical run log that never produced a role_turn", () => {
    const log = new InMemoryRecordLog();
    log.append({
      type: "session_started",
      run_id: "run-historical",
      role: "orchestrator",
      visit_index: 1,
      state: "orchestrator",
      model: null,
      session_file: "/tmp/hist.jsonl",
      parent_session: null,
      ts: 1,
    } as SessionLifecycleEvent);

    expect(log.records("run-historical")).toHaveLength(1);
    // Historical logs without role_turn remain fully readable.
    expect(log.records("run-historical").some((r) => r.type === "role_turn")).toBe(false);
  });

  it("rejects a role_turn captured.measure that does not equal the retained-block measure", () => {
    const log = new InMemoryRecordLog();
    // reported captured.blocks=2 while only one block is retained.
    const bad = roleTurnRecord({
      blocks: [
        {
          kind: "text",
          text: "hi",
          original_utf8_bytes: 2,
          original_characters: 2,
          truncated: false,
          truncated_by: [],
        },
      ],
      capture: {
        limits: DEFAULT_ROLE_TURN_LIMITS,
        source: { utf8_bytes: 2, characters: 2, blocks: 1 },
        captured: { utf8_bytes: 2, characters: 2, blocks: 2 },
        omitted: { utf8_bytes: 0, characters: 0, blocks: 0 },
        limit_causes: [],
        saturated: [],
      },
    });
    expect(() => log.append(bad)).toThrow();
    expect(log.records("run-rt")).toEqual([]);
  });
});

// ─── Issue #68 — file-backed role_turn rejection on read ─────────────

/** Append one raw (unvalidated) JSONL row to a run log file, bypassing append validation. */
async function writeRawRoleTurnRow(
  dir: string,
  runId: string,
  row: RoleTurnRecord | Record<string, unknown>,
): Promise<void> {
  const filePath = join(dir, `${runId}.jsonl`);
  appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf8");
}

describe("issue #68 — file-backed role_turn rejection on read (spec §7.1)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "conductormat-rt-read-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects a role_turn row carrying an unknown key when the file is read", async () => {
    await writeRawRoleTurnRow(dir, "run-badkey", {
      ...roleTurnRecord(),
      transcript_fragment: "pii",
    } as unknown as RoleTurnRecord);
    const read = new FileRecordLog({ baseDir: dir });
    expect(() => read.records("run-badkey")).toThrow();
    read.close();
  });

  it("rejects a role_turn row whose captured.measure mismatches the retained blocks on read", async () => {
    const bad = roleTurnRecord({
      blocks: [
        {
          kind: "text",
          text: "hi",
          original_utf8_bytes: 2,
          original_characters: 2,
          truncated: false,
          truncated_by: [],
        },
      ],
      capture: {
        limits: DEFAULT_ROLE_TURN_LIMITS,
        source: { utf8_bytes: 2, characters: 2, blocks: 1 },
        captured: { utf8_bytes: 2, characters: 2, blocks: 2 },
        omitted: { utf8_bytes: 0, characters: 0, blocks: 0 },
        limit_causes: [],
        saturated: [],
      },
    });
    await writeRawRoleTurnRow(dir, "run-badmeasure", bad);
    const read = new FileRecordLog({ baseDir: dir });
    expect(() => read.records("run-badmeasure")).toThrow();
    read.close();
  });

  it("rejects a role_turn row whose retained block exceeds the per-block byte cap on read", async () => {
    const bad = roleTurnRecord({
      capture: {
        limits: { ...DEFAULT_ROLE_TURN_LIMITS, max_block_utf8_bytes: 2 },
        source: { utf8_bytes: 3, characters: 3, blocks: 1 },
        captured: { utf8_bytes: 3, characters: 3, blocks: 1 },
        omitted: { utf8_bytes: 0, characters: 0, blocks: 0 },
        limit_causes: [],
        saturated: [],
      },
      blocks: [
        {
          kind: "text",
          text: "abc",
          original_utf8_bytes: 3,
          original_characters: 3,
          truncated: false,
          truncated_by: [],
        },
      ],
    });
    await writeRawRoleTurnRow(dir, "run-blockcap", bad);
    const read = new FileRecordLog({ baseDir: dir });
    expect(() => read.records("run-blockcap")).toThrow();
    read.close();
  });

  it("rejects a role_turn row whose captured bytes exceed the per-turn byte cap on read", async () => {
    const bad = roleTurnRecord({
      capture: {
        limits: { ...DEFAULT_ROLE_TURN_LIMITS, max_turn_utf8_bytes: 2 },
        source: { utf8_bytes: 3, characters: 3, blocks: 1 },
        captured: { utf8_bytes: 3, characters: 3, blocks: 1 },
        omitted: { utf8_bytes: 0, characters: 0, blocks: 0 },
        limit_causes: [],
        saturated: [],
      },
      blocks: [
        {
          kind: "text",
          text: "abc",
          original_utf8_bytes: 3,
          original_characters: 3,
          truncated: false,
          truncated_by: [],
        },
      ],
    });
    await writeRawRoleTurnRow(dir, "run-turncap", bad);
    const read = new FileRecordLog({ baseDir: dir });
    expect(() => read.records("run-turncap")).toThrow();
    read.close();
  });

  it("rejects a role_turn row whose limit_causes is empty while a block is truncated on read", async () => {
    // A truncated block requires a matching cause; an empty limit_causes here is
    // corrupt metadata that must be rejected at the file-read boundary (§7.1).
    const bad = roleTurnRecord({
      blocks: [
        {
          kind: "text",
          text: "éé",
          original_utf8_bytes: 6,
          original_characters: 3,
          truncated: true,
          truncated_by: ["block"],
        },
      ],
      capture: {
        limits: DEFAULT_ROLE_TURN_LIMITS,
        source: { utf8_bytes: 6, characters: 3, blocks: 1 },
        captured: { utf8_bytes: 4, characters: 2, blocks: 1 },
        omitted: { utf8_bytes: 2, characters: 1, blocks: 0 },
        limit_causes: [],
        saturated: [],
      },
    });
    await writeRawRoleTurnRow(dir, "run-limitcauses", bad);
    const read = new FileRecordLog({ baseDir: dir });
    expect(() => read.records("run-limitcauses")).toThrow();
    read.close();
  });

  it("rejects a role_turn row whose 'block' saturation is false on read", async () => {
    // No retained block equals the per-block maximum, so claiming 'block'
    // saturation is corrupt and must be rejected on read (§7.1).
    const bad = roleTurnRecord({
      capture: {
        limits: { ...DEFAULT_ROLE_TURN_LIMITS, max_block_utf8_bytes: 5 },
        source: { utf8_bytes: 2, characters: 2, blocks: 1 },
        captured: { utf8_bytes: 2, characters: 2, blocks: 1 },
        omitted: { utf8_bytes: 0, characters: 0, blocks: 0 },
        limit_causes: [],
        saturated: ["block"],
      },
      blocks: [
        {
          kind: "text",
          text: "hi",
          original_utf8_bytes: 2,
          original_characters: 2,
          truncated: false,
          truncated_by: [],
        },
      ],
    });
    await writeRawRoleTurnRow(dir, "run-blocksat", bad);
    const read = new FileRecordLog({ baseDir: dir });
    expect(() => read.records("run-blocksat")).toThrow();
    read.close();
  });

  it("still reads a historical file that never produced a role_turn", async () => {
    await writeRawRoleTurnRow(dir, "run-hist2", {
      type: "session_started",
      run_id: "run-hist2",
      role: "orchestrator",
      visit_index: 1,
      state: "orchestrator",
      model: null,
      session_file: "/tmp/hist2.jsonl",
      parent_session: null,
      ts: 1,
    } as unknown as RoleTurnRecord);
    const read = new FileRecordLog({ baseDir: dir });
    const rows = read.records("run-hist2");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("session_started");
    read.close();
  });
});
