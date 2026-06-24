/**
 * Table-driven tests for `src/host/tool-summary.ts` — the pure
 * tool-call and tool-result formatters (spec §1).
 *
 * Coverage:
 *   - `formatToolCallSummary`: every known built-in tool with
 *     and without optional fields; machine tools → `null`;
 *     unknown tools → `null`; long-bash truncation (N1).
 *   - `formatToolResultSummary`: success → `'✓'` (ignores
 *     result content); error → `'✗ <first line>'` with both
 *     string and object results; machine tools + unknown → `null`.
 *   - `formatToolCompletedLine`: combined line emitted at end;
 *     success → `'✓ <summary>'`; error → `'✗ <summary>: <error first line>'`;
 *     `undefined` summary → `null`; truncation at 100 chars.
 */

import { describe, expect, it } from "vitest";

import {
  formatToolCallSummary,
  formatToolCompletedLine,
  formatToolResultSummary,
  MAX_BASH_COMMAND_DISPLAY_LENGTH,
  MAX_ERROR_LINE_DISPLAY_LENGTH,
  MAX_TOOL_LINE_DISPLAY_LENGTH,
} from "../../src/host/tool-summary.js";

// ─── formatToolCallSummary ──────────────────────────────────────────

describe("formatToolCallSummary", () => {
  it("formats read with path only", () => {
    expect(formatToolCallSummary("read", { path: "src/index.ts" })).toBe("read: src/index.ts");
  });

  it("formats read with path, offset, and limit", () => {
    expect(formatToolCallSummary("read", { path: "src/host/loop.ts", offset: 10, limit: 40 })).toBe(
      "read: src/host/loop.ts:10-50",
    );
  });

  it("formats read with path and offset but no limit", () => {
    expect(formatToolCallSummary("read", { path: "src/main.ts", offset: 5 })).toBe(
      "read: src/main.ts",
    );
  });

  it("formats bash with a short command", () => {
    expect(formatToolCallSummary("bash", { command: "ls" })).toBe("bash: ls");
  });

  it("formats bash with a command at exactly MAX length (no truncation)", () => {
    // Build a command of exactly MAX chars. The boundary rule is
    // `>` — commands ≤ MAX render verbatim.
    const cmd = "x".repeat(MAX_BASH_COMMAND_DISPLAY_LENGTH);
    expect(formatToolCallSummary("bash", { command: cmd })).toBe(`bash: ${cmd}`);
  });

  it("formats bash with a command exceeding MAX (truncated with ellipsis)", () => {
    // Build a command of MAX+1 chars. Truncation: slice to
    // MAX - 1 (59) chars + '…' (U+2026) = 60 chars total.
    const cmd = "x".repeat(MAX_BASH_COMMAND_DISPLAY_LENGTH + 1);
    const expected = `bash: ${cmd.slice(0, MAX_BASH_COMMAND_DISPLAY_LENGTH - 1)}…`;
    expect(formatToolCallSummary("bash", { command: cmd })).toBe(expected);
    // Assert total length of the line after "bash: " is 60
    const line = formatToolCallSummary("bash", { command: cmd });
    expect(line).not.toBeNull();
    // Use non-nullable local after the null assertion (type guard).
    expect((line as string).length - "bash: ".length).toBe(MAX_BASH_COMMAND_DISPLAY_LENGTH);
  });

  it("formats edit with path and edits array", () => {
    expect(
      formatToolCallSummary("edit", {
        path: "src/core/types.ts",
        edits: [{ oldText: "foo", newText: "bar" }],
      }),
    ).toBe("edit: src/core/types.ts (1 edits)");
  });

  it("formats edit with path and multiple edits", () => {
    expect(
      formatToolCallSummary("edit", {
        path: "src/core/types.ts",
        edits: [
          { oldText: "a", newText: "b" },
          { oldText: "c", newText: "d" },
        ],
      }),
    ).toBe("edit: src/core/types.ts (2 edits)");
  });

  it("formats edit with path and empty edits array", () => {
    expect(formatToolCallSummary("edit", { path: "src/main.ts", edits: [] })).toBe(
      "edit: src/main.ts",
    );
  });

  it("formats edit with path and no edits field", () => {
    expect(formatToolCallSummary("edit", { path: "src/main.ts" })).toBe("edit: src/main.ts");
  });

  it("formats write with path", () => {
    expect(formatToolCallSummary("write", { path: "src/new.ts", content: "..." })).toBe(
      "write: src/new.ts",
    );
  });

  it("formats grep with pattern only", () => {
    expect(formatToolCallSummary("grep", { pattern: "TODO" })).toBe('grep: "TODO"');
  });

  it("formats grep with pattern and path", () => {
    expect(formatToolCallSummary("grep", { pattern: "TODO", path: "src/" })).toBe(
      'grep: "TODO" in src/',
    );
  });

  it("formats find with path", () => {
    expect(formatToolCallSummary("find", { path: "src/" })).toBe("find: src/");
  });

  it("formats ls with path", () => {
    expect(formatToolCallSummary("ls", { path: "src/" })).toBe("ls: src/");
  });

  it("returns null for handoff", () => {
    expect(formatToolCallSummary("handoff", { target_role: "worker" })).toBeNull();
  });

  it("returns null for end", () => {
    expect(formatToolCallSummary("end", { reason: "done" })).toBeNull();
  });

  it("returns null for ask_user", () => {
    expect(formatToolCallSummary("ask_user", { prompt: "continue?" })).toBeNull();
  });

  it("returns null for an unknown tool", () => {
    expect(formatToolCallSummary("unknown_tool", {})).toBeNull();
  });

  it("handles missing args gracefully (undefined args)", () => {
    // When args is undefined, the helper returns undefined for
    // every property access.
    expect(formatToolCallSummary("read", undefined)).toBe("read: <no path>");
    expect(formatToolCallSummary("bash", undefined)).toBe("bash: <no command>");
  });

  it("handles null args gracefully", () => {
    expect(formatToolCallSummary("read", null)).toBe("read: <no path>");
  });
});

