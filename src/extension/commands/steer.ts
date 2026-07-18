import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getActiveRun } from "../active-run.js";

/** Handle `/conduct:steer <message>` against the active run only. */
export async function handleSteer(args: string, ctx: ExtensionCommandContext): Promise<void> {
  if (args.trim().length === 0) {
    ctx.ui.notify("Usage: /conduct:steer <message>", "warning");
    return;
  }
  const handle = getActiveRun();
  if (handle === null) {
    ctx.ui.notify("No active pi-conductor run to steer.", "info");
    return;
  }

  try {
    await handle.steer(args);
    ctx.ui.notify(`Accepted steer guidance for pi-conductor run_id=${handle.runId}.`, "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Cannot steer pi-conductor run_id=${handle.runId}: ${message}`, "error");
  }
}
