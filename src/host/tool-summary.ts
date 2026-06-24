/**
 * Tool summary formatters for the TUI tool-observability stream.
 *
 * Three pure functions:
 *   - `formatToolCallSummary` — compact one-line summary of a
 *     `tool_execution_start` event (args). The host now buffers
 *     this summary keyed by `toolCallId` and does NOT emit it on
 *     its own (spec: tool-display-combine-status).
 *   - `formatToolResultSummary` — legacy end-only indicator;
 *     retained for unit tests and as a fallback but no longer
 *     used by the host handler (the handler uses
 *     `formatToolCompletedLine` instead).
 *   - `formatToolCompletedLine` — the **single combined line**
 *     the handler now emits at `tool_execution_end`: the
 *     buffered invocation summary combined with the success/
 *     error status. `(✓|✗) <summary>: <error first line>`.
 *
 * All three return `null` for conductor machine tools (`handoff`,
 * `end`, `ask_user`) — these are protocol noise surfaced
 * elsewhere — and for unknown tools (safer than raw JSON).
 *
 * **Location rationale** (Nit 4): sits in `src/host/` only
 * because the consumer is `session-event-handler.ts`; the
 * formatter itself has no SDK dependency. A future
 * relocation to `src/seam/` or `src/extension/` would be
 * non-breaking.
 *
 * Spec: §1, Decisions Q1/Q2, Nit 4, Nit 6. Combined-line model:
 * tool-display-combine-status spec.
 */

// ─── Constants ──────────────────────────────────────────────────────

/**
 * Maximum length of a rendered `bash` command in the TUI
 * tool-observability line. Long commands are tail-truncated to
 * keep the line readable.
 *
 * Truncation rule: when `command.length` > MAX, slice to
 * `MAX - 1` (59) chars and append `…` (U+2026) for a total of
 * 60 chars including the ellipsis. Commands <= MAX render
 * verbatim (the `>` boundary, so exactly-60 is as-is).
 */
export const MAX_BASH_COMMAND_DISPLAY_LENGTH = 60;

/**
 * Maximum length of a rendered error line in the TUI
 * tool-observability line. Long error lines are tail-truncated
 * to keep the line readable.
 *
 * Truncation rule: when `line.length` > MAX, slice to
 * `MAX - 1` (119) chars and append `…` (U+2026) for a total of
 * 120 chars including the ellipsis. Lines <= MAX render verbatim.
 */
export const MAX_ERROR_LINE_DISPLAY_LENGTH = 120;

/**
 * Maximum length of the combined tool-completed line (buffer-and-
 * combine flow, spec: tool-display-combine-status). The whole
 * combined line `(✓|✗) <summary>: <error>` is tail-truncated to
 * this length with `…` when it exceeds the limit.
 *
 * Truncation rule identical to `truncateLine`: when
 * `line.length > MAX`, slice to `MAX - 1` (99) chars and append
 * `…` (U+2026) for a total of 100 chars including the ellipsis.
 * Lines <= MAX render verbatim.
 */
export const MAX_TOOL_LINE_DISPLAY_LENGTH = 100;

// ─── Helpers ────────────────────────────────────────────────────────

/** Check if `val` is a non-null object (plain or array). */
function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null;
}

