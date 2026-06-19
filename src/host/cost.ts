/**
 * Per-session cost accumulator + session-cap detection — spec §11.4,
 * §11.7, plan Task 17.
 *
 * The host (`StubHost` for tests; the future production SDK-backed
 * Host) subscribes to the agent session's events. On every
 * `message_end` for an assistant message, it accumulates the message's
 * SDK `Usage` into the session's running total (mapping the SDK's
 * camelCase + nested-cost shape to the §11.4 normalized record). On
 * every `turn_end`, the host evaluates the per-session cap
 * (`max_session_cost_usd`); if exceeded, the host calls
 * `session.abort()` and flips the terminal reason to
 * `"session_cost_cap_exceeded"`.
 *
 * **Abort accounting (§11.7).** `session.abort()` may itself emit a
 * final `message_end` with partial usage. The accumulator guards
 * against double-counting by tracking the message IDs it has already
 * integrated: a re-fire of `message_end` for the same message is
 * ignored. (The SDK's event protocol emits one `message_end` per
 * message, but the guard is defensive against future protocol
 * changes — `abort()` paths in particular can be quirky.)
 *
 * **System prompt + provider specifics.** The SDK's `Usage` carries
 * a nested `cost` object; we read `cost.total` (the only field the
 * §11.4 normalized record needs). `cacheWrite1h` (Anthropic-only
 * split) is ignored for v1 — the plan keeps the v1 roll-up simple.
 *
 * **No SDK runtime coupling.** This module imports only types from
 * `@earendil-works/pi-ai` (`Usage`) — the `import type` is erased at
 * compile time. The `src/host/` directory is the only place allowed
 * to import the SDK runtime, and this module is type-only.
 */

import type { Usage } from "@earendil-works/pi-ai";

import type { UsageRecord } from "../core/types.js";
import type { SessionTerminalReason } from "./host.js";

// ─── §11.4 SDK → normalized mapping ────────────────────────────────────

/**
 * Map the SDK's `Usage` (camelCase, nested `cost`) to the §11.4
 * normalized record (snake_case, flat `cost`).
 *
 *   input        ← usage.input
 *   output       ← usage.output
 *   cache_read   ← usage.cacheRead
 *   cache_write  ← usage.cacheWrite
 *   tokens       ← usage.totalTokens
 *   cost         ← usage.cost.total
 *
 * `cacheWrite1h` (Anthropic-only split) is intentionally NOT
 * tracked for v1 (§11.4 note). The roll-up keeps the simple
 * cache_read/cache_write split; finer-grained accounting can be
 * added as a derived field later without breaking the §11.4 record
 * shape.
 */
export function normalizeUsage(raw: Usage): UsageRecord {
  return {
    input: raw.input,
    output: raw.output,
    cache_read: raw.cacheRead,
    cache_write: raw.cacheWrite,
    tokens: raw.totalTokens,
    cost: raw.cost.total,
  };
}

// ─── Per-session accumulator ───────────────────────────────────────────

/** All-zeros UsageRecord. Used to seed the accumulator. */
export const ZERO_USAGE: UsageRecord = Object.freeze({
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  tokens: 0,
  cost: 0,
}) as UsageRecord;

/** Sum two `UsageRecord`s elementwise. `tokens` is the normalized
 *  total from the SDK; summing it is consistent with the record's
 *  `tokens` invariant (matches `input + output + cache_read +
 *  cache_write` in the rollup test). */
export function addUsage(a: UsageRecord, b: UsageRecord): UsageRecord {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cache_read: a.cache_read + b.cache_read,
    cache_write: a.cache_write + b.cache_write,
    tokens: a.tokens + b.tokens,
    cost: a.cost + b.cost,
  };
}

