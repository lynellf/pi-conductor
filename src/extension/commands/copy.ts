import { copyToClipboard, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getActiveRun, getMostRecentRun } from "../active-run.js";

export type CopyText = (text: string) => Promise<void>;

/** Copy the latest completed response from the active or most recent run. */
export async function handleCopy(
  _args: string,
  ctx: ExtensionCommandContext,
  copyText: CopyText = copyToClipboard,
  isContextCurrent: () => boolean = () => true,
): Promise<void> {
  const handle = getActiveRun() ?? getMostRecentRun();
  if (handle === null) {
    if (isContextCurrent()) ctx.ui.notify("No recent pi-conductor run to copy from.", "info");
    return;
  }
  const response = handle.latestResponse();
  if (response === null) {
    if (isContextCurrent()) {
      ctx.ui.notify(
        `No completed response is available for pi-conductor run_id=${handle.runId}.`,
        "info",
      );
    }
    return;
  }

  try {
    await copyText(response.text);
    if (isContextCurrent()) {
      ctx.ui.notify(
        `Copied latest ${response.role} response from pi-conductor run_id=${handle.runId}.`,
        "info",
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isContextCurrent()) {
      ctx.ui.notify(
        `Cannot copy latest response for pi-conductor run_id=${handle.runId}: ${message}`,
        "error",
      );
    }
  }
}