// ─── formatToolResultSummary ────────────────────────────────────────

describe("formatToolResultSummary", () => {
  it("returns ✓ on success with a string result", () => {
    expect(formatToolResultSummary("bash", "output", false)).toBe("✓");
  });

  it("returns ✓ on success with an object result (ignores content)", () => {
    // Spec C2: the acceptance example passes `{ ok: true }` with
    // `isError: false` and expects `'✓'`. This proves the success
    // branch ignores `result`.
    expect(formatToolResultSummary("bash", { ok: true }, false)).toBe("✓");
  });

  it("returns ✓ on success with undefined result", () => {
    expect(formatToolResultSummary("bash", undefined, false)).toBe("✓");
  });

  it("returns ✗ <first line> on error with a single-line string result", () => {
    expect(formatToolResultSummary("bash", "command not found: foo", true)).toBe(
      "✗ command not found: foo",
    );
  });

  it("returns ✗ <first line> on error with a multi-line string result", () => {
    expect(
      formatToolResultSummary("bash", "error: permission denied\n  at Object.<anonymous>", true),
    ).toBe("✗ error: permission denied");
  });

  it("returns ✗ <extracted message> on error with an object result (D1 extraction → message field)", () => {
    // Object error with a `message` field. extractErrorMessage
    // finds `result.message` first (step 2).
    const result = { message: "command failed", code: 127 };
    expect(formatToolResultSummary("bash", result, true)).toBe("✗ command failed");
  });

  it("returns ✗ <error field> on error with an object that has an `error` string field", () => {
    // Object error with an `error` string field (step 2 fallback
    // when `message` is absent).
    const result = { error: "permission denied" };
    expect(formatToolResultSummary("bash", result, true)).toBe("✗ permission denied");
  });

  it("returns ✗ <nested error.message> on error with nested error object", () => {
    // Object with nested `error` object containing `message` (step 3).
    const result = { error: { message: "ENOENT: no such file" } };
    expect(formatToolResultSummary("bash", result, true)).toBe("✗ ENOENT: no such file");
  });

  it("returns ✗ <nested error.error> on error with nested error object (fallback within nested)", () => {
    // Nested error object has `error` but no `message`.
    const result = { error: { error: "segfault" } };
    expect(formatToolResultSummary("bash", result, true)).toBe("✗ segfault");
  });

  it("returns ✗ <stderr> on error with object that has a stderr field (no message/error)", () => {
    // Object with `stderr` but no `message` or `error` (step 4).
    const result = { stderr: "ls: cannot access 'foo': No such file or directory" };
    expect(formatToolResultSummary("bash", result, true)).toBe(
      "✗ ls: cannot access 'foo': No such file or directory",
    );
  });

  it("returns ✗ <truncated JSON> on error with object that has no recognizable error field", () => {
    // Object with no message/error/stderr fields (step 5 fallback →
    // JSON.stringify, then truncated to MAX_ERROR_LINE_DISPLAY_LENGTH).
    const result = { foo: "bar", baz: 42, nested: { deep: "value" } };
    const output = formatToolResultSummary("bash", result, true);
    expect(output).not.toBeNull();
    expect(output as string).toMatch(/^✗ \{/);
    expect((output as string).length).toBeLessThanOrEqual(
      MAX_ERROR_LINE_DISPLAY_LENGTH + 2, // ✗  + truncated line
    );
  });

  it("truncates a long single-line string error (> MAX_ERROR_LINE_DISPLAY_LENGTH)", () => {
    // String error that exceeds the max line length (D2 truncation)
    const longLine = "a".repeat(MAX_ERROR_LINE_DISPLAY_LENGTH + 10);
    const expectedLine = `${longLine.slice(0, MAX_ERROR_LINE_DISPLAY_LENGTH - 1)}…`;
    expect(formatToolResultSummary("bash", longLine, true)).toBe(`✗ ${expectedLine}`);
  });

  it("truncates a long multi-line string error (first line > MAX_ERROR_LINE_DISPLAY_LENGTH)", () => {
    // Multi-line error where the first line is longer than MAX.
    const firstLine = "x".repeat(MAX_ERROR_LINE_DISPLAY_LENGTH + 5);
    const errorText = `${firstLine}\n    at Object.<anonymous>`;
    const expectedLine = `${firstLine.slice(0, MAX_ERROR_LINE_DISPLAY_LENGTH - 1)}…`;
    expect(formatToolResultSummary("bash", errorText, true)).toBe(`✗ ${expectedLine}`);
  });

  it("does not truncate an error line of exactly MAX_ERROR_LINE_DISPLAY_LENGTH", () => {
    const line = "a".repeat(MAX_ERROR_LINE_DISPLAY_LENGTH);
    expect(formatToolResultSummary("bash", line, true)).toBe(`✗ ${line}`);
  });

  it("truncates an error line of MAX_ERROR_LINE_DISPLAY_LENGTH + 1", () => {
    const line = "a".repeat(MAX_ERROR_LINE_DISPLAY_LENGTH + 1);
    const expectedLine = `${line.slice(0, MAX_ERROR_LINE_DISPLAY_LENGTH - 1)}…`;
    expect(formatToolResultSummary("bash", line, true)).toBe(`✗ ${expectedLine}`);
  });

  it("returns null for handoff on success", () => {
    expect(formatToolResultSummary("handoff", { ok: true }, false)).toBeNull();
  });

  it("returns null for handoff on error", () => {
    expect(formatToolResultSummary("handoff", { error: "fail" }, true)).toBeNull();
  });

  it("returns null for end on success", () => {
    expect(formatToolResultSummary("end", { reason: "done" }, false)).toBeNull();
  });

  it("returns null for end on error", () => {
    expect(formatToolResultSummary("end", "something went wrong", true)).toBeNull();
  });

  it("returns null for ask_user", () => {
    expect(formatToolResultSummary("ask_user", "response", false)).toBeNull();
  });

  it("returns null for unknown tool", () => {
    expect(formatToolResultSummary("unknown_tool", {}, false)).toBeNull();
  });
});

// ─── formatToolCompletedLine ────────────────────────────────────────

describe("formatToolCompletedLine", () => {
  it("returns ✓ bash: ls on success", () => {
    expect(formatToolCompletedLine("bash: ls", { ok: true }, false)).toBe("✓ bash: ls");
  });

  it("ignores result content on success", () => {
    expect(formatToolCompletedLine("bash: ls", "some output", false)).toBe("✓ bash: ls");
  });

  it("returns ✗ bash: ls: command not found: foo on error with single-line string result", () => {
    expect(formatToolCompletedLine("bash: ls", "command not found: foo", true)).toBe(
      "✗ bash: ls: command not found: foo",
    );
  });

  it("takes first line on error with multi-line string result", () => {
    expect(formatToolCompletedLine("bash: ls", "permission denied\n  at script.sh:3", true)).toBe(
      "✗ bash: ls: permission denied",
    );
  });

  it("extracts error.message from object result (D1 step 2)", () => {
    expect(
      formatToolCompletedLine("bash: ls", { message: "command failed", code: 127 }, true),
    ).toBe("✗ bash: ls: command failed");
  });

  it("extracts nested error.message from object result (D1 step 3)", () => {
    expect(formatToolCompletedLine("bash: ls", { error: { message: "ENOENT" } }, true)).toBe(
      "✗ bash: ls: ENOENT",
    );
  });

  it("extracts stderr from object result (D1 step 4)", () => {
    expect(
      formatToolCompletedLine(
        "bash: ls",
        { stderr: "ls: cannot access 'foo': No such file or directory" },
        true,
      ),
    ).toBe("✗ bash: ls: ls: cannot access 'foo': No such file or directory");
  });

  it("returns ✗ bash: ls with no error line when error is empty string", () => {
    expect(formatToolCompletedLine("bash: ls", "", true)).toBe("✗ bash: ls");
  });

  it("returns ✗ bash: ls: {} when error is an empty object (JSON fallback)", () => {
    // extractErrorMessage({}) returns "{}" (step 5 JSON.stringify),
    // which is non-empty -> produces "✗ bash: ls: {}".
    expect(formatToolCompletedLine("bash: ls", {}, true)).toBe("✗ bash: ls: {}");
  });

  it("returns null for undefined summary (orphaned end / suppressed-start end)", () => {
    expect(formatToolCompletedLine(undefined, { ok: true }, false)).toBeNull();
  });

  it("returns null for null summary (mapped from undefined)", () => {
    expect(formatToolCompletedLine(undefined, "error", true)).toBeNull();
  });

  it("renders line of exactly MAX_TOOL_LINE_DISPLAY_LENGTH verbatim", () => {
    const summary = "x".repeat(MAX_TOOL_LINE_DISPLAY_LENGTH - 2); // "✓ " + summary = 100
    expect(formatToolCompletedLine(summary, "", false)).toBe(`✓ ${summary}`);
  });

  it("truncates line exceeding MAX_TOOL_LINE_DISPLAY_LENGTH with ellipsis", () => {
    // Line length = "✓ " (2) + summary, where summary is 100 chars
    // Total = 102 > 100 → truncate to 99 + …
    const summary = "y".repeat(MAX_TOOL_LINE_DISPLAY_LENGTH);
    const expected = `✓ ${summary.slice(0, MAX_TOOL_LINE_DISPLAY_LENGTH - 1 - 2)}…`;
    expect(formatToolCompletedLine(summary, "", false)).toBe(expected);
  });

  it("truncates error line exceeding MAX_TOOL_LINE_DISPLAY_LENGTH with ellipsis", () => {
    // "✗ bash: ls: " + long error = well over 100
    const longError = "e".repeat(MAX_TOOL_LINE_DISPLAY_LENGTH + 10);
    const result = formatToolCompletedLine("bash: ls", longError, true);
    expect(result).not.toBeNull();
    expect((result as string).length).toBe(MAX_TOOL_LINE_DISPLAY_LENGTH);
    expect(result as string).toMatch(/^✗ bash: ls: e+…$/);
  });
});
