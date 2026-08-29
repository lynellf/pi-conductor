/**
 * Bounded structured role-turn telemetry — Issue #68.
 *
 * Run / session counter reconstruction from durable `role_turn` records on
 * resume (§7.5). Verifies contiguous 1-based sequences, immutable identity per
 * logical session, counters no greater than their limits, one resolved limit
 * set for the run, and the exact prospective `saturated` state on each record.
 * A mismatch throws a typed log or configuration error before any role session
 * is spawned or prompted. Pure, side-effect-free.
 */

import type { Role } from "../core/types.js";
import { computeRoleTurnSaturated } from "./role-turn-capture.js";
import { assertRoleTurnLimitsEqual } from "./role-turn-limits.js";
import {
  type RoleTurnRecord,
  type RoleTurnTelemetryLimits,
  RoleTurnTelemetryLogError,
} from "./role-turn-model.js";
import { assertRoleTurnRecord } from "./role-turn-validate.js";

/** Reconstructed run-scoped telemetry state a live ledger seeds from (resume). */
export interface RoleTurnLedgerState {
  readonly nextSequence: number;
  readonly runCapturedBytes: number;
  readonly runTurns: number;
  readonly sessions: ReadonlyMap<string, RoleTurnSessionState>;
  readonly identity: ReadonlyMap<string, RoleTurnIdentity>;
  /** The resolved limit set reconstructed from the stream. */
  readonly limits: RoleTurnTelemetryLimits;
}

/** Per-logical-session captured byte + record-count counters reconstructed on resume. */
export interface RoleTurnSessionState {
  readonly bytes: number;
  readonly turns: number;
}

/** Immutable per-logical-session identity verified during reconstruction. */
export interface RoleTurnIdentity {
  readonly role: Role;
  readonly conversationId: string;
  readonly sessionFile: string;
}

/**
 * Reconstruct run / session captured-byte and record-count counters from
 * validated durable `role_turn` records in append order (§7.5). Returns the
 * state a live ledger seeds from.
 */
export function rebuildRoleTurnLedger(
  roleTurns: readonly RoleTurnRecord[],
  limits: RoleTurnTelemetryLimits,
): RoleTurnLedgerState {
  let runBytes = 0;
  let runTurns = 0;
  let prevSequence = 0;
  const sessions = new Map<string, RoleTurnSessionState>();
  const identity = new Map<string, RoleTurnIdentity>();

  roleTurns.forEach((record, index) => {
    assertRoleTurnRecord(record);

    // §5.1 / §7.5: one resolved limit set for the run — every durable record must
    // carry the exact resolved limit set the host supplies. A mismatch is a config
    // error raised before any role session is spawned or prompted.
    assertRoleTurnLimitsEqual(record.capture.limits, limits);

    // Contiguous, 1-based run-scoped sequence (§3.2 / §7.5).
    if (record.sequence !== prevSequence + 1) {
      throw new RoleTurnTelemetryLogError(
        `role_turn sequence ${String(record.sequence)} is not contiguous (expected ${String(
          index + 1,
        )})`,
      );
    }
    prevSequence = record.sequence;

    const session = sessions.get(record.role_session_id) ?? { bytes: 0, turns: 0 };
    const sessionBytesAfter = session.bytes + record.capture.captured.utf8_bytes;
    const sessionTurnsAfter = session.turns + 1;
    const runBytesAfter = runBytes + record.capture.captured.utf8_bytes;
    const runTurnsAfter = runTurns + 1;

    // Counters may never exceed their limits (§7.5).
    if (sessionBytesAfter > limits.max_session_utf8_bytes) {
      throw new RoleTurnTelemetryLogError(
        `role_turn session '${record.role_session_id}' captured bytes exceed its limit`,
      );
    }
    if (runBytesAfter > limits.max_run_utf8_bytes) {
      throw new RoleTurnTelemetryLogError("role_turn run captured bytes exceed its limit");
    }
    if (sessionTurnsAfter > limits.max_session_turns) {
      throw new RoleTurnTelemetryLogError(
        `role_turn session '${record.role_session_id}' record count exceeds its limit`,
      );
    }
    if (runTurnsAfter > limits.max_run_turns) {
      throw new RoleTurnTelemetryLogError("role_turn run record count exceeds its limit");
    }

    // Immutable identity per logical session (§3.2 / §7.5).
    const prior = identity.get(record.role_session_id);
    const nextIdentity: RoleTurnIdentity = {
      role: record.role,
      conversationId: record.conversation_id,
      sessionFile: record.session_file,
    };
    if (prior !== undefined) {
      if (prior.role !== nextIdentity.role) {
        throw new RoleTurnTelemetryLogError(
          `role_turn logical session '${record.role_session_id}' role changed across records`,
        );
      }
      if (prior.conversationId !== nextIdentity.conversationId) {
        throw new RoleTurnTelemetryLogError(
          `role_turn logical session '${record.role_session_id}' conversation changed across records`,
        );
      }
      if (prior.sessionFile !== nextIdentity.sessionFile) {
        throw new RoleTurnTelemetryLogError(
          `role_turn logical session '${record.role_session_id}' session file changed across records`,
        );
      }
    }
    identity.set(record.role_session_id, nextIdentity);

    // Exact prospective `saturated` state on each record (§5.3 / §7.5).
    const expectedSaturated = computeRoleTurnSaturated(
      record.capture.captured,
      record.blocks,
      sessionBytesAfter,
      runBytesAfter,
      sessionTurnsAfter,
      runTurnsAfter,
      limits,
    );
    const actualSaturated = record.capture.saturated;
    if (expectedSaturated.length !== actualSaturated.length) {
      throw new RoleTurnTelemetryLogError(
        `role_turn record at sequence ${String(record.sequence)} saturated set does not match its reconstructed counters`,
      );
    }
    for (let scopeIndex = 0; scopeIndex < expectedSaturated.length; scopeIndex += 1) {
      if (expectedSaturated[scopeIndex] !== actualSaturated[scopeIndex]) {
        throw new RoleTurnTelemetryLogError(
          `role_turn record at sequence ${String(record.sequence)} saturated set does not match its reconstructed counters`,
        );
      }
    }

    // Advance reconstructed counters.
    sessions.set(record.role_session_id, {
      bytes: sessionBytesAfter,
      turns: sessionTurnsAfter,
    });
    runBytes = runBytesAfter;
    runTurns = runTurnsAfter;
  });

  return {
    nextSequence: prevSequence + 1,
    runCapturedBytes: runBytes,
    runTurns,
    sessions: Object.freeze(new Map(sessions)),
    identity: Object.freeze(new Map(identity)),
    limits: Object.freeze({ ...limits }),
  };
}
