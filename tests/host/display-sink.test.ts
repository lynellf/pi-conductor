/**
 * Phase 1 (open-issues-round-3, issue #12) — unit tests for
 * `extractFileMutations` in `src/host/display-sink.ts`.
 *
 * Pure function tests: exercises the helper in isolation without
 * driving the full `attachSessionEventHandler` pipeline. Mirrors the
 * table-driven style of `tests/host/tool-summary.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { extractFileMutations, type TouchedFile } from "../../src/host/display-sink.js";

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
