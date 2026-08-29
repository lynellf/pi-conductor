/**
 * Bounded structured role-turn telemetry — Issue #68.
 *
 * Strict `role_turn` record validation at persistence boundaries (§7.1). This
 * submodule owns the capture-object `limits` field validation: exact limit keys,
 * positive safe integer fields, and the bounded-chain inequalities. The
 * capture arithmetic that consumes the validated limits lives in
 * `role-turn-validate-capture.ts`. Pure, side-effect-free.
 */

import {
  isPlainObject,
  isPositiveSafeInteger,
  ROLE_TURN_SCOPE_KEYS,
  RoleTurnTelemetryLogError,
} from "./role-turn-model.js";

/** Enforce exact limit keys, positive safe integer fields, and the bounded chain (§5.1). */
export function assertRoleTurnLimits(limits: unknown): void {
  if (!isPlainObject(limits)) {
    throw new RoleTurnTelemetryLogError("role_turn capture limits must be an object");
  }
  const typed = limits as Record<string, unknown>;
  const allowed = ROLE_TURN_SCOPE_KEYS;
  const knownLimits = new Set<string>(allowed);
  const known = new Set(Object.keys(typed));
  for (const key of known) {
    if (!knownLimits.has(key)) {
      throw new RoleTurnTelemetryLogError(`role_turn capture limits has unexpected key '${key}'`);
    }
  }
  for (const key of allowed) {
    if (!(key in typed)) {
      throw new RoleTurnTelemetryLogError(`role_turn capture limits is missing key '${key}'`);
    }
    if (!isPositiveSafeInteger(typed[key])) {
      throw new RoleTurnTelemetryLogError(
        `role_turn limits field '${key}' must be a positive safe integer`,
      );
    }
  }

  // The persisted record must itself satisfy the bounded-chain inequalities (§5.1),
  // not merely each field be a positive integer. This closes a persistence boundary
  // where a malicious/buggy record could carry an internally inconsistent limit set.
  assertRoleTurnBoundedChain(typed);
}

/** Enforce the bounded-chain inequalities on a persisted limit set (§5.1). */
function assertRoleTurnBoundedChain(limits: Record<string, unknown>): void {
  const required = ROLE_TURN_SCOPE_KEYS;
  for (const key of required) {
    if (!isPositiveSafeInteger(limits[key])) return; // already reported by assertRoleTurnLimits
  }
  const scope = limits as Record<(typeof ROLE_TURN_SCOPE_KEYS)[number], number>;
  if (scope.max_block_utf8_bytes > scope.max_turn_utf8_bytes) {
    throw new RoleTurnTelemetryLogError(
      "role_turn persisted limits violate max_block_utf8_bytes <= max_turn_utf8_bytes",
    );
  }
  if (
    scope.max_turn_utf8_bytes > scope.max_session_utf8_bytes ||
    scope.max_session_utf8_bytes > scope.max_run_utf8_bytes
  ) {
    throw new RoleTurnTelemetryLogError(
      "role_turn persisted limits violate max_turn_utf8_bytes <= max_session_utf8_bytes <= max_run_utf8_bytes",
    );
  }
  if (scope.max_session_turns > scope.max_run_turns) {
    throw new RoleTurnTelemetryLogError(
      "role_turn persisted limits violate max_session_turns <= max_run_turns",
    );
  }
  if (scope.max_turn_blocks < 1) {
    throw new RoleTurnTelemetryLogError("role_turn persisted limit max_turn_blocks must be >= 1");
  }
}