/** Safely extract a string property from an unknown object. */
function safeString(obj: unknown, key: string): string | undefined {
  if (!isObject(obj)) return undefined;
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

/** Safely extract a number property from an unknown object. */
function safeNumber(obj: unknown, key: string): number | undefined {
  if (!isObject(obj)) return undefined;
  const v = obj[key];
  return typeof v === "number" ? v : undefined;
}

/** Safely extract an array property from an unknown object. */
function safeArray(obj: unknown, key: string): readonly unknown[] | undefined {
  if (!isObject(obj)) return undefined;
  const v = obj[key];
  return Array.isArray(v) ? v : undefined;
}

/**
 * Extract an error message from an unknown `result` value (spec §1,
 * D1 extraction order).
 *
 * Extraction order:
 *   1. `typeof result === "string"` → return directly.
 *   2. Object: `safeString(result, "message") ?? safeString(result, "error")`
 *   3. Object with nested `error` object: `safeString(result.error, "message") ?? safeString(result.error, "error")`
 *   4. Object: `safeString(result, "stderr")`
 *   5. Fallback: `JSON.stringify(result) ?? String(result)`.
 */
function extractErrorMessage(result: unknown): string {
  if (typeof result === "string") return result;

  if (isObject(result)) {
    // 2. Direct message / error fields
    const direct = safeString(result, "message") ?? safeString(result, "error");
    if (direct !== undefined) return direct;

    // 3. Nested error object
    const nested = result.error;
    if (isObject(nested)) {
      const nestedMsg = safeString(nested, "message") ?? safeString(nested, "error");
      if (nestedMsg !== undefined) return nestedMsg;
    }

    // 4. stderr field
    const stderr = safeString(result, "stderr");
    if (stderr !== undefined) return stderr;
  }

  // 5. Fallback: JSON.stringify
  const json = JSON.stringify(result);
  return json !== undefined ? json : String(result);
}

/**
 * Tail-truncate a single line to `max` characters, appending `…`
 * (U+2026) when the line exceeds `max`.
 */
function truncateLine(line: string, max: number): string {
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1)}…`;
}

/**
 * Known built-in tools that get compact summary rendering.
 * Conductor machine tools and unknown tools return `null`.
 */
const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

/** Machine tools to suppress — protocol noise. */
const MACHINE_TOOLS = new Set(["handoff", "end", "ask_user"]);

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Format a compact one-line summary for a `tool_execution_start`
 * event. Returns `null` for machine tools and unknown tools
 * (suppressed from TUI).
 *
 * Per-tool formats (spec §1):
 *   - `read` → `read: <path>` or `read: <path>:<offset>-<offset+limit>`
 *   - `bash` → `bash: <command>` (truncated if > 60 chars; see
 *     `MAX_BASH_COMMAND_DISPLAY_LENGTH`)
 *   - `edit` → `edit: <path> (<N> edits)` or `edit: <path>`
 *   - `write` → `write: <path>`
 *   - `grep` → `grep: "<pattern>" in <path>` or `grep: "<pattern>"`
 *   - `find` → `find: <path>`
 *   - `ls` → `ls: <path>`
 *
 * @param toolName - The tool name from the SDK event.
 * @param args - The `args` field (`ToolExecutionStartEvent.args`).
 *               Typed `unknown` to match the SDK's `any` at the
 *               call site (widening is safe).
 */
export function formatToolCallSummary(toolName: string, args: unknown): string | null {
  if (MACHINE_TOOLS.has(toolName)) return null;
  if (!BUILTIN_TOOLS.has(toolName)) return null;

  switch (toolName) {
    case "read": {
      const path = safeString(args, "path");
      if (path === undefined) return `read: <no path>`;
      const offset = safeNumber(args, "offset");
      const limit = safeNumber(args, "limit");
      if (offset !== undefined && limit !== undefined) {
        return `read: ${path}:${offset}-${offset + limit}`;
      }
      return `read: ${path}`;
    }

    case "bash": {
      const command = safeString(args, "command");
      if (command === undefined) return `bash: <no command>`;
      if (command.length > MAX_BASH_COMMAND_DISPLAY_LENGTH) {
        return `bash: ${command.slice(0, MAX_BASH_COMMAND_DISPLAY_LENGTH - 1)}…`;
      }
      return `bash: ${command}`;
    }

    case "edit": {
      const path = safeString(args, "path");
      if (path === undefined) return `edit: <no path>`;
      const edits = safeArray(args, "edits");
      if (edits !== undefined && edits.length > 0) {
        return `edit: ${path} (${edits.length} edits)`;
      }
      return `edit: ${path}`;
    }

    case "write": {
      const path = safeString(args, "path");
      return path !== undefined ? `write: ${path}` : `write: <no path>`;
    }

    case "grep": {
      const gArgs = isObject(args) ? args : {};
      const pattern = safeString(gArgs, "pattern");
      const path = safeString(gArgs, "path");
      if (pattern === undefined) return `grep: <no pattern>`;
      if (path !== undefined) return `grep: "${pattern}" in ${path}`;
      return `grep: "${pattern}"`;
    }

    case "find": {
      const path = safeString(args, "path");
      return path !== undefined ? `find: ${path}` : `find: <no path>`;
    }

    case "ls": {
      const path = safeString(args, "path");
      return path !== undefined ? `ls: ${path}` : `ls: <no path>`;
    }

    default:
      // Exhaustiveness guard — every BUILTIN_TOOLS member has
      // a case above, so this arm is unreachable. Return `null`
      // as a safe fallback.
      return null;
  }
}

/**
 * Format a compact indicator for a `tool_execution_end` event.
 * Returns `null` for machine tools and unknown tools (same
 * suppress set as `formatToolCallSummary`).
 *
 * Success (`!isError`) → `'✓'` (ignores `result` content).
 * Error (`isError`) → `'✗ <first line>'` where the error message is
 * extracted via `extractErrorMessage` (D1 extraction order: string
 * result → `message` field → `error` field → nested `error.message`
 * → `stderr` → stringified JSON/fallback), then the first line is
 * taken (substring up to the first `\n`), and finally tail-truncated
 * to `MAX_ERROR_LINE_DISPLAY_LENGTH` chars with `…` (D2).
 *
 * Note: the host handler no longer calls this function; it uses
 * `formatToolCompletedLine` instead. Retained for unit tests and
 * as a fallback.
 *
 * @param toolName - The tool name from the SDK event.
 * @param result - The `result` field (`ToolExecutionEndEvent.result`).
 *                 Typed `unknown` because the SDK types this as `any`
 *                 and can be either a string or an object in practice
 *                 (spec §1 Open concern A).
 * @param isError - Whether the tool execution ended in error.
 */
export function formatToolResultSummary(
  toolName: string,
  result: unknown,
  isError: boolean,
): string | null {
  if (MACHINE_TOOLS.has(toolName)) return null;
  if (!BUILTIN_TOOLS.has(toolName)) return null;

  if (!isError) return "✓";

  // Error path: extract the error message using the D1 extraction
  // order (string → message → error → nested error.message →
  // stderr → JSON/fallback), take the first line, and tail-truncate
  // to MAX_ERROR_LINE_DISPLAY_LENGTH (D2).
  const raw = extractErrorMessage(result);
  const newlineIdx = raw.indexOf("\n");
  const firstLine = newlineIdx === -1 ? raw : raw.slice(0, newlineIdx);
  const truncated = truncateLine(firstLine, MAX_ERROR_LINE_DISPLAY_LENGTH);

  return `✗ ${truncated}`;
}

/**
 * Build the single combined Tool-observability line emitted at
 * `tool_execution_end` (spec: tool-display-combine-status). The host
 * buffers the invocation summary (from `formatToolCallSummary` at
 * `tool_execution_start`) keyed by `toolCallId` and passes it here.
 *
 * @param summary - The buffered invocation summary (e.g. "bash: ls"),
 *                  or `undefined` when the start was suppressed (machine
 *                  tool / unknown tool / orphaned end-without-start).
 *                  `undefined` → returns `null` (no emit).
 * @param result - The end event `result` (used only for the error line).
 * @param isError - The end event `isError` flag.
 * @returns The combined line, `null` to suppress.
 */
export function formatToolCompletedLine(
  summary: string | undefined,
  result: unknown,
  isError: boolean,
): string | null {
  if (summary === undefined) return null;
  let line: string;
  if (!isError) {
    line = `✓ ${summary}`;
  } else {
    const raw = extractErrorMessage(result);
    const nl = raw.indexOf("\n");
    const first = nl === -1 ? raw : raw.slice(0, nl);
    line = first.length > 0 ? `✗ ${summary}: ${first}` : `✗ ${summary}`;
  }
  return truncateLine(line, MAX_TOOL_LINE_DISPLAY_LENGTH);
}
