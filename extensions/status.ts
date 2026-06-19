/**
 * Status line formatter for the live run — Phase 7B.
 *
 * `ctx.ui.setStatus` takes a short string shown in the TUI
 * footer. The plan's 7B.4 acceptance is "the status line
 * updates on role transitions and clears at completion."
 * This module renders a one-line summary of the run's
 * `runStats()` projection.
 *
 * The line is intentionally narrow — the footer is shared
 * with other extensions (model status, etc.) and a long
 * string would crowd it. The format is:
 *
 *   `conduct: <state> · <exit_reason> · $<cost>`
 *
 * Examples:
 *   `conduct: orchestrator · running · $0.000`
 *   `conduct: worker · running · $0.012`
 *   `conduct: done · done · $0.045`
 *   `conduct: worker · session_failed · $0.030`
 *
 * The formatter is a pure function over `RunStats`; the
 * status poller (`StatusPoller`) is the only caller and
 * re-renders the line on each tick.
 *
 * `costRollup.cost.total` is dollars, not micros; the line
 * is rendered with 3 decimal places (cost rolls in
 * fractional cents in practice).
 */

import type { RunHandle, RunStats } from "../src/host/index.js";

/** The status-line key used by `ctx.ui.setStatus`. The
 *  extension is the single owner of this key — no other
 *  extension in this package should `setStatus` under
 *  the same name. */
export const CONDUCT_STATUS_KEY = "conduct";

/** Format the run's `RunStats` into a single status line.
 *  Pure; no I/O; no `ctx`. The line is bounded (~60
 *  chars) to fit in the TUI footer alongside other
 *  extensions' status lines. */
export function formatConductStatus(stats: RunStats): string {
  const state = stats.state;
  const reason = stats.exitReason;
  const cost = stats.costRollup.perRun.cost.toFixed(3);
  return `conduct: ${state} · ${reason} · $${cost}`;
}

/**
 * Interval (ms) between status-line refreshes. The plan
 * calls for "coarse interval (250ms)" — polling more
 * frequently than the loop's transition rate wastes
 * cycles; polling less often stales the footer during
 * long-running role sessions. 250ms is a balance.
 */
const POLL_INTERVAL_MS = 250;

/**
 * Start a status poller for the given `RunHandle`. The
 * poller calls `setStatus(text)` on every tick until
 * `stop()` is invoked, or until the run reaches a
 * terminal state (in which case the poller clears the
 * status line and stops itself).
 *
 * The poller is the single source of status updates —
 * the command handler does not call `setStatus` directly
 * during the run. This keeps the rendering and the
 * teardown in one place.
 *
 * @returns A `stop` function the caller MUST call on
 *          handler failure (try/finally) to ensure the
 *          timer does not leak after an unhandled error.
 */
export function startStatusPoller(
  handle: RunHandle,
  setStatus: (text: string | undefined) => void,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = (): void => {
    if (stopped) return;
    const stats = handle.runStats();
    if (
      stats.exitReason === "done" ||
      stats.exitReason === "session_failed" ||
      stats.exitReason === "aborted"
    ) {
      // Terminal: clear the line and stop. The caller
      // (handler) will fire its terminal notification.
      setStatus(undefined);
      stop();
      return;
    }
    setStatus(formatConductStatus(stats));
  };

  // Render the initial line immediately so the user
  // sees something before the first interval fires.
  tick();
  timer = setInterval(tick, POLL_INTERVAL_MS);

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    // Always clear the line on stop. The handler
    // calls `stop()` in `finally`, so the line is
    // guaranteed to clear on terminal OR handler
    // failure regardless of which tick last ran.
    setStatus(undefined);
  };

  return stop;
}
