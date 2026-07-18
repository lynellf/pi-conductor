import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getActiveRun } from "../active-run.js";

/** Handle `/conduct:followup <message>` against the active run only. */
export async function handleFollowUp(args: string, ctx: ExtensionCommandContext): Promise<void> {
  if (args.trim().length === 0) {
    ctx.ui.notify("Usage: /conduct:followup <message>", "warning");
    return;
  }
  const handle = getActiveRun();
  if (handle === null) {
    ctx.ui.notify("No active pi-conductor run for follow-up.", "info");
    return;
  }

  try {
    await handle.followUp(args);
    ctx.ui.notify(`Accepted follow-up guidance for pi-conductor run_id=${handle.runId}.`, "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(
      `Cannot queue follow-up for pi-conductor run_id=${handle.runId}: ${message}`,
      "error",
    );
  }
}
