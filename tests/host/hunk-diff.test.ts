/**
 * Phase 2 (open-issues-round-3, issue #13) — unit tests for
 * `parseDiffHunks`, `buildWriteHunks`, and `loadWriteHunksForArgs`
 * in `src/host/hunk-diff.ts`.
 *
 * Pure function tests (parseDiffHunks, buildWriteHunks) are
 * table-driven and require no I/O. Filesystem tests
 * (loadWriteHunksForArgs) use `mkdtemp` to create isolated temp
 * directories, matching the pattern at `tests/host/manifest.test.ts`.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildWriteHunks,
  loadWriteHunksForArgs,
  parseDiffHunks,
} from "../../src/host/hunk-diff.js";

// ─── parseDiffHunks ─────────────────────────────────────────────────

describe("parseDiffHunks", () => {
  it("returns empty array for identical old and new content", () => {
    const result = parseDiffHunks("hello\nworld", "hello\nworld");
    expect(result).toEqual([]);
  });

  it("single-new-file: all-`add` lines from empty to content", () => {
    const result = parseDiffHunks("", "foo\nbar");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ lineNumber: 1, content: "+foo", kind: "add" });
    expect(result[1]).toMatchObject({ lineNumber: 2, content: "+bar", kind: "add" });
  });

  it("full replacement: del old + add new", () => {
    const result = parseDiffHunks("foo", "bar");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ lineNumber: 1, content: "-foo", kind: "del" });
    expect(result[1]).toMatchObject({ lineNumber: 1, content: "+bar", kind: "add" });
  });

  it("insertion in middle: context + add + context", () => {
    const result = parseDiffHunks("a\nb\nc", "a\ninserted\nb\nc");
    // diffLines returns: a (context), inserted (add), b+c (context as separate lines)
    expect(result).toHaveLength(4);
    expect(result[0]).toMatchObject({ lineNumber: 1, content: "a", kind: "context" });
    expect(result[1]).toMatchObject({ lineNumber: 2, content: "+inserted", kind: "add" });
    expect(result[2]).toMatchObject({ lineNumber: 3, content: "b", kind: "context" });
    expect(result[3]).toMatchObject({ lineNumber: 4, content: "c", kind: "context" });
  });

  it("deletion in middle: context + del + context", () => {
    const result = parseDiffHunks("a\nremove\nb\nc", "a\nb\nc");
    // diffLines returns: a (context), remove (del), b+c (context as separate lines)
    // Context lines use new file positions: b is new line 2, c is new line 3
    expect(result).toHaveLength(4);
    expect(result[0]).toMatchObject({ lineNumber: 1, content: "a", kind: "context" });
    expect(result[1]).toMatchObject({ lineNumber: 2, content: "-remove", kind: "del" });
    expect(result[2]).toMatchObject({ lineNumber: 2, content: "b", kind: "context" });
    expect(result[3]).toMatchObject({ lineNumber: 3, content: "c", kind: "context" });
  });

  it("multi-line block change", () => {
    const old = "a\nold1\nold2\nb";
    const newContent = "a\nnew1\nnew2\nb";
    const result = parseDiffHunks(old, newContent);
    // diffLines returns: a (context), old1+old2 (del), new1+new2 (add), b (context)
    // Del lines use old file positions; add/context lines use new file positions
    expect(result).toHaveLength(6);
    expect(result[0]).toMatchObject({ lineNumber: 1, content: "a", kind: "context" });
    expect(result[1]).toMatchObject({ lineNumber: 2, content: "-old1", kind: "del" });
    expect(result[2]).toMatchObject({ lineNumber: 3, content: "-old2", kind: "del" });
    expect(result[3]).toMatchObject({ lineNumber: 2, content: "+new1", kind: "add" });
    expect(result[4]).toMatchObject({ lineNumber: 3, content: "+new2", kind: "add" });
    expect(result[5]).toMatchObject({ lineNumber: 4, content: "b", kind: "context" });
  });

  it("trailing newline: drops empty trailing element", () => {
    const result = parseDiffHunks("foo\n", "bar\n");
    expect(result).toHaveLength(2);
    // Both should have line 1 (no trailing empty lines)
    expect(result[0]).toMatchObject({ lineNumber: 1, content: "-foo", kind: "del" });
    expect(result[1]).toMatchObject({ lineNumber: 1, content: "+bar", kind: "add" });
  });

  it("empty old + empty new → []", () => {
    expect(parseDiffHunks("", "")).toEqual([]);
    expect(parseDiffHunks("a\n", "a\n")).toEqual([]);
  });

  it("context lines count both old and new line numbers correctly", () => {
    const result = parseDiffHunks("line1\nline2\nline3", "line1\nmodified\nline3");
    // diffLines returns: line1 (context), line2 (del), modified (add), line3 (context)
    expect(result).toHaveLength(4);
    expect(result[0]).toMatchObject({ lineNumber: 1, content: "line1", kind: "context" });
    expect(result[1]).toMatchObject({ lineNumber: 2, content: "-line2", kind: "del" });
    expect(result[2]).toMatchObject({ lineNumber: 2, content: "+modified", kind: "add" });
    expect(result[3]).toMatchObject({ lineNumber: 3, content: "line3", kind: "context" });
  });
});

// ─── buildWriteHunks ────────────────────────────────────────────────

describe("buildWriteHunks", () => {
  it("null oldContent (new file): all-`add` lines starting at line 1", () => {
    const result = buildWriteHunks(null, "first\nsecond");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ lineNumber: 1, content: "+first", kind: "add" });
    expect(result[1]).toMatchObject({ lineNumber: 2, content: "+second", kind: "add" });
  });

  it("non-null oldContent: delegates to parseDiffHunks", () => {
    const result = buildWriteHunks("old", "new");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ lineNumber: 1, content: "-old", kind: "del" });
    expect(result[1]).toMatchObject({ lineNumber: 1, content: "+new", kind: "add" });
  });

  it("empty newContent + null old (new empty file): []", () => {
    expect(buildWriteHunks(null, "")).toEqual([]);
  });

  it("empty newContent + non-empty old (delete all content): all `del` lines", () => {
    const result = buildWriteHunks("a\nb\nc", "");
    expect(result).toHaveLength(3);
    for (const hunk of result) {
      expect(hunk.kind).toBe("del");
    }
  });

  it("same old and new: []", () => {
    expect(buildWriteHunks("same\ncontent", "same\ncontent")).toEqual([]);
  });
});

// ─── loadWriteHunksForArgs ─────────────────────────────────────────

describe("loadWriteHunksForArgs", () => {
  // Use a real temp dir per test to avoid cross-test pollution
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = `${tmpdir()}/conductor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await mkdir(tmpDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true }).catch(() => {
      /* ignore cleanup errors */
    });
  });

  it("existing file with content → reads and produces hunks via buildWriteHunks", async () => {
    const filePath = `${tmpDir}/existing.txt`;
    await writeFile(filePath, "original\ncontent", "utf8");

    const result = loadWriteHunksForArgs({
      path: filePath,
      content: "new\ncontent\nhere",
    });

    expect(result).toBeDefined();
    expect(result?.length).toBeGreaterThan(0);
    // The first few lines should show the diff
    const kinds = result?.map((h) => h.kind);
    expect(kinds).toContain("del");
    expect(kinds).toContain("add");
  });

  it("non-existent file (ENOENT) → returns all-`add` hunks (new file)", () => {
    const result = loadWriteHunksForArgs({
      path: `${tmpDir}/brand-new.txt`,
      content: "brand\nnew\ncontent",
    });

    expect(result).toBeDefined();
    const hunks = result ?? [];
    expect(hunks).toHaveLength(3);
    for (const h of hunks) {
      expect(h.kind).toBe("add");
    }
  });

  it("missing path → returns undefined", () => {
    expect(loadWriteHunksForArgs({ content: "hello" })).toBeUndefined();
  });

  it("non-string path → returns undefined", () => {
    expect(loadWriteHunksForArgs({ path: 42, content: "hello" })).toBeUndefined();
    expect(loadWriteHunksForArgs({ path: null, content: "hello" })).toBeUndefined();
    expect(loadWriteHunksForArgs({ path: { raw: true }, content: "hello" })).toBeUndefined();
  });

  it("missing content → returns undefined", () => {
    expect(loadWriteHunksForArgs({ path: "/some/path" })).toBeUndefined();
  });

  it("non-string content → returns undefined", () => {
    expect(loadWriteHunksForArgs({ path: "/some/path", content: 123 })).toBeUndefined();
    expect(loadWriteHunksForArgs({ path: "/some/path", content: null })).toBeUndefined();
    expect(loadWriteHunksForArgs({ path: "/some/path", content: ["array"] })).toBeUndefined();
  });

  it("non-object args → returns undefined", () => {
    expect(loadWriteHunksForArgs(null)).toBeUndefined();
    expect(loadWriteHunksForArgs("string")).toBeUndefined();
    expect(loadWriteHunksForArgs(42)).toBeUndefined();
    expect(loadWriteHunksForArgs(undefined)).toBeUndefined();
  });
});
