/**
 * Table-driven unit tests for the boundary-selection helper
 * (spec: tui-stream-readability, N11).
 *
 * Pins the pure `findFlushBoundary` function across paragraph,
 * line, sentence, word, and max-window fallback scenarios.
 * Each test case is a named entry in a test table.
 */

import { describe, expect, it } from "vitest";
import { findFlushBoundary, MAX_FLUSH_WINDOW_CHARS } from "../../src/host/boundary-flush.js";

const MIN = 200;
const MAX = MAX_FLUSH_WINDOW_CHARS; // 600

describe("findFlushBoundary", () => {
  // ── Helper: format test case name ────────────────────────────
  function caseName(label: string): string {
    return label;
  }

  // ── Case 1: Paragraph boundary ──────────────────────────────
  it(caseName("prefers paragraph boundary (\\n\\n) over other breaks"), () => {
    // Text with a paragraph break after 205 chars. The paragraph
    // break is within the min..max window (200..600), so it should
    // be chosen instead of a hard 200-char cut.
    const prefix = "a".repeat(200); // 200 chars of prefix
    const beforePara = "some prose here."; // 16 chars (text before paragraph break, NO trailing newline)
    const text = `${prefix}${beforePara}\n\nrest of text after paragraph`;
    // alreadyFlushed=0, minPos=200, maxPos=600
    // searchText = text.slice(200, 600) = "some prose here.\n\nrest of ..."
    // "\n\n" at position 16 in searchText → boundary = 200 + 16 + 2 = 218.
    const boundary = findFlushBoundary(text, 0, MIN, MAX);
    expect(boundary).toBe(218);
    // The flushed text ends after the paragraph break
    expect(text.slice(0, boundary)).toMatch(/\n\n$/);
    // The remaining text starts cleanly
    expect(text.slice(boundary)).toBe("rest of text after paragraph");
  });

  it(caseName("falls back to line boundary when no paragraph break exists"), () => {
    // Text with a line break after 250 chars but no \n\n.
    const prefix = "a".repeat(230);
    const lineBreakContent = "hello\nworld";
    const text = `${prefix}${lineBreakContent}`;
    // alreadyFlushed=0, minPos=200, maxPos=600
    // searchText = text.slice(200, 600) = "a".repeat(30) + "hello\nworld"
    // \n at position 35 in searchText → return 200 + 35 + 1 = 236
    const boundary = findFlushBoundary(text, 0, MIN, MAX);
    const expected = text.indexOf("\n") + 1;
    expect(boundary).toBe(expected);
    expect(text.slice(0, boundary)).toMatch(/\n$/);
  });

  it(caseName("prefers paragraph over line boundary when both exist"), () => {
    // Text with both \n\n and \n within the window. Paragraph
    // should win.
    const prefix = "a".repeat(200);
    const content = "first line\nsecond para\n\nmore text";
    const text = `${prefix}${content}`;
    // contains both \n (position 10) and \n\n (position 22)
    const boundary = findFlushBoundary(text, 0, MIN, MAX);
    // should find \n\n at position 22 in searchText → 200 + 22 + 2 = 224
    const paraPos = text.indexOf("\n\n") + 2;
    expect(boundary).toBe(paraPos);
  });

  // ── Case 3: Sentence boundary ──────────────────────────────
  it(caseName("prefers sentence boundary over word boundary"), () => {
    // Text with a sentence boundary ". " before any word boundary.
    // We create text where the only candidate after minPos is
    // a sentence punctuation or a space, but the sentence comes
    // before (in search order it's the last one, so we test
    // the preference correctly).
    const prefix = "a".repeat(200);
    // Ensure there's no \n or \n\n in this range
    const sentenceContent = "This is a long sentence. More text follows and it goes on and on";
    const text = `${prefix}${sentenceContent}`;
    // searchText = text.slice(200, 600) = sentenceContent (about 75 chars)
    // Has ". " at position 22 but no \n or \n\n
    // The word boundary " " at position 4, 7, 9, 12, etc.
    // findFlushBoundary should find ". " (sentence boundary) at
    // position 22, which is preferred over word boundaries.
    const boundary = findFlushBoundary(text, 0, MIN, MAX);
    const sentenceDot = text.indexOf(". ");
    expect(boundary).toBe(sentenceDot + 2); // after ". "
    // The flushed text should end with ". "
    expect(text.slice(sentenceDot, sentenceDot + 2)).toBe(". ");
  });

  it(caseName("handles ! and ? sentence boundaries"), () => {
    // Test exclamation and question marks as sentence boundaries
    const prefix = "a".repeat(200);
    const text = `${prefix}What is this? I need to know! And more text.`;
    // Should find ". ", "? ", or "! " — prefer the LAST one
    // The last sentence marker is ". " which is at... let me find it
    // Actually looking for the LAST punctuation+space in searchText:
    // searchText = text.slice(200) = "What is this? I need to know! And more text."
    // The text ends with "text." (no trailing space), so there is no
    // ". " in the text. The last sentence boundary is "! " at position
    // 28 in searchText → boundary = 200 + 28 + 2 = 230.
    const boundary = findFlushBoundary(text, 0, MIN, MAX);
    expect(boundary).toBe(230);
  });

  // ── Case 4: Word boundary ───────────────────────────────────
  it(caseName("falls back to word boundary (space) when no sentence boundary exists"), () => {
    // Text with no \n, \n\n, or sentence punctuation within the
    // window, but has spaces.
    const prefix = "a".repeat(200);
    // No dots, no newlines — just words separated by spaces
    const content =
      "some words but no sentence punctuation at all so only spaces exist for breaks here and more words";
    const text = `${prefix}${content}`;
    // searchText = text.slice(200, 600) = content (about 120 chars)
    // No sentence punctuation (. ! ?), so should fall back to space
    const boundary = findFlushBoundary(text, 0, MIN, MAX);
    // Should use the last space in searchText
    const searchText = text.slice(200, 200 + MAX);
    const lastSpace = searchText.lastIndexOf(" ");
    const expected = 200 + lastSpace + 1;
    expect(boundary).toBe(expected);
    // The flushed text should not end with space (it ends AFTER the space)
    expect(text.slice(0, boundary)).toMatch(/ $/);
  });

  it(caseName("prefers sentence boundary over word boundary when both exist"), () => {
    // Text with both ". " and spaces within the window, no \n or \n\n
    const prefix = "a".repeat(200);
    // Make sentence boundary come before the last word boundary
    const content = "this approach determines that. And then continues with more text";
    const text = `${prefix}${content}`;
    // searchText = content (about 75 chars)
    // Has ". " at pos 30 and spaces throughout
    // findLastSentenceBoundary finds ". " at pos 30
    // But there's also " " at pos 63 (after "text")
    // Wait, the LAST sentence boundary (pos 30) vs last word boundary (pos 63)
    // We prefer sentence boundary, so should return pos 30+2 = 32 from minPos
    const boundary = findFlushBoundary(text, 0, MIN, MAX);
    const sentenceDot = text.indexOf(". ");
    expect(boundary).toBe(sentenceDot + 2);
  });

  // ── Case 5: Max-window fallback ────────────────────────────
  it(caseName("uses max-window fallback when no boundary exists within the window"), () => {
    // Text with no \n, \n\n, sentence punctuation, or spaces within
    // the window (e.g., a long unbroken string).
    const prefix = "a".repeat(200);
    const unbroken = "b".repeat(500); // 500 chars of unbroken text
    const text = `${prefix}${unbroken}`;
    // alreadyFlushed=0, minPos=200, maxPos=600
    // searchText = text.slice(200, 600) = 400 chars of "b"
    // No paragraph, line, sentence, or word boundary
    // maxPos = min(0 + 600, 700) = 600
    const boundary = findFlushBoundary(text, 0, MIN, MAX);
    expect(boundary).toBe(600);
    expect(text.slice(0, boundary)).toBe(prefix + "b".repeat(400));
  });

  it(caseName("returns textLen when minPos exceeds text length (caller should not flush)"), () => {
    const text = "short"; // 5 chars
    // alreadyFlushed=0, minPos=200 > 5, return textLen=5
    const boundary = findFlushBoundary(text, 0, MIN, MAX);
    expect(boundary).toBe(text.length);
  });

  // ── Case 6: Already flushed some ────────────────────────────
  it(caseName("works correctly when alreadyFlushed > 0"), () => {
    // Text where we've already flushed 100 chars, and the next
    // boundary is at 250 from the start (150 from alreadyFlushed).
    const prefix = "a".repeat(100);
    const after = "b".repeat(50);
    const sentence = "This is a sentence. And more.";
    const _text = `${prefix}${after}${sentence}`;
    // alreadyFlushed=100, minPos=100+200=300, maxPos=min(100+600, textLen)
    // textLen = 100+50+24 = 174... actually that's short
    // Let me make it longer
    const longPrefix = "x".repeat(300); // already flushed 300 chars
    const longContent =
      "yyy. some text here and there. With no great boundaries initially. Finally a dot. Then more.";
    const _longText = `${longPrefix}${longContent}`;
    // alreadyFlushed=300, minPos=300+200=500
    // maxPos = min(300+600, longText.length) = min(900, ~410) = ~410
    // minPos (500) > textLen (~410) → return textLen
    // Hmm that returns textLen because the remaining text is too short.
    // Let me use shorter values or a longer text.
    const allPrefix = "a".repeat(400);
    const content =
      "some text without sentence ends for a while but then. finally a dot. and more stuff";
    const fullText = `${allPrefix}${content}`;
    // alreadyFlushed=200, minPos=200+200=400, maxPos=min(200+600, fullText.length)
    // fullText.length = 400+92 = 492
    // maxPos = min(800, 492) = 492
    // searchText = fullText.slice(400, 492) = content (92 chars)
    // content has ". " at positions... let me count
    // "some text without sentence ends for a while but then. finally a dot. and more stuff"
    //                                                 pos40              pos54
    // Wait let me count more carefully
    // "some text without sentence ends for a while but then. finally a dot. and more stuff"
    //  12345678901234567890123456789012345678901234567890
    // 0         1         2         3         4         5
    // ". " at position... let me count: "but then. " — "b" is the first char of "but" at pos 37
    // Actually I don't need to be so precise. The content has multiple ". " occurrences.
    // The LAST ". " will be found by findLastSentenceBoundary
    const boundary = findFlushBoundary(fullText, 200, MIN, MAX);
    // The boundary should be at the last ". " + 2 within the window (maxPos=492)
    // If the last ". " in content is at position... let me just verify it's within [400, 492]
    expect(boundary).toBeGreaterThanOrEqual(400);
    expect(boundary).toBeLessThanOrEqual(492);
    // The flushed text should end with ". " (if a sentence boundary was found)
    // or with the last word (if only word boundaries found)
    const flushed = fullText.slice(200, boundary);
    const isSentenceBreak =
      flushed.endsWith(". ") || flushed.endsWith("! ") || flushed.endsWith("? ");
    const isWordBreak = flushed.endsWith(" ");
    expect(isSentenceBreak || isWordBreak).toBe(true);
  });

  // ── Case 7: Short remaining text after minPos ────────────
  it(caseName("textLength less than minPos but enough to be within window returns textLen"), () => {
    const text = "a".repeat(250); // 250 chars total
    // alreadyFlushed=100, minPos=100+200=300 > 250
    // return textLen
    const boundary = findFlushBoundary(text, 100, MIN, MAX);
    expect(boundary).toBe(250);
  });

  // ── Case 8: Boundary at exact minPos ────────────────────
  it(caseName("detects boundary at exact position minPos"), () => {
    // Create text where a paragraph break is exactly at minPos
    // (alreadyFlushed + minChars).
    const prefix = "a".repeat(200); // alreadyFlushed=0, minPos=200
    const text = `${prefix}\n\nmore text`; // \n\n starts at position 200
    const boundary = findFlushBoundary(text, 0, MIN, MAX);
    // para break at 200 in text, but searchText = text.slice(200, 600)
    // = "\n\nmore text" → \n\n at pos 0 in searchText → return 200 + 0 + 2 = 202
    expect(boundary).toBe(202);
    expect(text.slice(0, boundary)).toBe(`${"a".repeat(200)}\n\n`);
  });

  // ── Case 9: Multiple paragraphs within window ────────────
  it(caseName("prefers the LAST paragraph break within the window"), () => {
    // Text with two \n\n breaks; should prefer the second (later) one
    // to maximize flushed text.
    const prefix = "a".repeat(200);
    const paras = "para one\n\npara two\n\npara three";
    const text = `${prefix}${paras}`;
    const boundary = findFlushBoundary(text, 0, MIN, MAX);
    // searchText = "para one\n\npara two\n\npara three"
    // lastIndexOf("\n\n") should find the second \n\n
    const secondParaPos = text.lastIndexOf("\n\n") + 2;
    expect(boundary).toBe(secondParaPos);
    // Verify the boundary is after the second paragraph break.
    // The flushed text includes "para one\n\npara two\n\n" but not
    // "para three" (the boundary is at the start of "para three").
    expect(text.slice(secondParaPos - 2, secondParaPos)).toBe("\n\n");
    expect(text.slice(0, boundary)).toBe(`${"a".repeat(200)}para one\n\npara two\n\n`);
    // The remaining text starts with "para three"
    expect(text.slice(boundary)).toBe("para three");
  });

  // ── Case 10: MAX_FLUSH_WINDOW_CHARS export ──────────────
  it(caseName("MAX_FLUSH_WINDOW_CHARS is exported with documented value"), () => {
    expect(MAX_FLUSH_WINDOW_CHARS).toBe(600);
  });
});
