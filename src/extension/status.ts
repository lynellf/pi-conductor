/**
 * Status line formatter for the live run — Phase 7B, with
 * the handoff-visibility augmentation (Phase 8 / spec
 * `the handoff-visibility spec R2).
 *
 * `ctx.ui.setStatus` takes a short string shown in the TUI
 * footer. The plan's 7B.4 acceptance is "the status line
 * updates on role transitions and clears at completion."
 * This module renders a one-line summary of the run's
 * `runStats()` projection.
 *
 * The line is intentionally compact — the footer is shared
 * with other extensions (model status, etc.) and a long
 * string would crowd it. The format is:
 *
 *   `conduct: <state> · <exit_reason> · [model=<...> · effort=<...>] · [subagents=N active] · handoffs=<N> · $<cost>`
 *
 * Examples:
 *   `conduct: orchestrator · running · handoffs=0 · $0.000`
 *   `conduct: worker · running · model=anthropic:claude-sonnet-4-5 · effort=high · handoffs=1 · $0.012`
 *   `conduct: done · done · handoffs=3 · $0.045`
 *   `conduct: worker · session_failed · handoffs=2 · $0.030`
 *
 * `handoffs=<N>` counts only `event === "handoff"` entries
 * in `transitionHistory` (Q5 default: `end` is excluded; the
 * terminal transition is reflected via `exit_reason`).
 * Computed via `countHandoffs` from
 * `src/extension/handoff-view.ts`.
 *
 * The formatter is a pure function over `RunStats`; the
 * status poller (`StatusPoller`) is the only caller and
 * re-renders the line on each tick.
 *
 * `costRollup.cost.total` is dollars, not micros; the line
 * is rendered with 3 decimal places (cost rolls in
 * fractional cents in practice).
 */

import type { RunHandle, RunStats, TransitionRecord } from "../host/index.js";
import { countHandoffs } from "./handoff-view.js";

function formatActiveModelToken(model: string | null): string {
  return model === null ? "<default>" : model;
}

function formatEffortToken(effort: string): string {
  return effort;
}

/** The status-line key used by `ctx.ui.setStatus`. The
 *  extension is the single owner of this key — no other
 *  extension in this package should `setStatus` under
 *  the same name. */
export const CONDUCT_STATUS_KEY = "conduct";

/** Format the run's `RunStats` into a single status line.
 *  Pure; no I/O; no `ctx`. The line stays compact enough
 *  for the TUI footer alongside other extensions' status
 *  lines. */
