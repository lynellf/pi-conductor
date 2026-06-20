/**
 * `/conduct <goal>` handler — Phase 7B Task 7B.2.
 *
 * Resolves the manifest path, constructs a `ProductionHost`
 * from the extension's `modelRegistry` + `cwd`, and calls
 * `startRun(manifestPath, { goal, hostFactory })`. The
 * returned `RunHandle` becomes the active run; a status
 * poller updates the footer line on each tick. On terminal,
 * the handler notifies the user with `run_id` and the
 * terminal reason + state, then clears the status + active
 * slot.
 *
 * **No-manifest branch.** When neither `--conduct-manifest`
 * nor `<cwd>/.pi/conductor.yaml` resolves to a file, the
 * handler notifies a warning and returns without touching
 * the active-run tracker. This is the 7B.2 acceptance.
 *
 * **Errors.** Manifest load / validate errors are surfaced
 * as a warning notification (so the user can fix the
 * manifest). The host's runtime errors (model not found,
 * system prompt missing) bubble up — the loop's
 * `session_failed` path records them, and the terminal
 * notification reflects the failure.
 *
 * The handler is `async` and returns when the run reaches
 * a terminal state OR when the user has been notified of
 * a non-recoverable error. Status polling is cleared in
 * both branches.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DisplaySink } from "../../host/display-sink.js";
import {
  createProductionHost,
  type Host,
  type HostFactoryContext,
  type LoadedManifest,
  type RunHandle,
  startRun,
} from "../../index.js";
import { getActiveRun, setActiveRun } from "../active-run.js";
import { setCurrentOrchestratorRole } from "../current-orchestrator.js";
import { formatHandoffNotify } from "../handoff-view.js";
import { resolveManifestPath } from "../manifest.js";
import { startStatusPoller } from "../status.js";

/**
 * Default per-project location for the file-backed
 * `RecordLog`. Pinned so `/conduct:list` can find runs
 * from prior `/conduct` invocations within the same
 * project. Matches the production host's session-dir
 * convention (`<cwd>/.pi-conductor/runs/...`) so the
 * log + session files are co-located.
 *
 * The directory is `mkdirSync`'d on the first
 * `/conduct` invocation. Idempotent.
 */
export const DEFAULT_RUN_BASE_DIR = ".pi-conductor/runs";

/**
 * Resolve the per-project run-log base dir. Always
 * returns a project-relative absolute path; the caller
 * (handler) is responsible for ensuring the directory
 * exists.
 */
export function resolveRunBaseDir(cwd: string): string {
  return join(cwd, DEFAULT_RUN_BASE_DIR);
}

/**
 * Ensure the run-log base dir exists. Idempotent —
 * `mkdirSync({ recursive: true })` is a no-op if the
 * dir already exists. Called by `/conduct` and
 * `/conduct:resume` before delegating to `startRun` /
 * `resumeRun`.
 */
export function ensureRunBaseDir(cwd: string): string {
  const baseDir = resolveRunBaseDir(cwd);
  mkdirSync(baseDir, { recursive: true });
  return baseDir;
}

/**
 * Closure the factory passes to each handler. `getFlag`
 * is a `pi.getFlag`-shaped reader; the factory creates
 * the closure once and shares it across all four
 * handlers so the flag value is read consistently at
 * command time. (The flag is read at command time, not
 * at factory time, so a `--flag` set on the pi CLI line
 * flows into the handler.)
 */
export type GetFlagValue = (name: string) => boolean | string | undefined;

/** Args passed to the handler in addition to the standard
 *  `(args, ctx)` shape. The factory injects these so the
 *  handler has the flag reader + production-host-aware
 *  ctx fields without coupling to `pi`. */
export interface HandleDeps {
  readonly getFlag: GetFlagValue;
  readonly displaySink?: DisplaySink;
}

/**
 * Resolve the manifest path and start a run. The handler
 * always resolves (never throws) — errors become user
 * notifications, not unhandled rejections.
 *
 * The `args` parameter is the goal text (everything the
 * user typed after `/conduct`). Empty / whitespace-only
 * goals are treated as "missing" and notified.
 *
 * The signature is `(args, ctx, deps)` not the SDK's
 * `(args, ctx)` because the extension layer needs the
 * flag reader (the SDK ctx does not expose `getFlag`).
 * The factory in `conduct.ts` adapts the call shape;
 * the handler signature is internal to this package.
 */
