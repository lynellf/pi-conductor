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
 * **Placeholder.** The full implementation lands in
 * Task 7B.3; this stub is here so the factory can
 * register all four commands in Task 7B.1. The stub
 * notifies and returns — it does NOT throw — so an
 * accidental invocation during 7B.1 testing surfaces a
 * clear message rather than an unhandled rejection.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { HandleDeps } from "./start.js";

export async function handleResume(
  _args: string,
  _ctx: ExtensionCommandContext,
  _deps: HandleDeps,
): Promise<void> {
  // Implemented in Task 7B.3. Notify-only for now.
  _ctx.ui.notify("/conduct:resume is not yet implemented (Phase 7B.3).", "warning");
}
