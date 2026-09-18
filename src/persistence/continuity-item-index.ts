/** Validated chronological continuity item identity index — spec §6.2, §10. */
import { Value } from "typebox/value";
import type { ContinuityPacketV1 } from "../seam/continuity.js";
import { continuityPacketV1Schema } from "../seam/continuity.js";
import type { PersistedRecord } from "./log.js";

export interface ContinuityIndexedPacket {
  readonly record_id: string;
  readonly packet: ContinuityPacketV1;
}

/** Fail-closed identity error for an append-only continuity history. */
export class ContinuityItemIndexError extends Error {
  constructor(
    readonly record_id: string,
    message: string,
  ) {
    super(message);
    this.name = "ContinuityItemIndexError";
  }
}

/** One global, chronological item index shared by transport validation and replay. */
export interface ContinuityItemIndex {
  readonly ids: ReadonlySet<string>;
  readonly superseded_by: ReadonlyMap<string, readonly string[]>;
}

/** Build the unique identity/supersession index from packets in append order. */
export function buildContinuityItemIndex(
  packets: readonly ContinuityIndexedPacket[],
): ContinuityItemIndex {
  const ids = new Set<string>();
  const superseded = new Map<string, string[]>();
  for (const entry of packets) {
    if (!Value.Check(continuityPacketV1Schema, entry.packet)) {
      throw new ContinuityItemIndexError(entry.record_id, "continuity packet fails TypeBox schema");
    }
    for (const item of orderedItems(entry.packet)) {
      if (ids.has(item.id)) {
        throw new ContinuityItemIndexError(
          entry.record_id,
          `duplicate global item id '${item.id}'`,
        );
      }
      for (const target of item.supersedes) {
        if (target === item.id || !ids.has(target)) {
          throw new ContinuityItemIndexError(
            entry.record_id,
            `supersedes target '${target}' is not an earlier item`,
          );
        }
        superseded.get(target)?.push(item.id);
      }
      ids.add(item.id);
      superseded.set(item.id, []);
    }
  }
  return Object.freeze({
    ids: new Set(ids),
    superseded_by: new Map(
      [...superseded].map(([id, replacements]) => [id, Object.freeze([...replacements])]),
    ),
  });
}

/** Extract earlier accepted packet identities for one run; malformed history is never ignored. */
export function continuityItemIndexFromRecords(
  records: readonly PersistedRecord[],
  runId: string,
): ContinuityItemIndex {
  const packets: ContinuityIndexedPacket[] = [];
  for (let ordinal = 0; ordinal < records.length; ordinal += 1) {
    const record = records[ordinal];
    if (record === undefined || recordRunId(record) !== runId) continue;
    const packet = packetFromRecord(record, recordIdentity(record, ordinal));
    if (packet === undefined) continue;
    if (!isPacket(packet)) {
      throw new ContinuityItemIndexError(
        recordIdentity(record, ordinal),
        "continuity packet is invalid",
      );
    }
    packets.push({ record_id: recordIdentity(record, ordinal), packet });
  }
  return buildContinuityItemIndex(packets);
}

function orderedItems(packet: ContinuityPacketV1) {
  return [packet.findings, packet.evaluations, packet.open_questions, packet.next_steps].flat();
}

function packetFromRecord(record: PersistedRecord, identity: string): unknown {
  if (record.type === "transition_accepted") {
    const handoff = record.accepted_handoff;
    if (handoff === undefined) return undefined;
    const hasEvidence = handoff.continuity_evidence !== undefined;
    const hasBytes = handoff.continuity_packet_utf8_bytes !== undefined;
    // Generic legacy payloads are not continuity envelopes. Only an accepted
    // handoff with both host-authored siblings participates in identity
    // validation; partial metadata is corrupt durable history.
    if (!hasEvidence && !hasBytes) return undefined;
    if (!hasEvidence || !hasBytes)
      throw new ContinuityItemIndexError(identity, "handoff continuity metadata is partial");
    const payload = handoff.payload;
    if (!isObject(payload) || !("continuity" in payload))
      throw new ContinuityItemIndexError(identity, "handoff continuity metadata lacks packet");
    return payload.continuity;
  }
  return record.type === "subagent_completed" ? record.continuity?.packet : undefined;
}

function isPacket(value: unknown): value is ContinuityPacketV1 {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordRunId(record: PersistedRecord): string {
  return record.type === "checkpoint_snapshot" ? record.checkpoint.run_id : record.run_id;
}

function recordIdentity(record: PersistedRecord, ordinal: number): string {
  const session = "session_file" in record ? record.session_file : undefined;
  const timestamp =
    record.type === "checkpoint_snapshot" ? record.checkpoint.updated_at : record.ts;
  return `${record.type}:${session ?? timestamp}:${ordinal}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
