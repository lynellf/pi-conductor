/**
 * Issue #139 Phase 1: FileRecordLog append/replay round-trip for
 * `phase_work_packet` records.
 *
 * The packet is part of the durable `PersistedRecord` union; the
 * file-backed log must accept and replay it just like any other
 * persisted record (spec §11.1). The parser gate (`PERSISTED_RECORD_TYPES`)
 * and the materialization guard are the two boundaries this exercise
 * walks in lockstep.
 *
 * RED contract: append a packet, close the log, reopen it, and read
 * the records back; the replayed record must be byte-identical to the
 * original. Prior to GREEN the parser will reject `phase_work_packet`
 * with an `Unknown persisted record type` error and this test will fail
 * at the `replay` boundary, which is exactly the missing-behavior.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileRecordLog } from "../../src/host/log-file.js";
import type { PersistedRecord } from "../../src/persistence/log.js";
import {
  createPhaseWorkPacketRecord,
  type PhaseWorkPacketRecord,
} from "../../src/persistence/phase-work-packet.js";

describe("phase_work_packet — FileRecordLog round-trip (issue #139 §Packet and persistence contract)", () => {
  it("appends and replays a phase_work_packet record via FileRecordLog", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "phase-work-packet-file-"));
    try {
      const record: PhaseWorkPacketRecord = createPhaseWorkPacketRecord({
        run_id: "run-file-001",
        recipient_role: "implementer",
        recipient_visit_index: 1,
        dispatch_source: {
          kind: "initial_run",
          run_id: "run-file-001",
          initial_goal: "ship the phase-1 packet contract",
          ts: 1_700_000_000_000,
        },
        cutoff_record_keys: [],
        records: [],
      });

      const writer = new FileRecordLog({ baseDir });
      writer.append(record as unknown as PersistedRecord);
      writer.close();

      const reader = new FileRecordLog({ baseDir });
      const replayed = reader.records("run-file-001");
      reader.close();

      expect(replayed).toHaveLength(1);
      const roundTripped = replayed[0];
      if (roundTripped === undefined) throw new Error("expected replayed record");
      expect(roundTripped.type).toBe("phase_work_packet");
      expect((roundTripped as PhaseWorkPacketRecord).rendered).toBe(record.rendered);
      expect((roundTripped as PhaseWorkPacketRecord).utf8_bytes).toBe(record.utf8_bytes);
      expect((roundTripped as PhaseWorkPacketRecord).recipient_role).toBe("implementer");
      expect((roundTripped as PhaseWorkPacketRecord).dispatch_source.kind).toBe("initial_run");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("appends and replays a phase_work_packet record whose source is a review_route dispatch", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "phase-work-packet-file-"));
    try {
      const record: PhaseWorkPacketRecord = createPhaseWorkPacketRecord({
        run_id: "run-file-002",
        recipient_role: "implementer",
        recipient_visit_index: 2,
        dispatch_source: {
          kind: "review_route",
          run_id: "run-file-002",
          source_record_key: "review_route:0",
          route_role: "implementer",
          advances_phase: true,
          ts: 1_700_000_000_010,
        },
        cutoff_record_keys: [],
        records: [],
      });

      const log = new FileRecordLog({ baseDir });
      log.append(record as unknown as PersistedRecord);
      log.close();

      const reader = new FileRecordLog({ baseDir });
      const replayed = reader.records("run-file-002");
      reader.close();
      expect(replayed).toHaveLength(1);
      const roundTripped = replayed[0] as PhaseWorkPacketRecord;
      expect(roundTripped.dispatch_source.kind).toBe("review_route");
      if (roundTripped.dispatch_source.kind === "review_route") {
        expect(roundTripped.dispatch_source.route_role).toBe("implementer");
        expect(roundTripped.dispatch_source.advances_phase).toBe(true);
      }
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
