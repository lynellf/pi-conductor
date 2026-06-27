/**
 * Extension-side adapter from streamed display events to pi custom messages.
 *
 * The host emits display events; the extension factory converts them
 * into custom session messages through the SDK's `sendMessage`
 * action so the TUI can render them without mutating the session tree.
 *
 * The `details` payload shape — `{ role, kind, is_orchestrator }` —
 * is the seam contract shared with the conductor-owned message
 * renderer in `conduct-message-renderer.ts`. `kind` is `"text"` for
 * LLM text events and `"tool"` for tool_call/tool_result display
 * events (the formatter converts both into compact one-line summaries
 * or `✓`/`✗` indicators). `is_orchestrator` is a derived boolean the
 * sink computes at emission time against the active run's orchestrator
 * role (tracked in `current-orchestrator.ts`), and the renderer reads
 * it for label color.
 *
 * ## Phase 7B.UX — tool observability
 *
 * Tool events (`tool_call`, `tool_result`) are now emitted as
 * `conduct.role.tool` `CustomMessage`s with `details.kind: "tool"`.
 * The formatters in `src/host/tool-summary.ts` produce compact
 * summaries (e.g. `bash: pnpm test`) or `✓`/`✗` indicators — not
 * the full JSON flood. Conductor machine tools (`handoff`/`end`/
 * `ask_user`) are suppressed at the formatter level and never
 * reach the sink. Full tool bodies remain in the per-role session
 * JSONL (`<cwd>/.pi-conductor/runs/<run_id>/sessions/`); the TUI
 * stream is an observability surface, not the durable record.
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
    // Phase 7B.UX: tool events (`tool_call`, `tool_result`) are now
    // emitted as `conduct.role.tool` with compact summaries. The
    // formatters in src/host/tool-summary.ts already suppress machine
    // tools by returning `null` — the sink only sees non-null events
    // for built-in tools.
    //
    if (event.kind === "text") {
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
      return;
    }

    // Stream continuation chunks: emit as `conduct.role.text_stream`.
    // Label-less by design — the renderer ignores `is_orchestrator`
    // and produces no role label (N12). We still stamp `kind` as
    // `"text_stream"` for the renderer to distinguish from labeled
    // text, and `role` for grep-ability.
    if (event.kind === "text_stream") {
      // is_orchestrator is always false: the label-less renderer
      // (conduct.role.text_stream) never uses it for coloring.
      // Stamped for structural consistency with the details contract.
      const details: ConductMessageDetails = {
        role: event.role,
        kind: "text_stream",
        is_orchestrator: false,
      };
      sendMessage({
        customType: "conduct.role.text_stream",
        content: event.text,
        display: true,
        details,
      });
      return;
    }

    // Tool events: emit as `conduct.role.tool`. The content is the
    // formatter-produced summary (e.g. "bash: ls" for tool_call,
    // "✓" or "✗ <first line>" for tool_result). `kind` is "tool"
    // for both so the renderer does not need a third discriminator.
    if (event.kind === "tool_call" || event.kind === "tool_result") {
      const orchestratorRole = getCurrentOrchestratorRole();
      const details: ConductMessageDetails = {
        role: event.role,
        kind: "tool",
        is_orchestrator: orchestratorRole !== null && event.role === orchestratorRole,
      };
      sendMessage({
        customType: "conduct.role.tool",
        content: event.text,
        display: true,
        details,
      });
      return;
    }
  };
}
