/**
 * `/conduct:abort` handler — Phase 7B Task 7B.3.
 *
 * Aborts the active run via `RunHandle.abort()`. The
 * plan: "Abort reports when no active run is known in
 * the current extension process. Abort of an active run
 * resolves the handle with an aborted terminal state."
 *
 * **Synchronous shape.** The handler is `async` to
 * match the SDK's `(args, ctx) => Promise<void>`
 * signature, but the work is purely synchronous:
 * `RunHandle.abort()` flips a flag the loop checks on
 * its next `turn_end` / `session_ended` boundary. The
 * status poller (in `start.ts` / `resume.ts`) observes
 * the terminal state and clears the line. The handler
 * in `/conduct` / `/conduct:resume` will then fire its
 * terminal notification.
 *
 * **No-op when no active run.** A user who types
 * `/conduct:abort` outside of a run sees an info
 * notification. This is the 7B.3 acceptance: "Abort
 * reports when no active run is known in the current
 * extension process."
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { getActiveRun } from "../active-run.js";
import type { HandleDeps } from "./start.js";

export async function handleAbort(
  _args: string,
  ctx: ExtensionCommandContext,
  _deps: HandleDeps,
): Promise<void> {
  const handle = getActiveRun();
  if (handle === null) {
    ctx.ui.notify("No active pi-conductor run to abort.", "info");
    return;
  }
  await handle.abort("user requested /conduct:abort");
  // The active run remains the same reference; the
  // loop will see the abort flag on its next boundary
  // and resolve the completion promise with
  // `exitReason: "aborted"`. The originating handler
  // (`/conduct` or `/conduct:resume`) is the one that
  // clears the active slot on terminal.
  ctx.ui.notify(`Abort requested for pi-conductor run_id=${handle.runId}.`, "info");
}
