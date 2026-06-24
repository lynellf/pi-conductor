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
 */

import { describe, expect, it } from "vitest";

import {
  formatToolCallSummary,
  formatToolResultSummary,
  MAX_BASH_COMMAND_DISPLAY_LENGTH,
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

  it("returns ✗ <first line> on error with an object result (coercion path)", () => {
    // Open concern A: object result is stringified, then first-lined.
    const result = { message: "command failed", code: 127 };
    const line = formatToolResultSummary("bash", result, true);
    expect(line).not.toBeNull();
    expect(line as string).toMatch(/^✗ /);
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
