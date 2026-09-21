/**
 * Public export surface for the durable host-observed handoff-evidence
 * contracts shipped through the `pi-conductor` barrel.
 *
 * Covers the Phase 2 record schema (`src/persistence/handoff-evidence-schema.ts`)
 * and the Phase 4 seed projection (`src/persistence/handoff-evidence-seed.ts`).
 * The Phase 1 manifest policy is already exported; this pins the persistence
 * contracts so consumers do not traverse internal modules (issue #135,
 * Phase 5 — integration, docs, final review).
 */

import { describe, expect, it } from "vitest";
import type { HandoffEvidenceRecord } from "../src/index.js";
import {
  assertHandoffEvidenceRecord,
  commandCaptureSchema,
  dirtyPathSchema,
  HANDOFF_EVIDENCE_MAX_COMMAND_IDENTITY_CHARS,
  HANDOFF_EVIDENCE_MAX_COMMANDS,
  HANDOFF_EVIDENCE_MAX_DIRTY_PATHS,
  HANDOFF_EVIDENCE_MAX_OUTPUT_HEAD_BYTES,
  handoffEvidenceRecordSchema,
  handoffUnavailableSchema,
  isHandoffEvidenceRecord,
  omittedSchema,
  projectHandoffEvidence,
  worktreeSnapshotSchema,
} from "../src/index.js";

describe("handoff-evidence public API (issue #135 Phase 5)", () => {
  it("exports the Phase 2 schema + guards from the barrel", () => {
    expect(commandCaptureSchema).toBeDefined();
    expect(dirtyPathSchema).toBeDefined();
    expect(worktreeSnapshotSchema).toBeDefined();
    expect(handoffUnavailableSchema).toBeDefined();
    expect(omittedSchema).toBeDefined();
    expect(handoffEvidenceRecordSchema).toBeDefined();
    expect(isHandoffEvidenceRecord).toBeTypeOf("function");
    expect(assertHandoffEvidenceRecord).toBeTypeOf("function");
  });

  it("exports the Phase 4 projection from the barrel", () => {
    expect(projectHandoffEvidence).toBeTypeOf("function");
  });

  it("re-exports the enforced bounds so consumers need not reach the manifest module", () => {
    expect(HANDOFF_EVIDENCE_MAX_DIRTY_PATHS).toBe(64);
    expect(HANDOFF_EVIDENCE_MAX_COMMANDS).toBe(16);
    expect(HANDOFF_EVIDENCE_MAX_COMMAND_IDENTITY_CHARS).toBe(512);
    expect(HANDOFF_EVIDENCE_MAX_OUTPUT_HEAD_BYTES).toBe(1024);
  });

  it("a valid record passes the guard and rejects a malformed record", () => {
    const record: HandoffEvidenceRecord = {
      type: "handoff_evidence",
      schema_version: 1,
      run_id: "run-1",
      handoff_id: "handoff-1",
      ts: 1000,
      worktree: { head: "deadbeef", dirty_paths: [] },
      commands: [],
      omitted: { dirty_paths: 0, commands: 0 },
    };
    expect(isHandoffEvidenceRecord(record)).toBe(true);
    expect(() => assertHandoffEvidenceRecord(record)).not.toThrow();
    // A malformed record (missing field) is rejected by the guard.
    expect(isHandoffEvidenceRecord({ type: "handoff_evidence" })).toBe(false);
    expect(() => assertHandoffEvidenceRecord({ type: "handoff_evidence" })).toThrow();
  });

  it("projection is a pure function over records (no evidence projects an empty list)", () => {
    const items = projectHandoffEvidence([], "run-1");
    expect(items).toHaveLength(0);
  });
});
