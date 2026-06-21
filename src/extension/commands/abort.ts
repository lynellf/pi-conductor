/**
 * `/conduct:abort` handler — Phase 7B Task 7B.3.
 *
 * Aborts the active run via `RunHandle.abort()`. The
 * plan: "Abort reports when no active run is known in
 * the current extension process. Abort of an active run
 * resolves the handle with an aborted terminal state."
 *
 * **Shared abort bridge.** The handler is `async` to
 * match the SDK's `(args, ctx) => Promise<void>`
 * signature, but the work is still very small: it
 * delegates to the shared helper, which aborts the live
 * session bridge and lets the loop observe the terminal
 * state on its next boundary. The status poller (in
 * `start.ts` / `resume.ts`) observes the terminal state
 * and clears the line. The handler in `/conduct` /
 * `/conduct:resume` then fires its terminal
 * notification.
 *
 * **No-op when no active run.** A user who types
 * `/conduct:abort` outside of a run sees an info
 * notification. This is the 7B.3 acceptance: "Abort
 * reports when no active run is known in the current
 * extension process."
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { abortActiveRun, notifyConductAbortResult } from "./abort-active-run.js";
import type { HandleDeps } from "./start.js";

export async function handleAbort(
  _args: string,
  ctx: ExtensionCommandContext,
  _deps: HandleDeps,
): Promise<void> {
  const result = await abortActiveRun({ reason: "user requested /conduct:abort" });
  // The helper never notifies directly; `/conduct:abort` keeps the existing
  // no-active / cleanup-race info text while reusing the same abort path.
  notifyConductAbortResult(ctx, result);
}
