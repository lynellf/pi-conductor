/**
 * Bounded structured role-turn telemetry — Issue #68.
 *
 * Config overlay + constraint resolution for the additive `role_turn` record
 * (§5.1). A partial `limits` option overlays the fully-resolved defaults and is
 * resolved before a host subscribes to a role session. This submodule is pure
 * and never performs I/O.
 */

import {
  DEFAULT_ROLE_TURN_LIMITS,
  isPlainObject,
  isPositiveSafeInteger,
  type ResolvedRoleTurnTelemetry,
  ROLE_TURN_SCOPE_KEYS,
  RoleTurnConfigurationError,
  type RoleTurnTelemetryLimits,
  type RoleTurnTelemetryOptions,
} from "./role-turn-model.js";

/**
 * Overlay a partial limits configuration onto the defaults and resolve it,
 * returning `enabled` + a fully-resolved limit set (§5.1). A provided limit must
 * be a positive safe integer; the resolved set must satisfy the bounded-chain
 * inequalities in §5.1. A violation throws `RoleTurnConfigurationError`.
 */
export function resolveRoleTurnLimits(
  options: RoleTurnTelemetryOptions | undefined,
  defaults: RoleTurnTelemetryLimits = DEFAULT_ROLE_TURN_LIMITS,
): ResolvedRoleTurnTelemetry {
  // §5.1: an omitted option (`undefined`, the undefined-only default threaded by the
  // public host / factory paths) resolves to enabled + the fully-resolved defaults. A
  // runtime `null` / array / Date / class instance is NOT the default and is rejected
  // below — it must never be silently coerced into default-enabled behavior.
  if (options === undefined) {
    return { enabled: true, limits: Object.freeze({ ...defaults }) };
  }
  // §5.1: strictly validate the option object itself before reading its fields. A
  // non-plain object (null, array, class instance) or a wrong-typed field must not
  // be silently coerced into the default-enabled / default-limits behavior.
  if (!isPlainObject(options)) {
    throw new RoleTurnConfigurationError(
      "role_turn telemetry option must be a plain object with optional `enabled` and `limits`",
    );
  }
  // Reject unknown top-level keys so a caller cannot inject a field that silently
  // disappears into the default-enabled / default-limits behavior (remediation §1).
  // `enabled` and `limits` are the only allowed top-level keys. This runs before the
  // field-type checks so an unknown key is reported as unknown, never misattributed.
  for (const key of Object.keys(options)) {
    if (key !== "enabled" && key !== "limits") {
      throw new RoleTurnConfigurationError(
        `role_turn telemetry option has unexpected key '${key}' (allowed keys: enabled, limits)`,
      );
    }
  }
  if (options.enabled !== undefined && typeof options.enabled !== "boolean") {
    throw new RoleTurnConfigurationError(
      `role_turn telemetry option 'enabled' must be a boolean, got ${String(options.enabled)}`,
    );
  }
  if (options.limits !== undefined && !isPlainObject(options.limits)) {
    throw new RoleTurnConfigurationError(
      "role_turn telemetry option 'limits' must be a plain object",
    );
  }

  const enabled = options.enabled !== false;
  let limits: RoleTurnTelemetryLimits = { ...defaults };

  if (options.limits !== undefined) {
    // `RoleTurnTelemetryLimits` properties are readonly, so collect provided
    // limits into a plain partial and spread them over the defaults. A
    // provided limit must be a positive safe integer; the resolved set must
    // satisfy the bounded-chain inequalities in §5.1 (validated below).
    const overrides: Record<string, number> = {};
    for (const [key, value] of Object.entries(options.limits)) {
      // Reject unknown override keys so a caller cannot inject a non-limit field that
      // silently disappears; only known limit keys are accepted (§5.1). The known-set
      // check runs before the positivity check so an unknown key is reported as unknown,
      // not as "not a positive safe integer".
      if (!ROLE_TURN_SCOPE_KEYS.includes(key as keyof RoleTurnTelemetryLimits)) {
        throw new RoleTurnConfigurationError(
          `role_turn limit option has unexpected key '${key}' (known keys: ${ROLE_TURN_SCOPE_KEYS.join(
            ", ",
          )})`,
        );
      }
      if (!isPositiveSafeInteger(value)) {
        throw new RoleTurnConfigurationError(
          `role_turn limit '${key}' must be a positive safe integer, got ${String(value)}`,
        );
      }
      overrides[key] = value;
    }
    limits = { ...limits, ...overrides };
  }

  validateRoleTurnLimits(limits);
  return { enabled, limits: Object.freeze({ ...limits }) };
}

/** Reject a resolved limit set that violates the bounded-chain inequalities (§5.1). */
export function validateRoleTurnLimits(limits: RoleTurnTelemetryLimits): void {
  const checked: readonly [RoleTurnTelemetryLimits[keyof RoleTurnTelemetryLimits], string][] = [
    [limits.max_block_utf8_bytes, "max_block_utf8_bytes"],
    [limits.max_turn_utf8_bytes, "max_turn_utf8_bytes"],
    [limits.max_session_utf8_bytes, "max_session_utf8_bytes"],
    [limits.max_run_utf8_bytes, "max_run_utf8_bytes"],
    [limits.max_turn_blocks, "max_turn_blocks"],
    [limits.max_session_turns, "max_session_turns"],
    [limits.max_run_turns, "max_run_turns"],
  ];
  for (const [value, name] of checked) {
    if (!isPositiveSafeInteger(value)) {
      throw new RoleTurnConfigurationError(
        `resolved role_turn limit '${name}' must be a positive safe integer, got ${String(value)}`,
      );
    }
  }

  if (limits.max_block_utf8_bytes > limits.max_turn_utf8_bytes) {
    throw new RoleTurnConfigurationError(
      "resolved role_turn limits violate max_block_utf8_bytes <= max_turn_utf8_bytes",
    );
  }
  if (
    limits.max_turn_utf8_bytes > limits.max_session_utf8_bytes ||
    limits.max_session_utf8_bytes > limits.max_run_utf8_bytes
  ) {
    throw new RoleTurnConfigurationError(
      "resolved role_turn limits violate max_turn_utf8_bytes <= max_session_utf8_bytes <= max_run_utf8_bytes",
    );
  }
  if (limits.max_session_turns > limits.max_run_turns) {
    throw new RoleTurnConfigurationError(
      "resolved role_turn limits violate max_session_turns <= max_run_turns",
    );
  }
  if (limits.max_turn_blocks < 1) {
    throw new RoleTurnConfigurationError("resolved role_turn limit max_turn_blocks must be >= 1");
  }
}

/**
 * Assert a run's supplied resolved limits exactly equal the reconstructed prior
 * run's resolved limits (§5.1 / §7.5). A per-limit mismatch is a configuration
 * error raised before any role session is spawned or prompted so a resumed host
 * cannot silently change the run's retention policy.
 */
export function assertRoleTurnLimitsEqual(
  supplied: RoleTurnTelemetryLimits,
  prior: RoleTurnTelemetryLimits,
): void {
  for (const key of ROLE_TURN_SCOPE_KEYS) {
    if (supplied[key] !== prior[key]) {
      throw new RoleTurnConfigurationError(
        `resolved role_turn limit '${key}' ${String(supplied[key])} does not match prior run's ${String(prior[key])}`,
      );
    }
  }
}
