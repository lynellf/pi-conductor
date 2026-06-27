/**
 * Unit tests for the markdown-continuation chunk normalizer
 * (Phase 1: quote-block continuity fix).
 *
 * Tests for the pure function `normalizeContinuationChunk` and its
 * helper `detectQuotePrefix`. Integration-level tests through the
 * full streaming event pipeline live in
 * `tests/host/display-forwarding.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  detectQuotePrefix,
  normalizeContinuationChunk,
} from "../../src/host/markdown-continuation.js";

// ─── detectQuotePrefix ──────────────────────────────────────────────

describe("detectQuotePrefix", () => {
  it("returns `> ` for a simple blockquote line", () => {
    expect(detectQuotePrefix("> hello", 0)).toBe("> ");
  });

  it("returns `> > ` for a nested blockquote", () => {
    expect(detectQuotePrefix("> > hello", 0)).toBe("> > ");
  });

  it("returns `> > > ` for deeply nested blockquote", () => {
    expect(detectQuotePrefix("> > > hello", 0)).toBe("> > > ");
  });

  it("returns `> ` when marker has no trailing space", () => {
    expect(detectQuotePrefix(">hello", 0)).toBe("> ");
  });

  it("returns null for unquoted text", () => {
    expect(detectQuotePrefix("hello world", 0)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(detectQuotePrefix("", 0)).toBeNull();
  });

  it("returns null when lineStart is past the quote marker", () => {
    // Position 5 is past the "> " prefix and into the text
    expect(detectQuotePrefix("> hello", 5)).toBeNull();
  });

  it("detects quote prefix at position after a newline", () => {
    const text = "normal text\n> quoted continuation";
    // Position 12 is the start of "> quoted continuation"
    expect(detectQuotePrefix(text, 12)).toBe("> ");
  });
});

// ─── normalizeContinuationChunk ─────────────────────────────────────

describe("normalizeContinuationChunk", () => {
  // ── Case 1: sliceStart === 0 ──────────────────────────────
  it("returns chunk unchanged when sliceStart === 0 (first chunk)", () => {
    const formatted = "> This is a thinking line";
    // slice(0, 15) = "> This is a thi" (positions 0-14)
    const result = normalizeContinuationChunk(formatted, 0, 15);
    expect(result).toBe("> This is a thi");
  });

  // ── Case 2: empty slice ───────────────────────────────────
  it("returns empty string for empty slice", () => {
    const formatted = "> some text";
    const result = normalizeContinuationChunk(formatted, 5, 5);
    expect(result).toBe("");
  });

  // ── Case 3: mid-line inside blockquote ────────────────────
  it("prepends `> ` when slice starts mid-line inside a blockquote — single line", () => {
    // Blockquoted line: "> abcdefghijklmnopqrstuvwxyz"
    // Positions: ">"=0, " "=1, "a"=2, "b"=3, ...
    // sliceStart = 5, which is inside the content after "> ab"
    // Raw slice: formatted.slice(5) = "defghijklmnopqrstuvwxyz"
    // Normalized: "> " + raw
    const formatted = "> abcdefghijklmnopqrstuvwxyz";
    const result = normalizeContinuationChunk(formatted, 5, formatted.length);
    expect(result).toBe("> defghijklmnopqrstuvwxyz");
  });

  // ── Case 4: start of new line ─────────────────────────────
  it("does NOT add prefix when sliceStart is at the start of a new line (lineStart === sliceStart)", () => {
    // Text with two lines, second is blockquoted
    // "normal line\n> quoted line"
    // Position 12 is the start of "> quoted line"
    const formatted = "normal line\n> quoted line";
    const result = normalizeContinuationChunk(formatted, 12, formatted.length);
    expect(result).toBe("> quoted line");
  });

  // ── Case 5: mid-line in unquoted text ─────────────────────
  it("does not prefix mid-line slice in unquoted text", () => {
    const formatted = "The quick brown fox jumps";
    // Positions: "T"=0, "h"=1, "e"=2, " "=3, "q"=4, "u"=5, ...
    // Position 16 is "f" in "fox"
    // slice(4, 17) = "quick brown f"
    const result = normalizeContinuationChunk(formatted, 4, 17);
    expect(result).toBe("quick brown f");
  });

  // ── Case 6: nested quote prefix depth ─────────────────────
  it("preserves nested quote prefix depth", () => {
    const formatted = "> > deeply nested thinking";
    // Positions: ">"=0, " "=1, ">"=2, " "=3, "d"=4, "e"=5, "e"=6, "p"=7, ...
    // "deeply" = d(4) e(5) e(6) p(7) l(8) y(9)
    // sliceStart = 7, which is "p" in "deeply"
    // Raw: formatted.slice(7) = "ply nested thinking"
    // Normalized: "> > ply nested thinking"
    const result = normalizeContinuationChunk(formatted, 7, formatted.length);
    expect(result).toBe("> > ply nested thinking");
  });

  // ── Case 7: multi-line chunk ──────────────────────────────
  it("prefixes only the first line in a multi-line chunk starting mid-line in a blockquote", () => {
    // Two blockquoted lines.
    const formatted = "> first line of thinking\n> second line of thinking";
    // Positions in first line: ">"=0, " "=1, "f"=2, "i"=3, "r"=4, "s"=5,
    // "t"=6, " "=7, "l"=8, "i"=9, "n"=10, "e"=11, " "=12, "o"=13, "f"=14,
    // " "=15, "t"=16, "h"=17, "i"=18, "n"=19, "k"=20, "i"=21, "n"=22, "g"=23,
    // "\n"=24, ">"=25, ...
    // sliceStart = 6, pointing at "t" in "first"
    // Raw slot: "t line of thinking\n> second line of thinking"
    // Normalized: "> t line of thinking\n> second line of thinking"
    const result = normalizeContinuationChunk(formatted, 6, formatted.length);
    expect(result).toBe("> t line of thinking\n> second line of thinking");
  });

  // ── Case 8: unquoted first line, quoted second line ───────
  it("does not prefix when the current logical line is not a blockquote", () => {
    // Mixed text: first line is normal text, second is quoted
    const formatted = "normal line a bcde\n> quoted text";
    // Position of "a" in "normal line a bcde": "n"=0, "o"=1, "r"=2,
    // "m"=3, "a"=4, "l"=5, ... Actually let me just trace precisely:
    // n(0) o(1) r(2) m(3) a(4) l(5) _(6) l(7) i(8) n(9) e(10) _(11)
    // a(12) _(13) b(14) c(15) d(16) e(17)
    // sliceStart = 12 (the "a" in "a bcde")
    // lineStart = 0, detectQuotePrefix returns null for "normal line a bcde"
    // Result should be unchanged: formatted.slice(12, 18) = "a bcde"
    const result = normalizeContinuationChunk(formatted, 12, 18);
    expect(result).toBe("a bcde");
  });

  // ── Case 9: slice ends at text boundary ───────────────────
  it("handles slice that ends at formatted text boundary", () => {
    const formatted = "> abcdefghij";
    // Positions: ">"=0, " "=1, "a"=2, "b"=3, "c"=4, ...
    // sliceStart = 3 (the "b" in "bcdefghij")
    // Raw: formatted.slice(3) = "bcdefghij"
    // Normalized: "> " + raw = "> bcdefghij"
    const result = normalizeContinuationChunk(formatted, 3, formatted.length);
    expect(result).toBe("> bcdefghij");
  });

  // ── Case 10: text-only (no thinking) ──────────────────────
  it("does not prefix mid-line slices in text-only messages (no thinking)", () => {
    const formatted = "Hello world this is a long assistant";
    // H=0, e=1, l=2, l=3, o=4, =5, w=6, o=7, r=8, l=9, d=10, =11,
    // t=12, h=13, i=14, s=15, =16, i=17, s=18, =19, a=20, =21, l=22,
    // o=23, n=24, g=25, =26, a=27, s=28, s=29, i=30, s=31, t=32, ...
    // sliceStart = 20 (the "a" in "a long")
    // lineStart = 0, detectQuotePrefix returns null
    const result = normalizeContinuationChunk(formatted, 20, 33);
    expect(result).toBe("a long assist");
  });

  // ── Case 11: `>` without trailing space ───────────────────
  it("preserves exact quote prefix when line has `>` without trailing space", () => {
    const formatted = ">line without space after marker";
    // Position 1 is 'l' (after ">" at position 0)
    // detectQuotePrefix sees ">l", returns "> " (ensures trailing space)
    const result = normalizeContinuationChunk(formatted, 1, formatted.length);
    expect(result).toBe("> line without space after marker");
  });
});
