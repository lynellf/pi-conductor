/**
 * Shared active-run abort helper and Escape listener wiring.
 *
 * The helper returns a discriminated status and never notifies on its own;
 * callers own their UX. `/conduct:abort` and the temporary Escape listener
 * both use the same selector/guarding logic so the cleanup race is handled
 * consistently.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

import type { RunExecutionStatus, RunHandle } from "../../host/index.js";
import { getActiveRun } from "../active-run.js";

/** Result status returned by the shared active-run abort helper. */
export type AbortActiveRunStatus =
  | "aborted"
  | "no_active_run"
  | "already_terminal_active_slot"
  | "stale_no_active"
  | "stale_different_active";

interface AbortActiveRunBase {
  readonly status: AbortActiveRunStatus;
}

export interface AbortActiveRunSucceeded extends AbortActiveRunBase {
  readonly status: "aborted";
  readonly runId: string;
}

export interface AbortActiveRunNoActive extends AbortActiveRunBase {
  readonly status: "no_active_run";
}

export interface AbortActiveRunAlreadyTerminal extends AbortActiveRunBase {
  readonly status: "already_terminal_active_slot";
  readonly runId: string;
  readonly exitReason: Exclude<RunExecutionStatus, "running">;
}

export interface AbortActiveRunStaleNoActive extends AbortActiveRunBase {
  readonly status: "stale_no_active";
  readonly runId: string;
}

export interface AbortActiveRunStaleDifferentActive extends AbortActiveRunBase {
  readonly status: "stale_different_active";
  readonly runId: string;
  readonly activeRunId: string;
}

export type AbortActiveRunResult =
  | AbortActiveRunSucceeded
  | AbortActiveRunNoActive
  | AbortActiveRunAlreadyTerminal
  | AbortActiveRunStaleNoActive
  | AbortActiveRunStaleDifferentActive;

/** Options for the shared helper. */
export interface AbortActiveRunOptions {
  /** The run handle the caller believes is active, if any. */
  readonly expectedHandle?: RunHandle;
  /** Reason passed to `RunHandle.abort()`. */
  readonly reason: string;
}

/**
 * Select the active run and abort it only while it is still running.
 *
 * The helper owns selection/guarding only; it does not notify. The caller
 * decides how to surface `no_active_run`, stale-slot cleanup races, and the
 * requested-abort message.
 */
export async function abortActiveRun(
  options: AbortActiveRunOptions,
): Promise<AbortActiveRunResult> {
  const activeRun = getActiveRun();
  if (options.expectedHandle === undefined) {
    if (activeRun === null) return { status: "no_active_run" };
    const stats = activeRun.runStats();
    if (stats.exitReason !== "running") {
      return {
        status: "already_terminal_active_slot",
        runId: activeRun.runId,
        exitReason: stats.exitReason,
      };
    }
    await activeRun.abort(options.reason);
    return { status: "aborted", runId: activeRun.runId };
  }

  if (activeRun === null) {
    return { status: "stale_no_active", runId: options.expectedHandle.runId };
  }
  if (activeRun !== options.expectedHandle) {
    return {
      status: "stale_different_active",
      runId: options.expectedHandle.runId,
      activeRunId: activeRun.runId,
    };
  }

  const stats = activeRun.runStats();
  if (stats.exitReason !== "running") {
    return {
      status: "already_terminal_active_slot",
      runId: activeRun.runId,
      exitReason: stats.exitReason,
    };
  }

  await activeRun.abort(options.reason);
  return { status: "aborted", runId: activeRun.runId };
}

/** Notify the user for `/conduct:abort` helper results. */
export function notifyConductAbortResult(
  ctx: ExtensionCommandContext,
  result: AbortActiveRunResult,
): void {
  if (result.status === "aborted") {
    ctx.ui.notify(`Abort requested for pi-conductor run_id=${result.runId}.`, "info");
    return;
  }
  if (result.status === "no_active_run" || result.status === "already_terminal_active_slot") {
    ctx.ui.notify("No active pi-conductor run to abort.", "info");
  }
}

/** Notify the user for Escape-confirm abort results. */
export function notifyEscapeAbortResult(
  ctx: ExtensionCommandContext,
  result: AbortActiveRunResult,
): void {
  if (result.status === "aborted") {
    ctx.ui.notify(`Abort requested for pi-conductor run_id=${result.runId}.`, "info");
    return;
  }
  if (result.status === "stale_different_active") {
    ctx.ui.notify(
      `Stale Escape abort ignored for run_id=${result.runId}; active run_id=${result.activeRunId}.`,
      "info",
    );
  }
}

export interface EscapeAbortListenerOptions {
  readonly ctx: ExtensionCommandContext;
  readonly handle: RunHandle;
  readonly abortReason: string;
  readonly onAbortResult: (result: AbortActiveRunResult) => void;
}

/**
 * Install a temporary Escape listener that opens one confirmation dialog and
 * then uses the shared abort helper.
 */
export function installConductEscapeAbortListener(options: EscapeAbortListenerOptions): () => void {
  let confirmOpen = false;
  return options.ctx.ui.onTerminalInput((data) => {
    if (!matchesKey(data, "escape") || confirmOpen) return undefined;
    confirmOpen = true;
    void (async () => {
      try {
        const confirmed = await options.ctx.ui.confirm(
          "Abort pi-conductor run?",
          `run_id=${options.handle.runId}; the current role session will be stopped.`,
        );
        if (!confirmed) return;
        const result = await abortActiveRun({
          expectedHandle: options.handle,
          reason: options.abortReason,
        });
        options.onAbortResult(result);
      } finally {
        confirmOpen = false;
      }
    })();
    return { consume: true };
  });
}
