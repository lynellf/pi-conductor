/**
 * `/conduct:list` handler — Phase 7B Task 7B.3.
 *
 * Renders the run IDs known to the file-backed log. The
 * plan: "list renders run summaries without reaching
 * into log internals." `listRuns(baseDir)` returns
 * `readonly string[]` (run IDs only); for a richer
 * summary the handler reads each run's `runStats()` and
 * composes a one-line summary.
 *
 * **Placeholder.** The full implementation lands in
 * Task 7B.3. See `resume.ts` for the rationale.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { HandleDeps } from "./start.js";

export async function handleList(
  _args: string,
  _ctx: ExtensionCommandContext,
  _deps: HandleDeps,
): Promise<void> {
  _ctx.ui.notify("/conduct:list is not yet implemented (Phase 7B.3).", "warning");
}
