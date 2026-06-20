/**
 * In-process tracker for the active run's orchestrator role — Phase 5.
 *
 * The display sink in `src/extension/display-sink-wiring.ts` writes
 * `is_orchestrator` into every emitted `CustomMessage.details`. To
 * compute that flag, the sink needs to know the active run's
 * orchestrator role — but the sink is a single shared closure created
 * at extension factory time, before any run exists. The `/conduct`
 * and `/conduct:resume` handlers own the manifest and set this slot
 * around the run lifecycle; the sink reads it at emission time.
 *
 * This mirrors the pattern in `active-run.ts` (one mutable slot per
 * extension process, set on run start, cleared on terminal). The
 * `is_orchestrator` derivation is purely display-side; it never
 * affects the FSM reducer, the seam capture buffer, or the
 * model-facing tool result.
 *
 * ## Why module-level state
 *
 * The sink is a single closure shared across the four command
 * handlers. Closing over per-run state in the factory would mean
 * either (a) recreating the sink per run, or (b) threading the
 * orchestrator role through every event. The single mutable slot is
 * the smallest possible change: one variable, two accessors, set on
 * run start, cleared on terminal.
 *
 * ## Why not a getter on the run handle
 *
 * `RunHandle` lives in `src/host/`. Reading from the host's run
 * handle from a pure-display module would re-introduce the layering
 * inversion the grep guard is meant to prevent. The display-side
 * role tracker stays in `src/extension/`; the host is not touched.
 *
 * ## Concurrency note
 *
 * pi's command handlers run sequentially (a single user, a single
 * pi process). Two runs are never active concurrently; the slot
 * semantics are unambiguous.
 */

import type { Role } from "../core/types.js";

/**
 * The orchestrator role of the active run, or `null` when no run is
 * live. The sink reads this on every emission; the value is stable
 * for the duration of a run.
 */
let currentOrchestratorRole: Role | null = null;

/**
 * Read the active run's orchestrator role. Returns `null` when no
 * run is live — the sink treats `null` as "unknown" and falls back
 * to the muted default color in the renderer.
 */
export function getCurrentOrchestratorRole(): Role | null {
  return currentOrchestratorRole;
}

/**
 * Replace the active run's orchestrator role. Called by `/conduct`
 * and `/conduct:resume` after the manifest is loaded and the run is
 * about to start, and cleared on terminal. Pass `null` to clear
 * the slot.
 *
 * The slot is per-process; only one run is "active" at a time (the
 * active-run tracker in `active-run.ts` enforces the same invariant).
 */
export function setCurrentOrchestratorRole(role: Role | null): void {
  currentOrchestratorRole = role;
}
