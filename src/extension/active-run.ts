/**
 * In-process tracker for the active `RunHandle` — Phase 7B.
 *
 * The extension shell is a UX layer over a single live run at a
 * time per pi process: `/conduct` starts a run, `/conduct:abort`
 * stops the active one, `/conduct:resume` reconstructs a run
 * (which becomes the new active one). The plan calls for
 * "Command state small and explicit" — this module is the
 * smallest possible state: a mutable slot holding the current
 * `RunHandle` (or `null`), with two accessors the command
 * handlers share.
 *
 * ## Why module-level state, not the extension closure
 *
 * pi's extension factory runs once per process. The factory
 * receives an `ExtensionAPI` and returns; command handlers run
 * later. If the active handle were captured in the factory
 * closure, every command would see the same handle — but the
 * factory also runs in invocations that never start a run (e.g.
 * `pi --help`), and the closed-over state would leak. A
 * module-level `let` is bounded to the actual runs the
 * extension starts, and the factory stays side-effect free
 * (the 7B.1 acceptance).
 *
 * ## Why `RunHandle` and not the underlying `Promise<…>`
 *
 * `RunHandle.completion()` is the source of truth for terminal
 * state. `abort()` and `runStats()` are the operations
 * `/conduct:abort` and the status line need. Holding the
 * handle — not a copy of its fields — keeps the abort path
 * identical to what `RunHandle.abort` exposes.
 *
 * ## Scope discipline
 *
 * The tracker is in-process only. It does not persist across
 * pi restarts. `/conduct:resume` reconstructs a run from the
 * log; the new handle becomes the active one. The previous
 * active run (if any) was terminal by the time `/conduct:resume`
 * is called — the user is explicitly starting over.
 */

import type { RunHandle } from "../host/index.js";

/**
 * The currently-active run in this extension process, or `null`
 * if no run is live. Read via `getActiveRun`, written via
 * `setActiveRun`. The slot is per-process; there is exactly
 * one "active" run at a time (the spec/plan do not require
 * multi-run concurrency from a single extension invocation).
 */
let activeRun: RunHandle | null = null;

/**
 * Read the current active run. Returns `null` when no run is
 * live. The handle is the live, mutable object — the
 * command handler's reads see the same state the loop /
 * `RunHandle` writes.
 */
export function getActiveRun(): RunHandle | null {
  return activeRun;
}

/**
 * Replace the active run. Pass `null` to clear the slot
 * (called when a run reaches a terminal state and the
 * command handler that observed it wants to reset). The
 * extension is the only writer; command handlers call
 * this in `/conduct`, `/conduct:resume`, and after
 * `/conduct:abort` resolves.
 */
export function setActiveRun(handle: RunHandle | null): void {
  activeRun = handle;
}
