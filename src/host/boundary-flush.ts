/**
 * Pure boundary-selection helper for stream-progressive TUI flush.
 *
 * When streaming assistant text, we prefer to flush at semantic
 * boundaries (paragraph → line → sentence → word) so the terminal
 * output reads naturally. A maximum-window fallback prevents the
 * stream from stalling on very long unbroken prose.
 *
 * This is a pure function: no I/O, no side effects, no module state.
 * Unit-tested in `tests/host/boundary-flush.test.ts`.
 */

/**
 * Maximum number of NEW characters we'll accumulate past the minimum
 * flush threshold before forcing a hard flush at the end of the window.
 *
 * 600 chars ~= 3× the minimum threshold (200, set in
 * `STREAM_FLUSH_THRESHOLD_CHARS`). In practice this means text is
 * delivered in 200–600 char chunks depending on boundary availability.
 * On a typical 80-char terminal that's ~3–8 lines per flush —
 * responsive enough for progressive delivery while avoiding the
 * mid-sentence fragmentation reported in the screenshot.
 *
 * The value is a tradeoff: too large → perceived lag on long
 * paragraphs; too small → defeats boundary-seeking when there are
 * few boundaries. 600 strikes a reasonable balance.
 */
export const MAX_FLUSH_WINDOW_CHARS = 600;

/**
 * Find the best flush boundary in `text` given the position already
 * flushed and the flush window parameters.
 *
 * Boundary preference (highest first):
 *   1. Paragraph boundary (`\n\n`) — flush after the second `\n`.
 *   2. Line boundary (`\n`) — flush after the `\n`.
 *   3. Sentence boundary (`. `, `! `, `? `) — flush after the space.
 *   4. Word boundary (` `) — flush after the space.
 *   5. Max-window fallback — flush at `alreadyFlushed + maxWindow`
 *      when no preferred boundary appears within the window.
 *
 * @param text - The full formatted assistant text.
 * @param alreadyFlushed - Number of characters already emitted
 *                         (`stream.len`).
 * @param minChars - Minimum new-text threshold before flushing
 *                   (typically `STREAM_FLUSH_THRESHOLD_CHARS` = 200).
 * @param maxWindow - Maximum window from `alreadyFlushed` before
 *                    forcing a hard boundary
 *                    (typically `MAX_FLUSH_WINDOW_CHARS` = 600).
 * @returns The exclusive end position for
 *          `text.slice(alreadyFlushed, boundary)`. Always >=
 *          `alreadyFlushed + minChars` and <=
 *          `alreadyFlushed + maxWindow`. When `text.length` is less
 *          than `alreadyFlushed + minChars`, returns `text.length`
 *          (the caller should not flush).
 */
export function findFlushBoundary(
  text: string,
  alreadyFlushed: number,
  minChars: number,
  maxWindow: number,
): number {
  const textLen = text.length;
  const minPos = alreadyFlushed + minChars;
  const maxPos = Math.min(alreadyFlushed + maxWindow, textLen);

  // Not enough new text to flush — return textLen (caller should not flush).
  if (minPos > textLen) return textLen;

  // If the window is exhausted (text fits within min+max), flush all.
  if (minPos >= maxPos) return textLen;

  // Search within [minPos, maxPos) for boundaries, preferring the
  // last occurrence (to include as much text as possible).
  const searchText = text.slice(minPos, maxPos);

  // 1. Paragraph boundary (\n\n) — flush after both newlines.
  const paraIdx = searchText.lastIndexOf("\n\n");
  if (paraIdx !== -1) {
    return minPos + paraIdx + 2;
  }

  // 2. Line boundary (\n) — flush after the newline.
  const lineIdx = searchText.lastIndexOf("\n");
  if (lineIdx !== -1) {
    return minPos + lineIdx + 1;
  }

  // 3. Sentence boundary (. ., ! ., ? . — punctuation followed by
  //    whitespace). Prefer the last one within the window.
  const sentenceIdx = findLastSentenceBoundary(searchText);
  if (sentenceIdx !== -1) {
    // Include the punctuation and the trailing space in the
    // flushed chunk so the next chunk starts clean.
    return minPos + sentenceIdx + 2;
  }

  // 4. Word boundary (space) — flush after the space.
  const wordIdx = searchText.lastIndexOf(" ");
  if (wordIdx !== -1) {
    return minPos + wordIdx + 1;
  }

  // 5. Max-window fallback — flush at the window boundary.
  return maxPos;
}

/**
 * Find the last sentence boundary (`. `, `! `, `? `) in the given
 * text. Returns the index of the punctuation character, or -1 if
 * none found. Searches right-to-left to find the last occurrence
 * (maximizing the flushed text within the window).
 */
function findLastSentenceBoundary(searchSpace: string): number {
  for (let i = searchSpace.length - 2; i >= 0; i--) {
    const ch = searchSpace[i];
    if ((ch === "." || ch === "!" || ch === "?") && searchSpace[i + 1] === " ") {
      return i;
    }
  }
  return -1;
}