export async function handleStart(
  args: string,
  ctx: ExtensionCommandContext,
  deps: HandleDeps,
): Promise<void> {
  const goal = args.trim();
  if (goal.length === 0) {
    ctx.ui.notify("Usage: /conduct <goal>", "warning");
    return;
  }

  // 1. Resolve the manifest path. `deps.getFlag` is the
  // extension's `pi.getFlag`-shaped reader; the cast is
  // a structural subset.
  const flagValue = deps.getFlag("conduct-manifest");
  const manifestPath = resolveManifestPath(
    typeof flagValue === "string" ? flagValue : undefined,
    ctx.cwd,
  );
  if (manifestPath === null) {
    ctx.ui.notify(
      `No conductor manifest found. Tried --conduct-manifest="${flagValue ?? ""}" and <cwd>/.pi/conductor.yaml. Write a manifest or pass --conduct-manifest <path>.`,
      "warning",
    );
    return;
  }

  // 2. Build the production host factory. The factory
  // closes over the run's `log` + `loadedManifest` once
  // `startRun` calls it (the host is bound to a single
  // run; the factory is not reused across resumes).
  const modelRegistry = ctx.modelRegistry;
  const cwd = ctx.cwd;

  const hostFactory = (factoryCtx: HostFactoryContext): Host =>
    createProductionHost({
      extension: {
        modelRegistry,
        cwd,
        uiContext: ctx.ui,
        ...(deps.displaySink !== undefined && { displaySink: deps.displaySink }),
      },
      run: {
        log: factoryCtx.log,
        loadedManifest: factoryCtx.loadedManifest as LoadedManifest,
        runId: factoryCtx.runId,
      },
    });

  // 3. Start the run. The host factory throws on hard
  // manifest errors; the typed `HostManifestError`
  // surfaces the rule codes. We catch and notify. The
  // baseDir is pinned to a per-project location so
  // `/conduct:list` can find runs from prior calls.
  const baseDir = ensureRunBaseDir(ctx.cwd);
  let handle: RunHandle;
  try {
    handle = await startRun(manifestPath, { goal, hostFactory, baseDir });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Cannot start run: ${message}`, "error");
    return;
  }

  setActiveRun(handle);
  // Stash the run's orchestrator role for the display
  // sink (Phase 5). The sink stamps `is_orchestrator`
  // on every emitted `CustomMessage` against this
  // role; the conductor-owned message renderer reads
  // it for label color. Cleared in the `finally` block
  // below, mirroring the `setActiveRun(null)` teardown.
  setCurrentOrchestratorRole(handle.def.orchestrator);

  // 4. Start the status poller. It updates the footer
  // line on each tick; cleared on terminal (in the
  // finally block below) or handler failure.
  //
  // The `onNewTransitions` callback (Phase 8 /
  // handoff-visibility, spec R1) maps each new
  // `TransitionRecord` through `formatHandoffNotify`
  // and emits an info notification. The poller
  // diffs `transitionHistory.length` and emits one
  // callback per tick when new entries appear, so
  // there is no double-notify across ticks. On a
  // resume, the poller seeds the tracker from the
  // current history length, so transitions that
  // happened before the resume are NOT re-notified
  // (AC6).
  const stopPoller = startStatusPoller(
    handle,
    (text) => {
      ctx.ui.setStatus("conduct", text);
    },
    {
      onNewTransitions: (records) => {
        for (const record of records) {
          ctx.ui.notify(formatHandoffNotify(record), "info");
        }
      },
    },
  );

  try {
    const { finalCheckpoint, exitReason } = await handle.completion();
    ctx.ui.notify(
      `pi-conductor run_id=${handle.runId} reached terminal state=${finalCheckpoint.current_role} reason=${exitReason}`,
      "info",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`pi-conductor run_id=${handle.runId} failed: ${message}`, "error");
  } finally {
    stopPoller();
    // Clear the active slot on terminal — a new run can
    // be started by a subsequent /conduct command.
    if (getActiveRun() === handle) {
      setActiveRun(null);
      setCurrentOrchestratorRole(null);
    }
  }
}
