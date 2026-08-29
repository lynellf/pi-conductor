/**
 * Bounded structured role-turn telemetry — Issue #68.
 *
 * Pure, host-agnostic value model for the additive `role_turn` persisted
 * record: scope-order constants, the record / capture / limit / measure types,
 * the fully-resolved default limits, and the typed failures raised at the
 * configuration and persistence boundaries. This module never imports the pi
 * SDK; the pi-coupled content extraction lives in
 * `src/host/role-turn-producer.ts`.
 *
 * The record lets an analytics / observability consumer answer, in durable
 * order, which role said what readable text or readable thinking in which
 * logical invocation and physical conversation — without treating Pi's session
 * JSONL as analytics payload (spec §1 / §2).
 *
 **/

import type { Role } from "../core/types.js";

// ─── Canonical scope orders ───────────────────────────────────────────

/** Canonical order for `truncated_by` / `limit_causes`. */
const ROLE_TURN_LIMIT_SCOPE_ORDER: readonly RoleTurnLimitScope[] = [
  "block",
  "turn",
  "session",
  "run",
] as const;

/** Canonical order for `saturated`. */
const SATURATED_SCOPE_ORDER: readonly RoleTurnSaturatedScope[] = [
  "block",
  "turn",
  "session_bytes",
  "session_turns",
  "run_bytes",
  "run_turns",
] as const;

// ─── §3.1 Type shape ──────────────────────────────────────────────────

/**
 * One scoped limit that was the binding reason a block's readable text was
 * truncated (a byte scope) or a candidate was dropped for lack of a retained-
 * block slot (`turn`). Canonical order: `block`, `turn`, `session`, `run`.
 */
export type RoleTurnLimitScope = "block" | "turn" | "session" | "run";

/** One readable retained block — either assistant `text` or readable `thinking`. */
export type RoleTurnBlock =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly original_utf8_bytes: number;
      readonly original_characters: number;
      readonly truncated: boolean;
      readonly truncated_by: readonly RoleTurnLimitScope[];
    }
  | {
      readonly kind: "thinking";
      readonly text: string;
      readonly original_utf8_bytes: number;
      readonly original_characters: number;
      readonly truncated: boolean;
      readonly truncated_by: readonly RoleTurnLimitScope[];
    };

/** A measured quantity: UTF-8 bytes, Unicode code points, and block count. */
export interface RoleTurnMeasure {
  readonly utf8_bytes: number;
  readonly characters: number;
  readonly blocks: number;
}

/** Fully-resolved retention bounds repeated on every record (§5.1). */
export interface RoleTurnTelemetryLimits {
  readonly max_block_utf8_bytes: number;
  readonly max_turn_utf8_bytes: number;
  readonly max_turn_blocks: number;
  readonly max_session_utf8_bytes: number;
  readonly max_session_turns: number;
  readonly max_run_utf8_bytes: number;
  readonly max_run_turns: number;
}

/** Named post-append boundary that has reached its configured maximum. */
export type RoleTurnSaturatedScope =
  | "block"
  | "turn"
  | "session_bytes"
  | "session_turns"
  | "run_bytes"
  | "run_turns";

/** Per-record capture arithmetic, self-describing the retention bounds (§5.2). */
export interface RoleTurnCapture {
  /** Full resolved limits used for this record. */
  readonly limits: RoleTurnTelemetryLimits;
  /** Eligible readable input only; excludes redacted / unsupported blocks. */
  readonly source: RoleTurnMeasure;
  /** What this record actually retains in `blocks`. */
  readonly captured: RoleTurnMeasure;
  /** `source - captured`; `blocks` counts only wholly absent source blocks. */
  readonly omitted: RoleTurnMeasure;
  /** Scopes that actually removed bytes or whole readable blocks in this turn. */
  readonly limit_causes: readonly RoleTurnLimitScope[];
  /** Named post-append boundaries equal to their maximum (§5.3). */
  readonly saturated: readonly RoleTurnSaturatedScope[];
}

