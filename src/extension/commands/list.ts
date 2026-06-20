/**
 * `/conduct:list` handler — Phase 7B Task 7B.3.
 *
 * Renders one line per known run in the project-local
 * log directory. The plan: "list renders run summaries
 * without reaching into log internals." The summaries
 * are projected from `RunHandle.runStats()` — the same
 * pure projection the status poller reads.
 *
 * **Implementation.** `listRuns(baseDir)` returns the
 * run IDs known to the file log. For each ID, we open
 * a fresh `FileRecordLog` over the same `baseDir` and
 * compute `runStats()`. The manifest is loaded once
 * (every run in the same project shares the pinned
 * `MachineDefinition`), so the per-run computation is
 * cheap.
 *
 * **No-manifest branch.** When the manifest is missing
 * the handler notifies a warning (same rule as the
 * start + resume handlers) and returns. The base dir
 * is NOT touched in this branch — we cannot list runs
 * without a manifest because `runStats` requires
 * `def.manifest_version` and `def.orchestrator`.
 *
 * **Empty case.** When the base dir has no runs
 * (`listRuns` returns `[]`), the handler notifies
 * "No runs found" with the path it searched. This is
 * a user-facing hint that points at the right
 * location.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { FileRecordLog } from "../../host/index.js";
import { runStats } from "../../host/stats.js";
import {
  type LoadedManifest,
  listRuns,
  loadManifest,
  type PersistedRecord,
  type RunStats,
} from "../../index.js";
import { formatTransitionTrace } from "../handoff-view.js";
import { DEFAULT_MANIFEST_PATH, HOME_MANIFEST_PATH, resolveManifestPath } from "../manifest.js";
import { type HandleDeps, resolveRunBaseDir } from "./start.js";

/**
 * Max number of runs to render in a single notify.
 * `ctx.ui.notify` shows a single line in most TUI
 * modes; the join keeps the output under that limit
 * for typical projects. The cap is intentionally
 * small — `/conduct:list` is a sanity check, not a
 * run browser (the v1.1 TUI viewer would handle
 * pagination).
 */
const MAX_RENDERED_RUNS = 5;

export async function handleList(
  _args: string,
  ctx: ExtensionCommandContext,
  deps: HandleDeps,
): Promise<void> {
  const flagValue = deps.getFlag("conduct-manifest");
  const manifestPath = resolveManifestPath(
    typeof flagValue === "string" ? flagValue : undefined,
    ctx.cwd,
  );
  if (manifestPath === null) {
    // Mirror the start + resume handlers' no-manifest
    // notification (see start.ts for the rationale on the
    // multi-source diagnostic). The `homePath` is the
    // user's actual `os.homedir()`.
    const homePath = join(homedir(), HOME_MANIFEST_PATH);
    ctx.ui.notify(
      `No conductor manifest found. Tried --conduct-manifest="${
        flagValue ?? ""
      }", <cwd>/${DEFAULT_MANIFEST_PATH}, and ${homePath}. Write a manifest, pass --conduct-manifest <path>, or set up ${homePath} for cross-project sharing.`,
      "warning",
    );
    return;
  }

  // Load the manifest (def + warnings). Failure
  // surfaces as an error notification — the run IDs
  // without a matching def cannot be summarized.
  let loaded: LoadedManifest;
  try {
    loaded = await loadManifest(manifestPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Cannot load manifest for list: ${message}`, "error");
    return;
  }

  const baseDir = resolveRunBaseDir(ctx.cwd);
  const runIds = listRuns(baseDir);
  if (runIds.length === 0) {
    ctx.ui.notify(`No runs found in ${baseDir}.`, "info");
    return;
  }

  // Render the first N runs. The log is re-opened per
  // run (the `FileRecordLog` is per-`baseDir`, not
  // per-`runId`); each call is a `readFileSync` over
  // the JSONL file, which is cheap for the small
  // files the host produces in v1.
  //
  // Phase 8 / handoff-visibility: each per-run line
  // gains a transition trace (R3 / AC4). The trace is
  // sourced from `stats.transitionHistory` (the
  // narrower projection; the raw record's
  // `suggests_next` is Q1-deferred). The trace is
  // appended after the existing fields. An empty
  // history (a run with no transitions yet) renders
  // an empty string, so the line stays clean
  // (no trailing ` · → …` or stray `→`).
  const log = new FileRecordLog({ baseDir });
  const lines: string[] = [];
  for (const runId of runIds.slice(0, MAX_RENDERED_RUNS)) {
    const records: readonly PersistedRecord[] = log.records(runId);
    const stats: RunStats = runStats(records, runId, loaded.def, "running");
    const trace = formatTransitionTrace(stats.transitionHistory);
    const prefix = `${runId} · ${stats.state} · ${stats.exitReason} · $${stats.costRollup.perRun.cost.toFixed(3)}`;
    lines.push(trace.length > 0 ? `${prefix} · ${trace}` : prefix);
  }
  const overflow = runIds.length - lines.length;
  const summary = lines.join(" | ") + (overflow > 0 ? ` (+${overflow} more in ${baseDir})` : "");
  ctx.ui.notify(`Runs in ${baseDir}: ${summary}`, "info");
}
