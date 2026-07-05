/**
 * Phase 1 (open-issues-round-3, issue #12) — unit tests for
 * `extractFileMutations` in `src/host/display-sink.ts`.
 *
 * Pure function tests: exercises the helper in isolation without
 * driving the full `attachSessionEventHandler` pipeline. Mirrors the
 * table-driven style of `tests/host/tool-summary.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  extractFileHunks,
  extractFileMutations,
  type HunkLine,
  type TouchedFile,
} from "../../src/host/display-sink.js";

describe("extractFileMutations", () => {
  // ─── write ────────────────────────────────────────────────────────

  describe('"write" tool', () => {
    it("returns TouchedFile with additions for valid { path, content }", () => {
      const result = extractFileMutations("write", {
        path: "/app/config.ts",
        content: "hello world",
      });
      expect(result).toHaveLength(1);
      expect(result?.[0]).toMatchObject({
        path: "/app/config.ts",
        additions: 11,
        deletions: 0,
      });
    });

    it("returns TouchedFile with additions: 0 for empty content", () => {
      const result = extractFileMutations("write", { path: "/app/empty.txt", content: "" });
      expect(result).toHaveLength(1);
      expect(result?.[0]).toMatchObject({ path: "/app/empty.txt", additions: 0, deletions: 0 });
    });

    it("returns empty array when path is missing", () => {
      const result = extractFileMutations("write", { content: "data" });
      expect(result).toEqual([]);
    });

    it("returns empty array when path is not a string", () => {
      const result = extractFileMutations("write", { path: 42, content: "data" });
      expect(result).toEqual([]);
    });

    it("returns empty array when content is not a string", () => {
      const result = extractFileMutations("write", {
        path: "/app/data.json",
        content: { raw: true },
      });
      expect(result).toEqual([]);
    });

    it("defensive: non-object args returns empty array", () => {
      expect(extractFileMutations("write", null)).toEqual([]);
      expect(extractFileMutations("write", "just a string")).toEqual([]);
      expect(extractFileMutations("write", 42)).toEqual([]);
      expect(extractFileMutations("write", undefined)).toEqual([]);
    });
  });

  // ─── edit ─────────────────────────────────────────────────────────

  describe('"edit" tool', () => {
    it("returns TouchedFile with correct additions/deletions for single edit", () => {
      const result = extractFileMutations("edit", {
        path: "/app/main.ts",
        edits: [{ oldText: "foo", newText: "bar" }],
      });
      expect(result).toHaveLength(1);
      expect(result?.[0]).toMatchObject({
        path: "/app/main.ts",
        additions: 3,
        deletions: 3,
      });
    });

    it("returns TouchedFile with summed additions/deletions for multiple edits", () => {
      const result = extractFileMutations("edit", {
        path: "/app/main.ts",
        edits: [
          { oldText: "aaa", newText: "bbbbb" },
          { oldText: "cc", newText: "d" },
        ],
      });
      expect(result).toHaveLength(1);
      expect(result?.[0]).toMatchObject({
        path: "/app/main.ts",
        additions: 6, // 5 + 1
        deletions: 5, // 3 + 2
      });
    });

    it("skips edits that are not objects", () => {
      const result = extractFileMutations("edit", {
        path: "/app/main.ts",
        edits: [{ oldText: "foo", newText: "bar" }, "not an object", null],
      });
      expect(result).toHaveLength(1);
      expect(result?.[0]).toMatchObject({
        path: "/app/main.ts",
        additions: 3,
        deletions: 3,
      });
    });

    it("returns empty array when path is missing", () => {
      const result = extractFileMutations("edit", {
        edits: [{ oldText: "a", newText: "b" }],
      });
      expect(result).toEqual([]);
    });

    it("returns empty array when edits is missing", () => {
      const result = extractFileMutations("edit", { path: "/app/main.ts" });
      expect(result).toEqual([]);
    });

    it("returns empty array when edits is not an array", () => {
      const result = extractFileMutations("edit", { path: "/app/main.ts", edits: "not array" });
      expect(result).toEqual([]);
    });

    it("returns empty array when edits is an empty array", () => {
      const result = extractFileMutations("edit", { path: "/app/main.ts", edits: [] });
      expect(result).toEqual([]);
    });

    it("defensive: non-object args returns empty array", () => {
      expect(extractFileMutations("edit", null)).toEqual([]);
      expect(extractFileMutations("edit", [])).toEqual([]);
      expect(extractFileMutations("edit", 42)).toEqual([]);
      expect(extractFileMutations("edit", undefined)).toEqual([]);
    });
  });

  // ─── read-only tools ───────────────────────────────────────────────

  describe("read-only tools", () => {
    it('"read" returns undefined', () => {
      expect(extractFileMutations("read", { path: "/app/main.ts" })).toBeUndefined();
    });
    it('"grep" returns undefined', () => {
      expect(extractFileMutations("grep", { pattern: "TODO", path: "/app" })).toBeUndefined();
    });
    it('"find" returns undefined', () => {
      expect(extractFileMutations("find", { path: "/app" })).toBeUndefined();
    });
    it('"ls" returns undefined', () => {
      expect(extractFileMutations("ls", { path: "/app" })).toBeUndefined();
    });
  });

  // ─── machine tools ─────────────────────────────────────────────────

  describe("machine tools", () => {
    it('"handoff" returns undefined', () => {
      expect(extractFileMutations("handoff", { target_role: "worker" })).toBeUndefined();
    });
    it('"end" returns undefined', () => {
      expect(extractFileMutations("end", { reason: "done" })).toBeUndefined();
    });
    it('"ask_user" returns undefined', () => {
      expect(extractFileMutations("ask_user", { kind: "input" })).toBeUndefined();
    });
  });

  // ─── unknown tools ─────────────────────────────────────────────────

  describe("unknown / other tools", () => {
    it('"bash" returns undefined', () => {
      expect(extractFileMutations("bash", { command: "rm -rf /" })).toBeUndefined();
    });
    it('"unknown_tool" returns undefined', () => {
      expect(extractFileMutations("unknown_tool", { any: "args" })).toBeUndefined();
    });
    it('"" (empty string) returns undefined', () => {
      expect(extractFileMutations("", {})).toBeUndefined();
    });
  });

  // ─── TouchedFile shape ────────────────────────────────────────────

  it("returned TouchedFile has the expected readonly shape", () => {
    const result = extractFileMutations("write", { path: "/app/test.ts", content: "abc" });
    expect(result).toHaveLength(1);
    const file = result?.[0] as TouchedFile;
    // Structural check: readonly fields are accessible at runtime
    expect(file.path).toBe("/app/test.ts");
    expect(file.additions).toBe(3);
    expect(file.deletions).toBe(0);
  });
});

// ─── Issue #13: extractFileHunks ──────────────────────────────────────

describe("extractFileHunks", () => {
  // ─── edit ──────────────────────────────────────────────────────────

  describe('"edit" tool', () => {
    it("returns del + add lines for single edit", () => {
      const result = extractFileHunks("edit", {
        path: "/app/main.ts",
        edits: [{ oldText: "foo", newText: "bar" }],
      });
      expect(result).toBeDefined();
      expect(result?.length).toBe(2);
      // del line first, then add line; sequential line numbers start at 1
      expect(result?.[0]).toMatchObject({ lineNumber: 1, content: "-foo", kind: "del" });
      expect(result?.[1]).toMatchObject({ lineNumber: 1, content: "+bar", kind: "add" });
    });

    it("returns all del + add lines for multiple edits in order", () => {
      const result = extractFileHunks("edit", {
        path: "/app/main.ts",
        edits: [
          { oldText: "aaa", newText: "bbbbb" },
          { oldText: "cc", newText: "d" },
        ],
      });
      expect(result).toBeDefined();
      // First edit: 3 del + 5 add; second edit: 2 del + 1 add
      // Per-edit interleaved: for each edit, all its dels then all its adds.
      // Each edit's oldText/newText is a single-line string → 1 del + 1 add per edit.
      // Total: 2 edits × 2 hunks = 4.
      expect(result?.map((h) => h.kind)).toEqual(["del", "add", "del", "add"]);
    });

    it("sequential del line numbers across edits", () => {
      const result = extractFileHunks("edit", {
        path: "/app/main.ts",
        edits: [
          { oldText: "a", newText: "x" },
          { oldText: "b", newText: "y" },
        ],
      });
      // Per-edit sequential: each edit starts at line 1 (sequential within the edit).
      // Edit 1 (a→x): del(1), add(1). Edit 2 (b→y): del(1), add(1).
      expect(result?.[0]).toMatchObject({ lineNumber: 1, kind: "del" });
      expect(result?.[1]).toMatchObject({ lineNumber: 1, kind: "add" });
      expect(result?.[2]).toMatchObject({ lineNumber: 1, kind: "del" });
      expect(result?.[3]).toMatchObject({ lineNumber: 1, kind: "add" });
    });

    it("multi-line oldText/newText split into multiple del/add lines", () => {
      const result = extractFileHunks("edit", {
        path: "/app/main.ts",
        edits: [{ oldText: "a\nb", newText: "x\ny\nz" }],
      });
      expect(result).toHaveLength(5);
      // del lines for "a\nb" → 2 del lines (drop trailing empty)
      expect(result?.[0]).toMatchObject({ lineNumber: 1, content: "-a", kind: "del" });
      expect(result?.[1]).toMatchObject({ lineNumber: 2, content: "-b", kind: "del" });
      // add lines for "x\ny\nz" → 3 add lines
      expect(result?.[2]).toMatchObject({ lineNumber: 1, content: "+x", kind: "add" });
      expect(result?.[3]).toMatchObject({ lineNumber: 2, content: "+y", kind: "add" });
      expect(result?.[4]).toMatchObject({ lineNumber: 3, content: "+z", kind: "add" });
    });

    it("drops trailing empty element from trailing-nl split", () => {
      const result = extractFileHunks("edit", {
        path: "/app/main.ts",
        edits: [{ oldText: "foo\n", newText: "bar\n" }],
      });
      // "foo\n".split("\n") = ["foo", ""] → drop trailing "" → 1 del
      // "bar\n".split("\n") = ["bar", ""] → drop trailing "" → 1 add
      expect(result).toHaveLength(2);
    });

    it("skips non-object edits in edits array", () => {
      const result = extractFileHunks("edit", {
        path: "/app/main.ts",
        edits: [
          { oldText: "a", newText: "x" },
          "not an object",
          null,
          { oldText: "b", newText: "y" },
        ],
      });
      expect(result).toHaveLength(4); // 2 del + 2 add, not 6
    });

    it("returns hunks even when path is missing (edits are valid)", () => {
      // extractFileHunks does not validate path — edits are processed regardless.
      // The missing-path issue is in extractFileMutations (no TouchedFile), not here.
      const result = extractFileHunks("edit", {
        path: "/app/main.ts",
        edits: [{ oldText: "a", newText: "b" }],
      });
      expect(result).toHaveLength(2);
      expect(result?.[0]).toMatchObject({ lineNumber: 1, kind: "del" });
      expect(result?.[1]).toMatchObject({ lineNumber: 1, kind: "add" });
    });

    it("returns empty array when edits is missing", () => {
      expect(extractFileHunks("edit", { path: "/app/main.ts" })).toEqual([]);
    });

    it("returns empty array when edits is empty array", () => {
      expect(extractFileHunks("edit", { path: "/app/main.ts", edits: [] })).toEqual([]);
    });

    it("defensive: non-object args returns empty array", () => {
      expect(extractFileHunks("edit", null)).toEqual([]);
      expect(extractFileHunks("edit", [])).toEqual([]);
      expect(extractFileHunks("edit", 42)).toEqual([]);
      expect(extractFileHunks("edit", undefined)).toEqual([]);
    });
  });

  // ─── write ────────────────────────────────────────────────────────

  describe('"write" tool', () => {
    it("returns undefined (caller must supply previous content)", () => {
      expect(extractFileHunks("write", { path: "/app/main.ts", content: "hello" })).toBeUndefined();
    });
  });

  // ─── read-only tools ───────────────────────────────────────────────

  describe("read-only tools", () => {
    it('"read" returns undefined', () => {
      expect(extractFileHunks("read", { path: "/app/main.ts" })).toBeUndefined();
    });
    it('"grep" returns undefined', () => {
      expect(extractFileHunks("grep", { pattern: "TODO", path: "/app" })).toBeUndefined();
    });
    it('"find" returns undefined', () => {
      expect(extractFileHunks("find", { path: "/app" })).toBeUndefined();
    });
    it('"ls" returns undefined', () => {
      expect(extractFileHunks("ls", { path: "/app" })).toBeUndefined();
    });
  });

  // ─── machine tools ─────────────────────────────────────────────────

  describe("machine tools", () => {
    it('"handoff" returns undefined', () => {
      expect(extractFileHunks("handoff", { target_role: "worker" })).toBeUndefined();
    });
    it('"end" returns undefined', () => {
      expect(extractFileHunks("end", { reason: "done" })).toBeUndefined();
    });
    it('"ask_user" returns undefined', () => {
      expect(extractFileHunks("ask_user", { kind: "input" })).toBeUndefined();
    });
  });

  // ─── unknown tools ─────────────────────────────────────────────────

  describe("unknown / other tools", () => {
    it('"bash" returns undefined', () => {
      expect(extractFileHunks("bash", { command: "ls" })).toBeUndefined();
    });
    it('"unknown_tool" returns undefined', () => {
      expect(extractFileHunks("unknown_tool", {})).toBeUndefined();
    });
    it('"" (empty string) returns undefined', () => {
      expect(extractFileHunks("", {})).toBeUndefined();
    });
  });

  // ─── HunkLine shape ───────────────────────────────────────────────

  it("returned HunkLine has the expected readonly shape", () => {
    const result = extractFileHunks("edit", {
      path: "/app/main.ts",
      edits: [{ oldText: "foo", newText: "bar" }],
    });
    expect(result).toHaveLength(2);
    const hunk = result?.[0] as HunkLine;
    expect(hunk.lineNumber).toBe(1);
    expect(hunk.content).toBe("-foo");
    expect(hunk.kind).toBe("del");
  });
});
