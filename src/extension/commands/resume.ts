/**
 * `/conduct:resume <run_id>` handler — Phase 7B Task 7B.3.
 *
 * Resolves the manifest path (same rules as `/conduct`),
 * reconstructs the run through `resumeRun`, and surfaces
 * progress + terminal notification identically to the
 * start handler. The new `RunHandle` becomes the active
 * run; the previous active run (if any) was terminal by
 * the time the user typed `/conduct:resume` — the active
 * slot is overwritten.
 *
 * **Validation order:**
 *   1. `args` is non-empty after trim (the run_id is
 *      required). Empty → "Usage" warning.
 *   2. Manifest path resolves (same rule as `/conduct`).
 *      Missing → manifest warning.
 *   3. `resumeRun` is called. Errors from `resumeRun`
 *      (manifest version mismatch, no checkpoint for
 *      `run_id`, etc.) surface as a `Cannot resume run`
 *      error notification.
 *
 * The status poller + active-run tracking + terminal
 * notification are all delegated to the same teardown
 * path as `handleStart` — the only difference is the
 * `resumeRun` call.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  createProductionHost,
  type Host,
  type HostFactoryContext,
  type LoadedManifest,
  type RunHandle,
  resumeRun,
} from "../../index.js";
import { getActiveRun, setActiveRun } from "../active-run.js";
import { resolveManifestPath } from "../manifest.js";
import { startStatusPoller } from "../status.js";
import { ensureRunBaseDir, type HandleDeps } from "./start.js";

export async function handleResume(
  args: string,
  ctx: ExtensionCommandContext,
  deps: HandleDeps,
): Promise<void> {
  const runId = args.trim();
  if (runId.length === 0) {
    ctx.ui.notify("Usage: /conduct:resume <run_id>", "warning");
    return;
  }

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

  // Production host factory — same shape as /conduct.
  // Resume does not carry a goal (the run's existing
  // checkpoint + run memory are the seed); the goal
  // arg to `resumeRun` is used only if the resume
  // path needs a fresh prompt (it does not, in v1 —
  // the run continues from `current_role`).
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

  const baseDir = ensureRunBaseDir(ctx.cwd);
  let handle: RunHandle;
  try {
    handle = await resumeRun(manifestPath, runId, {
      goal: "",
      hostFactory,
      baseDir,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Cannot resume run ${runId}: ${message}`, "error");
    return;
  }

  setActiveRun(handle);
  const stopPoller = startStatusPoller(handle, (text) => {
    ctx.ui.setStatus("conduct", text);
  });

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
    if (getActiveRun() === handle) {
      setActiveRun(null);
    }
  }
}
