/**
 * `runConfig` host function — spec §11.8, plan Task 19.
 *
 * `applyRunConfigOverride(state, override)` is the pure validation
 * + computation behind the `RunHandle.runConfig` method. The
 * function:
 *
 *  - Rejects a non-positive `max_run_cost_usd` with a typed error
 *    (`RunConfigError`). The plan is explicit: "An override to a
 *    non-positive number is a typed error." `0` and negative values
 *    are not silently coerced to a sentinel — the caller sees the
 *    error.
 *  - Returns `{ newCap, immediateBreach }`. `newCap` is the validated
 *    override; `immediateBreach` is `true` when the new cap is at or
 *    below the current `run_cost_to_date` (i.e., the cap is already
 *    breached the moment the override lands).
 *
 * **Lowering edge case (§11.8, same path as §11.7):** the
 * `immediateBreach` flag is informational for the caller. The actual
 * breach handling flows through the loop's existing run-cap check:
 * the loop reads the updated cap via `getRunCostCap()` on every
 * terminal, and the §11.7 `pendingForcedEnd` mechanism synthesizes
 * the `end` event on the next orchestrator-current moment. The
 * `RunHandle` does not need a separate "force end" path — updating
 * the cap is sufficient.
 *
 * **Raising the cap is always allowed.** No breach check on the
 * upper side; the override is a pure update.
 *
 * Host-agnostic. No SDK runtime imports.
 */

import type { RunConfigOverride } from "./run-handle.js";

/**
 * Typed error thrown when a `runConfig` override is invalid. The
 * caller catches this and surfaces a clear message; the run
 * continues with its previous cap (the override is not partially
 * applied — validation is all-or-nothing).
 */
export class RunConfigError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`RunConfigError: ${reason}`);
    this.name = "RunConfigError";
    this.reason = reason;
  }
}

/**
 * Validate and apply a `runConfig` override.
 *
 * @param state - The current run state. `runCostSoFar` is the sum of
 *                 `usage.cost` across all persisted terminal sessions
 *                 (§11.4 — both `session_ended` and `session_failed`
 *                 cost).
 * @param override - The override payload. Must include a positive
 *                   `maxRunCostUsd`.
 * @returns `{ newCap, immediateBreach }`. `newCap` is the validated
 *          cap; `immediateBreach` is `true` when `newCap <=
 *          state.runCostSoFar` (the cap is already breached).
 *
 * @throws {RunConfigError} when `override.maxRunCostUsd` is
 *         undefined or non-positive.
 */
export function applyRunConfigOverride(
  state: { readonly runCostSoFar: number },
  override: RunConfigOverride,
): { readonly newCap: number; readonly immediateBreach: boolean } {
  const cap = override.maxRunCostUsd;
  if (cap === undefined) {
    throw new RunConfigError("override.maxRunCostUsd is required");
  }
  if (!Number.isFinite(cap)) {
    throw new RunConfigError(`override.maxRunCostUsd must be a finite number, got ${String(cap)}`);
  }
  if (cap <= 0) {
    throw new RunConfigError(
      `override.maxRunCostUsd must be positive, got ${cap} (§11.8: non-positive override is a typed error)`,
    );
  }
  // §11.8 lowering edge case: the override is at or below current
  // spend. The breach is informational here; the loop's run-cap
  // check + §11.7 `pendingForcedEnd` handle the actual close.
  const immediateBreach = cap <= state.runCostSoFar;
  return { newCap: cap, immediateBreach };
}
