/**
 * Pinned executable-tool deadline policy — September execution controls §76.
 *
 * The manifest keeps this block optional for compatibility. A configured block
 * is normalized to all defaults; hosts call `resolveToolExecutionPolicy` before
 * executing a tool so the runtime always has concrete limits.
 */

import { ManifestParseError } from "./types.js";

const MAX_TIMEOUT_SECONDS = 3_600;

/** One host-owned executable tool policy shared by roles and subagent profiles. */
export interface ToolExecutionPolicy {
  readonly timeout_seconds?: number;
  readonly max_recoverable_timeouts?: number;
  readonly termination_grace_seconds?: number;
}

/** Immutable defaults for a resolved execution policy. */
export const DEFAULT_TOOL_EXECUTION_POLICY: Readonly<Required<ToolExecutionPolicy>> = Object.freeze(
  {
    timeout_seconds: 300,
    max_recoverable_timeouts: 2,
    termination_grace_seconds: 2,
  },
);

const TOOL_EXECUTION_KEYS = new Set([
  "timeout_seconds",
  "max_recoverable_timeouts",
  "termination_grace_seconds",
]);

/** Return validation messages for a programmatic policy, including unknown fields. */
export function validateToolExecutionPolicy(
  policy: unknown,
  path = "tool_execution",
): readonly string[] {
  if (policy === undefined) return Object.freeze([]);
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    return Object.freeze([`${path} must be a mapping (object)`]);
  }

  const entry = policy as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(entry)) {
    if (!TOOL_EXECUTION_KEYS.has(key)) errors.push(`${path} has unknown key '${key}'`);
  }
  validatePositiveInteger(
    entry.timeout_seconds,
    `${path}.timeout_seconds`,
    errors,
    MAX_TIMEOUT_SECONDS,
  );
  validatePositiveInteger(
    entry.max_recoverable_timeouts,
    `${path}.max_recoverable_timeouts`,
    errors,
  );
  validatePositiveInteger(
    entry.termination_grace_seconds,
    `${path}.termination_grace_seconds`,
    errors,
  );
  return Object.freeze(errors);
}

/** Parse and normalize one configured manifest block. */
export function parseToolExecutionPolicy(raw: unknown, path: string): ToolExecutionPolicy {
  const errors = validateToolExecutionPolicy(raw, path);
  if (errors.length > 0) throw new ManifestParseError(errors[0] ?? `${path} is invalid`);
  return resolveToolExecutionPolicy(raw as ToolExecutionPolicy);
}

/** Resolve an optional policy to an immutable policy with all deadlines populated. */
export function resolveToolExecutionPolicy(
  policy?: ToolExecutionPolicy,
): Readonly<Required<ToolExecutionPolicy>> {
  const errors = validateToolExecutionPolicy(policy);
  if (errors.length > 0) throw new ManifestParseError(errors[0] ?? "tool_execution is invalid");
  return Object.freeze({
    timeout_seconds: policy?.timeout_seconds ?? DEFAULT_TOOL_EXECUTION_POLICY.timeout_seconds,
    max_recoverable_timeouts:
      policy?.max_recoverable_timeouts ?? DEFAULT_TOOL_EXECUTION_POLICY.max_recoverable_timeouts,
    termination_grace_seconds:
      policy?.termination_grace_seconds ?? DEFAULT_TOOL_EXECUTION_POLICY.termination_grace_seconds,
  });
}

function validatePositiveInteger(
  value: unknown,
  path: string,
  errors: string[],
  maximum?: number,
): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    errors.push(`${path} must be a positive safe integer`);
    return;
  }
  if (maximum !== undefined && value > maximum) {
    errors.push(`${path} must be at most ${maximum}`);
  }
}
