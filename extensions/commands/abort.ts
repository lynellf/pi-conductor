/**
 * `/conduct:abort` handler — Phase 7B Task 7B.3.
 *
 * Aborts the active run via `RunHandle.abort()`. The
 * plan: "Abort reports when no active run is known in
 * the current extension process. Abort of an active run
 * resolves the handle with an aborted terminal state."
 *
 * **Placeholder.** The full implementation lands in
 * Task 7B.3. See `resume.ts` for the rationale.
 *
 * `HandleDeps` is re-exported so the factory in
 * `conduct.ts` only needs to import the type from this
 * module (the abort handler is the factory's last
 * `withDeps` consumer).
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { HandleDeps } from "./start.js";

export async function handleAbort(
  _args: string,
  _ctx: ExtensionCommandContext,
  _deps: HandleDeps,
): Promise<void> {
  _ctx.ui.notify("/conduct:abort is not yet implemented (Phase 7B.3).", "warning");
}