/** The v1 persisted union member — issue #68. All string identities are non-empty. */
export interface RoleTurnRecord {
  readonly type: "role_turn";
  readonly schema_version: 1;
  readonly run_id: string;
  readonly role: Role;
  /** Host logical invocation identity; required even when it equals conversation_id. */
  readonly role_session_id: string;
  /** Native Pi conversation identity; required even for non-trajectory sessions. */
  readonly conversation_id: string;
  /** Physical Pi session-file identity; a pointer only, never transcript content. */
  readonly session_file: string;
  /** 1-based, run-scoped, durable role_turn order. */
  readonly sequence: number;
  /** Host receipt / persistence wall-clock time in Unix epoch milliseconds. */
  readonly ts: number;
  /** Ordered, bounded readable content. */
  readonly blocks: readonly RoleTurnBlock[];
  readonly capture: RoleTurnCapture;
}

/** Host constructor / factory telemetry options (§5.1). Partial limits overlay defaults. */
export interface RoleTurnTelemetryOptions {
  readonly enabled?: boolean;
  readonly limits?: Partial<RoleTurnTelemetryLimits>;
}

/** Resolved telemetry config after overlaying partial options onto defaults. */
export interface ResolvedRoleTurnTelemetry {
  readonly enabled: boolean;
  readonly limits: RoleTurnTelemetryLimits;
}

// ─── Typed failures ───────────────────────────────────────────────────

/**
 * Host-side configuration error: a resolved limit set is malformed, a supplied
 * limit is not a positive safe integer, or a resume's supplied limits do not match
 * the prior run's (§5.1). Thrown before any role session is spawned or prompted.
 */
export class RoleTurnConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleTurnConfigurationError";
  }
}

/**
 * Typed rejection of malformed durable `role_turn` data at a persistence or
 * telemetry-log boundary (§3.1 / §7). A cast or schema-drifted record must never
 * be trusted as a valid record.
 */
export class RoleTurnTelemetryLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleTurnTelemetryLogError";
  }
}

/**
 * Typed rejection of a producer context whose run id differs from the run the
 * producer/ledger is owned by (§3.2 / remediation §3). A mismatch means the caller
 * is feeding a live invocation from the wrong run into this producer's sequence and
 * counters, which must fail closed rather than silently mix sequences across runs.
 */
export class RoleTurnRunMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleTurnRunMismatchError";
  }
}

// ─── §5.1 Defaults ────────────────────────────────────────────────────

/** Fully-resolved default retention bounds (§5.1). All positive safe integers. */
export const DEFAULT_ROLE_TURN_LIMITS: RoleTurnTelemetryLimits = Object.freeze({
  max_block_utf8_bytes: 8_192,
  max_turn_utf8_bytes: 32_768,
  max_turn_blocks: 64,
  max_session_utf8_bytes: 262_144,
  max_session_turns: 128,
  max_run_utf8_bytes: 1_048_576,
  max_run_turns: 512,
});

/** The ordered set of limit keys, for equality + iteration (§5.1). */
const ROLE_TURN_SCOPE_KEYS: readonly (keyof RoleTurnTelemetryLimits)[] = Object.freeze([
  "max_block_utf8_bytes",
  "max_turn_utf8_bytes",
  "max_turn_blocks",
  "max_session_utf8_bytes",
  "max_session_turns",
  "max_run_utf8_bytes",
  "max_run_turns",
] as const);

// ─── Pure guards (shared across the role_turn submodules) ──────────────

/** Guard for finite, non-negative safe integers (§3.1). `Number.isSafeInteger` is
 * the authoritative guard: it rejects `NaN`/`Infinity`, non-integers, and integers
 * outside `[-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]` (which `Number.isInteger`
 * alone would allow, e.g. `9_007_199_254_740_993`). */
export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Guard for finite, positive safe integers (§5.1). */
export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Runtime guard for a *plain* object: an empty/`Object.prototype`-prototype value
 * or an `Object.create(null)` value. Class instances, `Date`, arrays, and other
 * prototype-backed objects are rejected (spec §3.1).
 *
 * A cast of a `Date` or class instance into `Record<string, unknown>` would
 * smuggle runtime state (e.g. a `time`/`signatures` map) into the append-only
 * `role_turn` log. Only JSON-style objects are trusted here.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Re-exported so downstream submodules read the canonical scope orders.
export { ROLE_TURN_LIMIT_SCOPE_ORDER, ROLE_TURN_SCOPE_KEYS, SATURATED_SCOPE_ORDER };
