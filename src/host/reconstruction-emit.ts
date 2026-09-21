/**
 * Issue #139 Phase 3: bounded reconstruction-signal emission seam.
 *
 * Drains host-observed tool uses from a fresh session, classifies them
 * with the conservative classifier, redacts commands to hash-only
 * fingerprints, and persists audit-only `reconstruction_signal` records.
 * Signals never affect routing and never claim to observe direct
 * filesystem reads (explicit blind spot).
 */

import type { Role } from "../core/types.js";
import type { PhaseWorkPacketRecord } from "../persistence/phase-work-packet.js";
import type { Host, RoleSession } from "./host.js";
import {
  classifyBashCommand,
  classifyHostTool,
  fingerprintCommand,
  normalizeCommand,
} from "./reconstruction-classifier.js";

const MAX_SIGNALS_PER_SESSION = 16;

/** Drain, classify, and persist audit-only signals for one fresh session. */
export function emitReconstructionSignals(args: {
  readonly host: Host;
  readonly session: RoleSession;
  readonly packet: PhaseWorkPacketRecord;
  readonly runId: string;
  readonly recipientRole: Role;
  readonly recipientVisitIndex: number;
}): void {
  const raw = args.session.takeReconstructionSignals?.() ?? [];
  let emitted = 0;
  for (const entry of raw) {
    if (emitted >= MAX_SIGNALS_PER_SESSION) break;
    const hostKind = classifyHostTool(entry.tool);
    if (hostKind !== null) {
      args.host.persistRecord({
        type: "reconstruction_signal",
        schema_version: 1,
        run_id: args.runId,
        recipient_role: String(args.recipientRole),
        recipient_visit_index: args.recipientVisitIndex,
        packet_dispatch_kind: args.packet.dispatch_source.kind,
        packet_dispatch_ts: args.packet.dispatch_source.ts,
        kind: hostKind,
        command_fingerprint: null,
        ts: Date.now(),
      });
      emitted += 1;
      continue;
    }
    if (entry.tool === "bash" && entry.command !== undefined) {
      const kind = classifyBashCommand(entry.command);
      if (kind === null) continue;
      args.host.persistRecord({
        type: "reconstruction_signal",
        schema_version: 1,
        run_id: args.runId,
        recipient_role: String(args.recipientRole),
        recipient_visit_index: args.recipientVisitIndex,
        packet_dispatch_kind: args.packet.dispatch_source.kind,
        packet_dispatch_ts: args.packet.dispatch_source.ts,
        kind,
        command_fingerprint: fingerprintCommand(normalizeCommand(entry.command)),
        ts: Date.now(),
      });
      emitted += 1;
    }
  }
}
