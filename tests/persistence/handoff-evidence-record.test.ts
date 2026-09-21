import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  assertHandoffEvidenceRecord,
  HANDOFF_EVIDENCE_MAX_COMMAND_IDENTITY_CHARS,
  HANDOFF_EVIDENCE_MAX_COMMANDS,
  HANDOFF_EVIDENCE_MAX_DIRTY_PATHS,
  HANDOFF_EVIDENCE_MAX_OUTPUT_HEAD_BYTES,
  HandoffEvidenceRecordError,
  handoffEvidenceRecordSchema,
  isHandoffEvidenceRecord,
} from "../../src/persistence/handoff-evidence-schema.js";
import { InMemoryRecordLog } from "../../src/persistence/in-memory-log.js";
import type { PersistedRecord } from "../../src/persistence/log.js";

/**
 * Build a minimal but fully-valid host-observed handoff-evidence record.
 *
 * Every record the host writes into the durable log is host-shaped: the
 * command identity, the host-observed exit status, the measured duration, the
 * output digest, and the redacted head are all host facts — nothing the model
 * authors. There is deliberately no exported constructor factory for this
 * record; the host collection path builds the plain object directly (Phase 3).
 */
function buildRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "handoff_evidence",
    schema_version: 1,
    run_id: "run-0001",
    handoff_id: "handoff-0001",
    ts: 1_700_000_000_000,
    worktree: {
      head: "abc123def456",
      dirty_paths: [{ path: "src/foo.ts", preexisting: false }],
    },
    commands: [
      {
        command: "git status --porcelain -z",
        host_exit_status: 0,
        elapsed_ms: 12,
        output_digest: "a".repeat(64),
        output_head: "",
      },
    ],
    omitted: { dirty_paths: 0, commands: 0 },
    ...overrides,
  };
}

describe("handoff_evidence record schema", () => {
  it("accepts a well-formed host-shaped record (round-trip through the schema)", () => {
    const record = buildRecord();
    expect(Value.Check(handoffEvidenceRecordSchema, record)).toBe(true);
    expect(isHandoffEvidenceRecord(record as never)).toBe(true);
  });

  it("round-trips through JSON unchanged (schema stable across serialization)", () => {
    const record = buildRecord();
    const reparsed = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
    expect(Value.Check(handoffEvidenceRecordSchema, reparsed)).toBe(true);
  });

  it("rejects unknown (model-facing) keys — additionalProperties is false", () => {
    const record = buildRecord({ summary: "all tests passed and were verified" });
    expect(Value.Check(handoffEvidenceRecordSchema, record)).toBe(false);
  });

  it("rejects an unknown unavailability reason code", () => {
    const record = buildRecord({
      worktree: { kind: "unavailable", reason: "temporarily_disabled", detail: "ok" },
    });
    expect(Value.Check(handoffEvidenceRecordSchema, record)).toBe(false);
  });

  it("rejects an over-bound commands list (more than the policy cap)", () => {
    const tooMany = {
      commands: Array.from({ length: HANDOFF_EVIDENCE_MAX_COMMANDS + 1 }, (_v, i) => ({
        command: `cmd-${i}`,
        host_exit_status: 0,
        elapsed_ms: 1,
        output_digest: "a".repeat(64),
        output_head: "",
      })),
    };
    const record = buildRecord(tooMany);
    expect(Value.Check(handoffEvidenceRecordSchema, record)).toBe(false);
  });

  it("rejects an over-bound dirty-paths list (more than the policy cap)", () => {
    const tooManyPaths = {
      worktree: {
        head: "abc123def456",
        dirty_paths: Array.from({ length: HANDOFF_EVIDENCE_MAX_DIRTY_PATHS + 1 }, (_v, i) => ({
          path: `src/file-${i}.ts`,
          preexisting: false,
        })),
      },
    };
    const record = buildRecord(tooManyPaths);
    expect(Value.Check(handoffEvidenceRecordSchema, record)).toBe(false);
  });

  it("rejects a command identity that exceeds the character cap", () => {
    const record = buildRecord({
      commands: [
        {
          command: "x".repeat(HANDOFF_EVIDENCE_MAX_COMMAND_IDENTITY_CHARS + 1),
          host_exit_status: 0,
          elapsed_ms: 1,
          output_digest: "a".repeat(64),
          output_head: "",
        },
      ],
    });
    expect(Value.Check(handoffEvidenceRecordSchema, record)).toBe(false);
  });

  it("rejects a redacted output head beyond the byte cap", () => {
    const record = buildRecord({
      commands: [
        {
          command: "echo hi",
          host_exit_status: 0,
          elapsed_ms: 1,
          output_digest: "a".repeat(64),
          output_head: "b".repeat(HANDOFF_EVIDENCE_MAX_OUTPUT_HEAD_BYTES + 1),
        },
      ],
    });
    expect(() => assertHandoffEvidenceRecord(record as never)).toThrow(HandoffEvidenceRecordError);
  });

  it("rejects a model-narrative claim lacking the host-shaped facts", () => {
    const record = buildRecord({
      commands: [],
      worktree: { head: "abc123def456", dirty_paths: [] },
      omitted: { dirty_paths: 0, commands: 0 },
    }) as Record<string, unknown>;
    // Drop every captured command so only a narrative shell remains.
    const narrative: Record<string, unknown> = { ...record };
    narrative.worktree = { kind: "unavailable", reason: "unavailable" };
    expect(() => assertHandoffEvidenceRecord(narrative as never)).toThrow(
      HandoffEvidenceRecordError,
    );
    expect(isHandoffEvidenceRecord(narrative as never)).toBe(false);
  });
});

describe("handoff_evidence record in the in-memory log", () => {
  it("append + replay preserves the evidence record byte-for-byte", () => {
    const log = new InMemoryRecordLog();
    const record = buildRecord();
    log.append(record as never as PersistedRecord);
    const stored = log.records("run-0001");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual(record);
    log.close();
  });

  it("rejects an invalid record at append time (no silent fallback)", () => {
    const log = new InMemoryRecordLog();
    const invalid = buildRecord({
      commands: Array.from({ length: HANDOFF_EVIDENCE_MAX_COMMANDS + 1 }, (_v, i) => ({
        command: `cmd-${i}`,
        host_exit_status: 0,
        elapsed_ms: 1,
        output_digest: "a".repeat(64),
        output_head: "",
      })),
    });
    expect(() => log.append(invalid as never as PersistedRecord)).toThrow(
      HandoffEvidenceRecordError,
    );
    expect(log.records("run-0001")).toHaveLength(0);
    log.close();
  });
});
