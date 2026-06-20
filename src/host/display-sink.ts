/**
 * Display-only event bridge for streamed role output — Phase 2.
 *
 * A role session can expose assistant text and tool activity to the
 * host TUI without mutating the session tree. The host emits these
 * events, and the extension maps them to custom messages.
 */

import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";

import type { Role } from "../core/types.js";

/** Display event kind forwarded from a role session. */
export type DisplayEventKind = "text" | "tool_call" | "tool_result";

/** Single display event from a role session. */
export interface DisplayEvent {
  readonly role: Role;
  readonly kind: DisplayEventKind;
  readonly text: string;
}

/** Sink for display-only role events. */
export type DisplaySink = (event: DisplayEvent) => void;

/**
 * Extract assistant text from the SDK's structured content array.
 * Thinking blocks and tool-call blocks are ignored.
 */
export function extractAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * Stable stringification for display text. Plain strings pass
 * through; objects and arrays are JSON-rendered when possible.
 */
export function stringifyDisplayValue(value: unknown): string {
  if (typeof value === "string") return value;
  const json = JSON.stringify(value);
  if (json !== undefined) return json;
  return String(value);
}
