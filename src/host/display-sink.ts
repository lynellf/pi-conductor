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
 *
 * Phase 1 (open-issues-round-3, issue #12): `DisplayEvent` gains an
 * optional `files` field carrying `TouchedFile` entries for
 * file-mutating tool invocations (`write`, `edit`). Read-only tools
 * (`read`, `grep`, `find`, `ls`) and machine tools (`handoff`, `end`,
 * `ask_user`) never populate `files`. `bash` is out of scope for v1.
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

/**
 * A single file mutation observed from a tool invocation.
 *
 * `additions` and `deletions` are **char-count** metrics derived from
 * the tool's args — we don't have pre-write file content for `write`,
 * so `write` always reports `deletions: 0`; `edit` sums `oldText` /
 * `newText` length across its `edits[]` array. Char-count is the only
 * metric derivable from args alone; a future iteration could swap in
 * line-counts if RunDeck or other consumers require precision.
 *
 * @see extractFileMutations — the only caller that populates this type.
 */
export interface TouchedFile {
  readonly path: string;
  /** Char-count of new content introduced by the tool call. */
  readonly additions?: number;
  /** Char-count of content removed by the tool call. */
  readonly deletions?: number;
}

/** Single display event from a role session. */
export interface DisplayEvent {
  readonly role: Role;
  readonly kind: DisplayEventKind;
  readonly text: string;
  /**
   * Files touched by a mutating tool invocation. Populated only on
   * successful `tool_result` events for `write` and `edit`
   * (read-only and machine tools are excluded; `bash` is out of
   * scope for v1 — see plan Open Question 1).
   *
   * Optional: consumers that don't need file annotations can ignore
   * the field entirely. `text` and `tool_call` events never carry
   * `files`.
   */
  readonly files?: ReadonlyArray<TouchedFile>;
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

// ─── Issue #12: file mutation extraction ───────────────────────────────

/** Guard: is `val` a plain object? (not null, not array) */
function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

/**
 * Extract the list of files a tool invocation touched, with optional
 * additions/deletions char-counts.
 *
 * Returns:
 * - `undefined` for non-mutating tools (`read`, `grep`, `find`, `ls`,
 *   the conductor machine tools `handoff`/`end`/`ask_user`, and any
 *   tool name not in `write`/`edit`). Callers use `undefined` to
 *   distinguish "not applicable" from "no files matched."
 * - A (possibly empty) `TouchedFile[]` for `write`/`edit` invocations.
 *   Empty when `args` is missing the expected fields (e.g., an `edit`
 *   call with no `edits` array, or a `write` call without a `content`
 *   field) — caller may choose to emit `files: []` for diagnostics or
 *   omit the field.
 *
 * **Metric unit:** char-count. `write` always reports `deletions: 0`
 * because the previous file content is not in the tool args; only
 * the new content is observable. `edit` sums `oldText.length` /
 * `newText.length` across the `edits[]` array.
 *
 * **Pure function** — no I/O, no SDK coupling beyond the typed
 * `args: unknown` shape. Unit-testable in isolation; does not import
 * from `@earendil-works/pi-coding-agent` (lives in `src/host/`).
 *
 * @param toolName - The tool name from the SDK event.
 * @param args - The `args` field (typed `unknown` to match the
 *               SDK's `any` at the call site; widening is safe).
 */
export function extractFileMutations(
  toolName: string,
  args: unknown,
): ReadonlyArray<TouchedFile> | undefined {
  switch (toolName) {
    case "write": {
      if (!isObject(args)) return [];
      const path = typeof args.path === "string" ? args.path : undefined;
      if (path === undefined) return [];
      // Require content to be a string; non-string content means the
      // tool args don't match the expected shape → return [].
      if (typeof args.content !== "string") return [];
      return [{ path, additions: args.content.length, deletions: 0 }];
    }

    case "edit": {
      if (!isObject(args)) return [];
      const path = typeof args.path === "string" ? args.path : undefined;
      if (path === undefined) return [];
      const rawEdits = args.edits;
      if (!Array.isArray(rawEdits) || rawEdits.length === 0) return [];
      let additions = 0;
      let deletions = 0;
      for (const edit of rawEdits) {
        if (isObject(edit)) {
          if (typeof edit.newText === "string") additions += edit.newText.length;
          if (typeof edit.oldText === "string") deletions += edit.oldText.length;
        }
      }
      return [{ path, additions, deletions }];
    }

    case "read":
    case "grep":
    case "find":
    case "ls":
    case "handoff":
    case "end":
    case "ask_user":
      return undefined;

    default:
      return undefined;
  }
}
