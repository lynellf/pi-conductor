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

import { homedir } from "node:os";
import { join } from "node:path";
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
import { setCurrentOrchestratorRole } from "../current-orchestrator.js";
import { formatHandoffNotify } from "../handoff-view.js";
import { DEFAULT_MANIFEST_PATH, HOME_MANIFEST_PATH, resolveManifestPath } from "../manifest.js";
import { startStatusPoller } from "../status.js";
import { installConductEscapeAbortListener, notifyEscapeAbortResult } from "./abort-active-run.js";
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
    deps.homeDir,
  );
  if (manifestPath === null) {
    // Mirror the start handler's no-manifest notification —
    // see start.ts for the rationale on the multi-source
    // diagnostic. The HOME path uses `deps.homeDir` when
    // available (hermetic tests); production defaults to
    // `os.homedir()` inside `resolveManifestPath`.
    const homePath =
      deps.homeDir !== undefined
        ? join(deps.homeDir, HOME_MANIFEST_PATH)
        : join(homedir(), HOME_MANIFEST_PATH);
    ctx.ui.notify(
      `No conductor manifest found. Tried --conduct-manifest="${
        flagValue ?? ""
      }", <cwd>/${DEFAULT_MANIFEST_PATH}, and ${homePath}. Write a manifest, pass --conduct-manifest <path>, or set up ${homePath} for cross-project sharing.`,
      "warning",
    );
    return;
  }

  // Production host factory — same shape as /conduct.
  // The goal arg to `resumeRun` is always "" (the extension does not
  // accept a goal override at resume time); the original goal is
  // recovered from the persisted `run_seeded` record automatically
  // inside `resumeRun`.
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
      modelRegistry,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Cannot resume run ${runId}: ${message}`, "error");
    return;
  }

  // Surface any load-time provider-registration warnings (advisory only).
  // The check runs on resume too — a freshly-loaded manifest with the
  // same registry produces the same warnings, which is correct (the
  // registry contents may have changed since start).
  const unregisteredWarnings = handle.loadedManifest.warnings.filter(
    (w) => w.code === "unregistered-provider",
  );
  if (unregisteredWarnings.length > 0) {
    const entries = unregisteredWarnings.map((w) => w.message).join("; ");
    ctx.ui.notify(
      `pi-conductor: ${unregisteredWarnings.length} unregistered provider warning(s): ${entries}`,
      "warning",
    );
  }

  setActiveRun(handle);
  // Stash the run's orchestrator role for the display
  // sink (Phase 5). Mirrors the `/conduct` handler.
  setCurrentOrchestratorRole(handle.def.orchestrator);
  // Status poller + live handoff notify (Phase 8 /
  // handoff-visibility). The `onNewTransitions`
  // callback emits a notify per new transition. The
  // poller seeds its tracker from the FIRST
  // `runStats()` read, so transitions that happened
  // before the resume are NOT re-notified (AC6).
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

  const stopEscapeListener = installConductEscapeAbortListener({
    ctx,
    handle,
    abortReason: "user confirmed Escape interrupt",
    onAbortResult: (result) => {
      notifyEscapeAbortResult(ctx, result);
    },
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
    stopEscapeListener();
    stopPoller();
    if (getActiveRun() === handle) {
      setActiveRun(null);
      setCurrentOrchestratorRole(null);
    }
  }
}