export function formatConductStatus(stats: RunStats): string {
  const state = stats.state;
  const reason = stats.exitReason;
  const handoffs = countHandoffs(stats.transitionHistory);
  const cost = stats.costRollup.perRun.cost.toFixed(3);
  const activeSession = stats.activeSession;
  const modelPart =
    activeSession === undefined || activeSession === null
      ? ""
      : ` · model=${formatActiveModelToken(activeSession.model)} · effort=${formatEffortToken(activeSession.effort)}`;
  const activeSubagents =
    stats.subagents.active > 0 ? ` · subagents=${stats.subagents.active} active` : "";
  const escapeHint = reason === "running" ? " · Esc abort" : "";
  return `conduct: ${state} · ${reason}${modelPart}${activeSubagents} · handoffs=${handoffs} · $${cost}${escapeHint}`;
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
 * Options the poller accepts on top of the
 * `(handle, setStatus)` v1 signature. Currently a
 * single field: the per-tick transition diff callback
 * (Phase 8 / handoff-visibility, spec R1, AC1, AC2,
 * AC5, AC6).
 *
 * The shape is an options bag rather than positional
 * args so the v1 callers (`(handle, setStatus)`) stay
 * source-compatible: extending the signature with a
 * single positional arg would have broken every call
 * site. The poller is the single owner of status
 * updates; the callback is the only seam a handler
 * needs to wire the handoff-notify path.
 */
export interface StartStatusPollerOptions {
  /**
   * Invoked on each tick with the entries that
   * appeared in `transitionHistory` since the previous
   * tick. The poller tracks the last-seen length; a
   * tick with no new entries does not call the
   * callback. The callback is invoked BEFORE the
   * terminal check, so the final `end` transition is
   * notified too.
   *
   * The tracker is seeded from the FIRST `runStats()`
   * read (the initial tick). This is what makes
   * `/conduct:resume` (which starts the poller with a
   * history already populated) not re-notify
   * historical transitions (AC6). The first tick
   * establishes the baseline; only entries appended
   * AFTER the poller started are notified.
   */
  readonly onNewTransitions?: (records: readonly TransitionRecord[]) => void;
}

/** Braille spinner frames. Cycles on the 250ms poll interval. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Options for stopping a status poller. */
export interface StopStatusPollerOptions {
  /** Emit transitions that appeared since the last interval tick. */
  readonly flush?: boolean;
  /** Clear the status line through the poller's captured UI callback. */
  readonly clearStatus?: boolean;
}

/** A status poller disposer, optionally skipping stale-context UI work. */
export type StatusPollerStop = (options?: StopStatusPollerOptions) => void;

let trackedStatusPoller: StatusPollerStop | null = null;

/**
 * Track the process-wide poller so session replacement can detach it before
 * pi invalidates the command context captured by its callbacks.
 */
export function trackStatusPoller(stop: StatusPollerStop): () => void {
  if (trackedStatusPoller !== null) {
    const previous = trackedStatusPoller;
    trackedStatusPoller = null;
    previous({ flush: false, clearStatus: false });
  }
  trackedStatusPoller = stop;
  return () => {
    if (trackedStatusPoller === stop) trackedStatusPoller = null;
  };
}

/**
 * Detach the tracked poller. Session lifecycle handlers must pass both flags
 * as false because the captured command UI context may already be stale.
 */
export function stopTrackedStatusPoller(options?: StopStatusPollerOptions): void {
  const stop = trackedStatusPoller;
  trackedStatusPoller = null;
  stop?.(options);
}

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
 * When the run is active (`exitReason === "running"`), a
 * braille spinner character is prepended to the status
 * line. The spinner cycles on each tick. Terminal ticks
 * clear the line with no spinner.
 *
 * @param handle - The active `RunHandle`. The poller
 *                 reads `runStats()` on every tick; the
 *                 call is cheap (in-memory projection
 *                 over the run's records).
 * @param setStatus - The TUI's status setter. Called
 *                    with the rendered line on every
 *                    non-terminal tick and with
 *                    `undefined` on terminal + on
 *                    `stop()`.
 * @param options - Optional behavior extensions. The
 *                  only field is `onNewTransitions`,
 *                  the live handoff-notify hook
 *                  (Phase 8).
 * @returns A `stop` function the caller MUST call on
 *          handler failure (try/finally) to ensure the
 *          timer does not leak after an unhandled error.
 */
export function startStatusPoller(
  handle: RunHandle,
  setStatus: (text: string | undefined) => void,
  options: StartStatusPollerOptions = {},
): StatusPollerStop {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  // `-1` sentinel: the first tick establishes the
  // baseline (current history length) so historical
  // transitions are not re-notified (AC6). Any
  // non-negative number would also work, but `-1`
  // makes the "uninitialized" intent explicit and
  // makes a regression obvious in tests.
  let lastSeenLength = -1;
  // Spinner frame index: advances on each non-terminal
  // tick. Starts at 0 so the first tick shows "⠋".
  let spinnerIndex = 0;
  const onNewTransitions = options.onNewTransitions;

  const tick = (): void => {
    if (stopped) return;
    const stats = handle.runStats();
    const history = stats.transitionHistory;

    // Transition diff (Phase 8). The first tick
    // seeds `lastSeenLength` from the current
    // history — historical entries are NEVER
    // re-notified. Subsequent ticks emit only the
    // newly-appended entries (slice from the old
    // length). The diff is computed BEFORE the
    // terminal check so the final `end` is notified.
    if (lastSeenLength === -1) {
      lastSeenLength = history.length;
    } else if (history.length > lastSeenLength && onNewTransitions !== undefined) {
      const newEntries = history.slice(lastSeenLength);
      lastSeenLength = history.length;
      onNewTransitions(newEntries);
    }

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

    // Prepend the spinner frame to the status line (C1:
    // poller-level, NOT inside `formatConductStatus`).
    // `formatConductStatus` stays pure — the existing 11
    // string-equality assertions in status.test.ts target
    // it directly and are unchanged.
    const frame = SPINNER_FRAMES[spinnerIndex];
    spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
    setStatus(`${frame} ${formatConductStatus(stats)}`);
  };

  // Render the initial line immediately so the user
  // sees something before the first interval fires.
  tick();
  timer = setInterval(tick, POLL_INTERVAL_MS);

  const stop: StatusPollerStop = (stopOptions = {}): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }

    // Session replacement cleanup must not invoke either
    // callback: both close over the old command context.
    if (stopOptions.flush !== false && onNewTransitions !== undefined && lastSeenLength !== -1) {
      const finalStats = handle.runStats();
      const finalHistory = finalStats.transitionHistory;
      if (finalHistory.length > lastSeenLength) {
        onNewTransitions(finalHistory.slice(lastSeenLength));
        lastSeenLength = finalHistory.length;
      }
    }

    // Always clear the line on stop unless this is
    // session-replacement cleanup. The latter must not
    // touch the captured UI context after pi invalidates it.
    if (stopOptions.clearStatus !== false) setStatus(undefined);
  };

  return stop;
}
