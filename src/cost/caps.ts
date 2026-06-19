/**
 * Cap-evaluation predicates — spec §11.7.
 *
 * Pure, host-callable. The reducer does NOT own cost-cap enforcement
 * (§11.7); these predicates are the deterministic building blocks the
 * host calls on every `turn_end` (session cap) and every terminal
 * usage capture (run cap).
 *
 * **Per-session cap (`max_session_cost_usd`):**
 *  - Per-role-invocation, shared across model fallbacks within that
 *    invocation (§11.7).
 *  - The host accumulates usage across all fallback attempts of one
 *    invocation into a single `UsageAggregate` and calls
 *    `sessionCapExceeded(invocationUsage, cap)`. The predicate is a
 *    simple cost comparison — it does NOT scale by `len(fallbacks)`.
 *  - This prevents the "multiplier loophole": a naive host cannot
 *    pass `cap × len(fallbacks)` here, because the predicate would
 *    reject when cumulative cost reaches `cap` regardless of how many
 *    models were tried.
 *
 * **Run cap (`max_run_cost_usd`):**
 *  - Evaluated on every terminal usage capture against the running
 *    rollup's `perRun.cost`.
 *  - Caller passes the rollup (from `cost/rollup.ts`) and the cap.
 *
 * **Boundary:** both predicates use `cost >= cap`. The cap is a hard
 * stop, not a soft target — at-cap is rejected. Matches the reducer's
 * `visit_count[W] >= max_visits[W]` rejection convention (Phase 2).
 *
 * Pure. No I/O, no pi imports.
 */

import type { RunRollup, UsageAggregate } from "./rollup.js";

/**
 * §11.7 per-session cap predicate.
 *
 * @param invocationUsage — the cumulative `UsageAggregate` for the
 *   current role invocation. The host accumulates usage across all
 *   model fallback attempts within this invocation into this single
 *   aggregate; the predicate does NOT scale by `len(fallbacks)`.
 * @param cap — the role's `max_session_cost_usd`. The host passes the
 *   role-declared value (or `null`/0 to mean "no cap"; the predicate
 *   itself does not interpret absence — caller chooses whether to call).
 * @returns `true` iff the cumulative cost has reached or exceeded the cap.
 */
export function sessionCapExceeded(invocationUsage: UsageAggregate, cap: number): boolean {
  return invocationUsage.cost >= cap;
}

/**
 * §11.7 run-cap predicate.
 *
 * @param rollup — the running §11.6 roll-up (typically computed by the
 *   host after appending the just-captured terminal usage record).
 * @param cap — the orchestrator's `max_run_cost_usd`.
 * @returns `true` iff the run's cumulative cost has reached or exceeded
 *   the cap. The host MUST then synthesize a machine `end` event and
 *   feed it through `reduce` (§11.7); direct checkpoint mutation to
 *   `done` is forbidden.
 */
export function runCapExceeded(rollup: RunRollup, cap: number): boolean {
  return rollup.perRun.cost >= cap;
}
