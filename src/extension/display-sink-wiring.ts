/**
 * Extension-side adapter from streamed display events to pi custom messages.
 *
 * The host emits display events; the extension factory converts them
 * into custom session messages through the SDK's `sendMessage`
 * action so the TUI can render them without mutating the session tree.
 *
 * The `details` payload shape — `{ role, kind, is_orchestrator }` —
 * is the seam contract shared with the conductor-owned message
 * renderer in `conduct-message-renderer.ts`. The `is_orchestrator`
 * field is a derived boolean the sink computes at emission time
 * against the active run's orchestrator role (tracked in
 * `current-orchestrator.ts`); the renderer reads it for label color.
 *
 * The body uses markdown so the conductor-owned renderer can present
 * it via the SDK's `getMarkdownTheme()` with no
 * `defaultTextStyle.color` override (the bug the default
 * `CustomMessageComponent` has — see
 * `docs/tui-bridge-plans/phase-5-renderer-polish.md` §Diagnosis).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { DisplayEvent, DisplaySink } from "../host/display-sink.js";
import type { ConductMessageDetails } from "./conduct-message-renderer.js";
import { getCurrentOrchestratorRole } from "./current-orchestrator.js";

/**
 * Wrap `pi.sendMessage()` in the display sink expected by the host.
 * The message body uses markdown so the conductor-owned renderer
 * can present it via `getMarkdownTheme()`.
 *
 * `is_orchestrator` is derived against the active run's orchestrator
 * role (set by the `/conduct` and `/conduct:resume` handlers on run
 * start, cleared on terminal). When no run is live, every event is
 * stamped `is_orchestrator: false` — the renderer treats this as
 * the "unknown" case and uses the muted default color.
 */
export function createConductDisplaySink(sendMessage: ExtensionAPI["sendMessage"]): DisplaySink {
  return (event: DisplayEvent) => {
    const orchestratorRole = getCurrentOrchestratorRole();
    const details: ConductMessageDetails = {
      role: event.role,
      kind: event.kind === "text" ? "text" : "tool",
      is_orchestrator: orchestratorRole !== null && event.role === orchestratorRole,
    };
    sendMessage({
      customType: event.kind === "text" ? "conduct.role.text" : "conduct.role.tool",
      content: `### ${event.role}\n\n${event.text}`,
      display: true,
      details,
    });
  };
}
