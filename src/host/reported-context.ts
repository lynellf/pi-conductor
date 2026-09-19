/** Exact tool-call-bound visible prose capture for v2 controls (§8). */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ReportedContextV2 } from "../core/types.js";

const MAX_REPORTED_CONTEXT_BYTES = 4096;

/** Per-session message adapter that never substitutes nearby assistant prose. */
export interface ReportedContextCapture {
  observe(event: AgentSessionEvent): void;
  read(toolCallId: string | undefined): ReportedContextV2 | null;
}

/** Create a bounded, exact-message visible-prose index. */
export function createReportedContextCapture(): ReportedContextCapture {
  const byToolCallId = new Map<string, ReportedContextV2>();
  return {
    observe(event) {
      if (event.type !== "message_end") return;
      const message = event.message;
      if (!isRecord(message) || message.role !== "assistant" || message.stopReason === "error")
        return;
      const content = message.content;
      if (!Array.isArray(content)) return;
      const pending: string[] = [];
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === "text" && typeof block.text === "string") {
          pending.push(block.text);
          continue;
        }
        if (block.type !== "toolCall") continue;
        const toolCallId = typeof block.id === "string" ? block.id : undefined;
        const toolName = typeof block.name === "string" ? block.name : undefined;
        if (toolName !== "handoff" && toolName !== "end") {
          pending.length = 0;
          continue;
        }
        if (toolCallId !== undefined) {
          const captured = boundContext(pending.join(""));
          if (captured !== null) byToolCallId.set(toolCallId, captured);
        }
        pending.length = 0;
      }
    },
    read(toolCallId) {
      if (toolCallId === undefined) return null;
      return byToolCallId.get(toolCallId) ?? null;
    },
  };
}

function boundContext(value: string): ReportedContextV2 | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const bytes = new TextEncoder().encode(trimmed);
  if (bytes.byteLength <= MAX_REPORTED_CONTEXT_BYTES) {
    return { text: trimmed, utf8_bytes: bytes.byteLength, truncated: false };
  }
  let end = MAX_REPORTED_CONTEXT_BYTES;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  const text = new TextDecoder().decode(bytes.slice(0, end));
  return { text, utf8_bytes: new TextEncoder().encode(text).byteLength, truncated: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
