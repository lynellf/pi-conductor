/**
 * Extension-side adapter from streamed display events to pi custom messages.
 *
 * The host emits display events; the extension factory converts them
 * into custom session messages through the SDK's `sendMessage`
 * action so the TUI can render them without mutating the session tree.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { DisplayEvent, DisplaySink } from "../host/display-sink.js";

/**
 * Wrap `pi.sendMessage()` in the display sink expected by the host.
 * The message body uses markdown so the default custom-message
 * renderer can present it directly.
 */
export function createConductDisplaySink(sendMessage: ExtensionAPI["sendMessage"]): DisplaySink {
  return (event: DisplayEvent) => {
    sendMessage({
      customType: event.kind === "text" ? "conduct.role.text" : "conduct.role.tool",
      content: `### ${event.role}\n\n${event.text}`,
      display: true,
      details: { role: event.role, kind: event.kind },
    });
  };
}
