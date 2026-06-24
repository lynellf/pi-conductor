/**
 * Tool summary formatters for the TUI tool-observability stream.
 *
 * Two pure functions — one per SDK event:
 *   - `formatToolCallSummary` — compact one-line summary of a
 *     `tool_execution_start` event (args).
 *   - `formatToolResultSummary` — compact one-line indicator
 *     of a `tool_execution_end` event (result / error).
 *
 * Both return `null` for conductor machine tools (`handoff`,
 * `end`, `ask_user`) — these are protocol noise surfaced
 * elsewhere — and for unknown tools (safer than raw JSON).
 *
 * **Location rationale** (Nit 4): sits in `src/host/` only
 * because the consumer is `session-event-handler.ts`; the
 * formatter itself has no SDK dependency. A future
 * relocation to `src/seam/` or `src/extension/` would be
 * non-breaking.
 *
 * Spec: §1, Decisions Q1/Q2, Nit 4, Nit 6.
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
 * Error (`isError`) → `'✗ <first line>'` where `firstLine` is
 * extracted from `result`:
 *   1. If `typeof result === "string"`, take the substring up to
 *      the first `\n` (or the entire string if no newline).
 *   2. Otherwise, stable-stringify via `JSON.stringify` (or
 *      `String(...)` fallback), then take the first line.
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

  // Error path: extract the first line of the error content.
  // Coerce `result` to a string first.
  const raw: string =
    typeof result === "string"
      ? result
      : (() => {
          const json = JSON.stringify(result);
          return json !== undefined ? json : String(result);
        })();

  // First line = substring up to the first `\n`.
  const newlineIdx = raw.indexOf("\n");
  const firstLine = newlineIdx === -1 ? raw : raw.slice(0, newlineIdx);

  return `✗ ${firstLine}`;
}
