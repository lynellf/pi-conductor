/**
 * Display-only event bridge for streamed role output — Phase 2.
 *
 * A role session can expose assistant text and tool activity to the
 * host TUI without mutating the session tree. The host emits these
 * events, and the extension maps them to custom messages.
 *
 * Phase 1 (open-issues-round-2): `text_stream` no longer emitted -
 * text now appears as a single `"text"` event per assistant turn
 * at `message_end`. The `text_stream` variant is retained in the
 * type for external code that may pattern-match on the full union,
 * but the host never emits it.
 */

import type { AssistantMessage, ThinkingContent } from "@earendil-works/pi-ai";

import type { Role } from "../core/types.js";

/**
 * Display event kind forwarded from a role session.
 *
 * - `"text"` — A labeled role text event. Used for full assistant
 *   messages (emitted once per `message_end`).
 * - `"tool_call"` / `"tool_result"` — Tool activity summaries
 *   (emitted per event, unchanged).
 *
 * `text_stream` is retained in the type for backward compatibility
 * but is no longer emitted by the host (Phase 1).
 */
export type DisplayEventKind = "text" | "text_stream" | "tool_call" | "tool_result";

/** Single display event from a role session. */
export interface DisplayEvent {
  readonly role: Role;
  readonly kind: DisplayEventKind;
  readonly text: string;
}

/** Sink for display-only role events. */
export type DisplaySink = (event: DisplayEvent) => void;

/**
 * Extract the readable assistant content from the SDK's structured
 * content array for display in the TUI: `text` parts AND non-redacted
 * `thinking` parts. Tool-call blocks are ignored (the host forwards
 * tool activity as separate `tool_call`/`tool_result` display events).
 *
 * Reversal of the original Phase 2 Task 3 "thinking omitted by
 * default" decision (2026-06-20, after Phase 5.5): the human wants
 * to see model reasoning at all times. Non-redacted `ThinkingContent`
 * (`.thinking` is a readable string) is now surfaced; redacted blocks
 * (safety-filtered — only an opaque `thinkingSignature` survives,
 * `.thinking` is empty) are skipped so the TUI never shows gibberish.
 *
 * ## Block joining
 *
 * Adjacent `text` parts merge with `""` (they are one logical
 * utterance the provider split across parts — merging preserves the
 * single-paragraph rendering). `thinking` parts are emitted as their
 * own blocks separated from text (and from each other) by `"\n\n"`,
 * so reasoning reads as its own paragraph above/below the answer.
 *
 * Non-redacted thinking blocks are blockquoted (`> `-prefixed) so
 * reasoning is visually de-emphasized relative to direct user
 * communication in the TUI markdown renderer.
 *
 * A message with only text parts is therefore byte-identical to the
 * pre-reversal behavior; only messages that carry thinking change.
 */
export function extractAssistantText(message: AssistantMessage): string {
  const blocks: string[] = [];
  let textBuf = "";
  for (const part of message.content) {
    if (part.type === "text") {
      textBuf += part.text;
      continue;
    }
    if (part.type === "thinking") {
      const thinking = readableThinking(part);
      if (thinking.length === 0) continue;
      if (textBuf.length > 0) {
        blocks.push(textBuf);
        textBuf = "";
      }
      blocks.push(blockquote(thinking));
    }
  }
  if (textBuf.length > 0) blocks.push(textBuf);
  return blocks.join("\n\n");
}

/** Prefix each line with `> ` so the renderer treats it as a markdown blockquote. */
function blockquote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/**
 * Read the human-readable text from a `ThinkingContent` part, or `""`
 * when the block was redacted by safety filters (only an opaque
 * `thinkingSignature` survives) or carries no thinking text. The
 * display extractor skips these so the TUI never shows gibberish.
 */
function readableThinking(part: ThinkingContent): string {
  if (part.redacted) return "";
  return typeof part.thinking === "string" ? part.thinking : "";
}
