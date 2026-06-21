/**
 * Extension-side adapter from streamed display events to pi custom messages.
 *
 * The host emits display events; the extension factory converts them
 * into custom session messages through the SDK's `sendMessage`
 * action so the TUI can render them without mutating the session tree.
 *
 * The `details` payload shape — `{ role, kind, is_orchestrator }` —
 * is the seam contract shared with the conductor-owned message
 * renderer in `conduct-message-renderer.ts`. `kind` is always
 * `"text"` (the sink suppresses every tool event — see below);
 * `is_orchestrator` is a derived boolean the sink computes at
 * emission time against the active run's orchestrator role (tracked
 * in `current-orchestrator.ts`), and the renderer reads it for label
 * color.
 *
 * ## Phase 5.5 remediation — what the sink emits
 *
 * Only `text` events become `CustomMessage`s. The body is the LLM's
 * text verbatim — no `### ${role}` prefix (the renderer's structural
 * role label already names the role, so a second heading was
 * visual duplication). `tool_call` and `tool_result` events are
 * suppressed entirely: tool args are JSON-shaped and the
 * `handoff`/`end` tool results are model-facing protocol noise
 * ("emission recorded: …"). Real tool activity remains in the
 * per-role session JSONL
 * (`<cwd>/.pi-conductor/runs/<run_id>/sessions/`); the TUI stream
 * is an observability surface, not the durable record. A future
 * phase that wants non-JSON tool rendering in the TUI re-introduces
 * a `conduct.role.tool` `customType` + a structured renderer.
 *
 * The body uses markdown so the conductor-owned renderer can present
 * it via the SDK's `getMarkdownTheme()` with no
 * `defaultTextStyle.color` override (the bug the default
 * `CustomMessageComponent` has — see
 * `the TUI bridge polish spec Diagnosis).
 * Any code fences the LLM emits (```…```) are rendered as code
 * blocks by the markdown theme's native handling.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { DisplayEvent, DisplaySink } from "../host/display-sink.js";
import type { ConductMessageDetails } from "./conduct-message-renderer.js";
import { getCurrentOrchestratorRole } from "./current-orchestrator.js";

/**
 * Wrap `pi.sendMessage()` in the display sink expected by the host.
 * The message body is the LLM's text verbatim (markdown), so the
 * conductor-owned renderer can present it via `getMarkdownTheme()`.
 *
 * `is_orchestrator` is derived against the active run's orchestrator
 * role (set by the `/conduct` and `/conduct:resume` handlers on run
 * start, cleared on terminal). When no run is live, every event is
 * stamped `is_orchestrator: false` — the renderer treats this as
 * the "unknown" case and uses the muted default color.
 */
export function createConductDisplaySink(sendMessage: ExtensionAPI["sendMessage"]): DisplaySink {
  return (event: DisplayEvent) => {
    // Phase 5.5: suppress all tool activity from the TUI stream.
    // Tool calls and tool results (the conductor's `handoff`/`end`
    // machine tools AND built-in tools like `bash`/`read`) are
    // protocol noise here; the user-meaningful signal is the LLM's
    // text reasoning. Real tool activity stays in the per-role
    // session JSONL. See the file-level doc for the rationale.
    if (event.kind !== "text") return;

    const orchestratorRole = getCurrentOrchestratorRole();
    const details: ConductMessageDetails = {
      role: event.role,
      kind: "text",
      is_orchestrator: orchestratorRole !== null && event.role === orchestratorRole,
    };
    sendMessage({
      customType: "conduct.role.text",
      content: event.text,
      display: true,
      details,
    });
  };
}