/**
 * Per-session host state — the accumulator + terminal reason the
 * loop reads via `host.captureUsage` and `host.sessionTerminalReason`.
 *
 * **Lifecycle**:
 *   1. `spawnRole` constructs a `SessionState` with the per-session
 *      cap (from the role's `max_session_cost_usd`, null if uncapped).
 *   2. The host subscribes to the session's events; on assistant
 *      `message_end`, the listener calls `addMessageUsage`. On
 *      `turn_end`, the listener calls `evaluateCap` and may call
 *      `session.abort()` + `setTerminalReason` if the cap fires.
 *   3. After `prompt()` resolves, the loop calls
 *      `host.captureUsage(session)` (= `state.usage()`) and
 *      `host.sessionTerminalReason(session)` (= `state.terminalReason`).
 *   4. The loop's `session_failed` path uses `terminalReason` when
 *      set; otherwise the buffer-derived breach reason.
 *
 * **De-dup.** `addMessageUsage` tracks message IDs. The same
 * `message_end` firing twice (e.g., an `abort()` re-emitting) is
 * ignored on the second call. The guard is defensive; the SDK's
 * documented protocol emits `message_end` once per message.
 */
export class SessionState {
  private _usage: UsageRecord = ZERO_USAGE;
  private readonly _seenMessageIds: Set<string> = new Set();
  private _terminalReason: SessionTerminalReason = null;
  private _aborted = false;

  /** Per-session cost cap (null = uncapped). The role's
   *  `max_session_cost_usd` is shared across model fallbacks
   *  within this invocation (§11.7). */
  private readonly cap: number | null;

  /** The model this session is running on, as a `provider:id`
   *  string or null for the system default. Recorded on lifecycle
   *  events via the loop's `reduceLifecycle(model)` call. */
  readonly model: string | null;

  constructor(opts: { cap: number | null; model: string | null }) {
    this.cap = opts.cap;
    this.model = opts.model;
  }

  /**
   * Accumulate a single assistant `message_end`'s usage. The
   * `messageId` is the SDK's `AssistantMessage` id; the guard
   * prevents double-counting if the same message's `message_end`
   * fires twice (abort paths can be quirky; see §11.7 "Abort
   * accounting").
   *
   * Returns the cumulative usage after the addition, so the
   * caller can log it / drive cap checks.
   */
  addMessageUsage(messageId: string, raw: Usage): UsageRecord {
    if (this._seenMessageIds.has(messageId)) return this._usage;
    this._seenMessageIds.add(messageId);
    this._usage = addUsage(this._usage, normalizeUsage(raw));
    return this._usage;
  }

  /** Cumulative §11.4 usage for the session. Read by
   *  `host.captureUsage(session)` and surfaced to the loop as the
   *  `usage` field on `session_ended` / `session_failed` records. */
  usage(): UsageRecord {
    return this._usage;
  }

  /**
   * Evaluate the per-session cap against the cumulative usage. The
   * host calls this on every `turn_end`. If the cap has been
   * exceeded, the host should call `session.abort()` and then
   * `setTerminalReason("session_cost_cap_exceeded")`. The
   * predicate is pure; the host owns the side effect.
   *
   * `@returns` `true` if the cumulative cost has reached or
   * exceeded the cap (cap is a hard stop, §11.7 — `>=`, not `>`).
   * Uncapped sessions always return `false`.
   */
  isSessionCapExceeded(): boolean {
    if (this.cap === null) return false;
    return this._usage.cost >= this.cap;
  }

  /**
   * Set the session's terminal reason. Called by the host when
   * the session ends abnormally (`abort()` for cap; `error` event
   * for model errors — Task 18). The loop reads this via
   * `host.sessionTerminalReason`; if non-null, it overrides the
   * buffer-derived breach reason on the `session_failed` record.
   */
  setTerminalReason(reason: SessionTerminalReason): void {
    this._terminalReason = reason;
  }

  /** The host-set terminal reason, or null if the session ended
   *  normally. Read by the loop after `prompt()` resolves. */
  get terminalReason(): SessionTerminalReason {
    return this._terminalReason;
  }

  /**
   * Flip the aborted flag. The host sets this when it calls
   * `session.abort()` so the loop can distinguish "session
   * terminated by host" from "session ended naturally". (The
   * terminal reason also encodes the cause; the flag is
   * auxiliary for tests / observability.)
   */
  markAborted(): void {
    this._aborted = true;
  }

  /** Whether the host called `session.abort()` for this session. */
  get aborted(): boolean {
    return this._aborted;
  }
}
