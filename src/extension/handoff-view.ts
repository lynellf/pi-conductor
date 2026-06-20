/**
 * Handoff-visibility formatters — Phase 8 (handoff-visibility
 * spec/plan). A pure projection of the run's
 * `TransitionRecord[]` (live) into user-facing strings.
 *
 * Three exports:
 *   - `countHandoffs(history)` — count of handoff events
 *     (Q5: `end` is excluded; the run's terminal transition
 *     is reflected via `exit_reason` / `state`, not this
 *     counter).
 *   - `formatHandoffNotify(record)` — one-line notify string
 *     `conduct: <from> → <to>`. `end` events naturally render
 *     as `→ done` because `to` is `"done"`. `suggests_next`
 *     and `reason` are NOT included in v1 (Q1, Q2 deferred).
 *   - `formatTransitionTrace(history, maxHops?)` — ordered
 *     `from → to → from → …` trace, truncated to `maxHops`
 *     (default 6 visible hops, then a `…` suffix).
 *
 * Pure functions: no `ctx`, no I/O, no `RunHandle`. The
 * status poller and the list handler call these from the
 * extension layer (`src/extension/`, `src/extension/commands/`).
 *
 * `transitionHistory` is the source — it is the
 * `runStats()` projection (narrower than the raw
 * `PersistedRecord`). It does NOT carry `suggests_next`,
 * which is the deliberate Q1 default (raw-record read is
 * a follow-up). Reading raw records in the poller would
 * change the live path's complexity profile for a v1
 * stretch goal; deferred.
 *
 * Acceptance: A1, R1, R2, R3, AC1, AC2, AC4, AC5, AC6.
 */

import type { TransitionRecord } from "../host/index.js";

/** Default maximum number of hops to render in a
 *  transition trace before appending `…`. Picked to fit
 *  comfortably inside the `notify` single-line budget for
 *  a typical run (≤8 transitions). */
const DEFAULT_MAX_HOPS = 6;

/**
 * Count the number of `event === "handoff"` entries in
 * a `transitionHistory`. Excludes terminal `end` events
 * (Q5 default). Used by the status line counter and the
 * list trace truncation.
 */
export function countHandoffs(history: readonly TransitionRecord[]): number {
  let count = 0;
  for (const record of history) {
    if (record.event === "handoff") count += 1;
  }
  return count;
}

/**
 * Format a single `TransitionRecord` as a one-line
 * notification string: `conduct: <from> → <to>`.
 *
 * For `end` events, `to` is already `"done"`, so the
 * output is `conduct: <from> → done` without a special
 * branch. The function is symmetric across `handoff`
 * and `end` so the live poller can call it for every
 * record without a type switch.
 *
 * Intentionally does NOT include `suggests_next` (Q1
 * deferred) or `payload_summary.reason` (Q2 deferred,
 * and not on `TransitionRecord` anyway). Adding a
 * `reason` field would be a silent fallback — the field
 * is not reliably populated.
 */
export function formatHandoffNotify(record: TransitionRecord): string {
  return `conduct: ${record.from} → ${record.to}`;
}

/**
 * Format a `transitionHistory` as a compact role trace,
 * suitable for one-line display in `/conduct:list` or as
 * part of a notification. The output is the role sequence
 * in order: `from[0] → to[0] → to[1] → … → to[N-1]`.
 *
 * In a well-formed run, the FSM invariant guarantees
 * `record[i].to === record[i+1].from`, so the role
 * sequence is contiguous and unambiguous. A run with no
 * transitions returns an empty string. Long traces
 * truncate to `maxHops` visible hops (default 6) with a
 * trailing `…` (U+2026). The truncation is intentional —
 * `/conduct:list` renders a single line per run, and a
 * long run would blow that out. The full timeline is an
 * explicit deferral (Q3).
 */
export function formatTransitionTrace(
  history: readonly TransitionRecord[],
  maxHops: number = DEFAULT_MAX_HOPS,
): string {
  if (history.length === 0) return "";
  const visible = history.slice(0, maxHops);
  const first = visible[0];
  if (first === undefined) return "";
  const parts: string[] = [first.from, first.to];
  for (let i = 1; i < visible.length; i++) {
    const record = visible[i];
    if (record === undefined) continue;
    parts.push(record.to);
  }
  const trace = parts.join(" → ");
  return history.length > maxHops ? `${trace} → …` : trace;
}
