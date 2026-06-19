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

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  createProductionHost,
  type Host,
  type HostFactoryContext,
  type LoadedManifest,
  type RunHandle,
  startRun,
} from "../../src/index.js";
import { getActiveRun, setActiveRun } from "../active-run.js";
import { resolveManifestPath } from "../manifest.js";
import { startStatusPoller } from "../status.js";

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
      extension: { modelRegistry, cwd },
      run: {
        log: factoryCtx.log,
        loadedManifest: factoryCtx.loadedManifest as LoadedManifest,
        runId: factoryCtx.runId,
      },
    });

  // 3. Start the run. The host factory throws on hard
  // manifest errors; the typed `HostManifestError`
  // surfaces the rule codes. We catch and notify.
  let handle: RunHandle;
  try {
    handle = await startRun(manifestPath, { goal, hostFactory });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Cannot start run: ${message}`, "error");
    return;
  }

  setActiveRun(handle);

  // 4. Start the status poller. It updates the footer
  // line on each tick; cleared on terminal (in the
  // finally block below) or handler failure.
  const stopPoller = startStatusPoller(handle, (text) => {
    ctx.ui.setStatus("conduct", text);
  });

  try {
    const { finalCheckpoint, exitReason } = await handle.completion();
    ctx.ui.notify(
      `pi-conductor run ${handle.runId} reached terminal state=${finalCheckpoint.current_role} reason=${exitReason}`,
      "info",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`pi-conductor run ${handle.runId} failed: ${message}`, "error");
  } finally {
    stopPoller();
    // Clear the active slot on terminal — a new run can
    // be started by a subsequent /conduct command.
    if (getActiveRun() === handle) {
      setActiveRun(null);
    }
  }
}
