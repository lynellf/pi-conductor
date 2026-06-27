/**
 * Pure display-text normalizer for streaming markdown continuation chunks
 * (Phase 1: quote-block continuity fix).
 *
 * When `extractAssistantText()` produces a blockquoted thinking line
 * (`> ...`) and the streamed chunk boundary falls mid-line, the raw
 * `formatted.slice()` produces a continuation fragment that starts
 * with plain prose — losing the `> ` marker. The independent Markdown
 * renderer for each `text_stream` chunk then renders the fragment
 * outside the quote block.
 *
 * This module provides the pure normalization that rewrites the
 * display chunk to be self-contained for markdown blockquote rendering:
 * if the chunk starts mid-line inside a blockquoted line, the first
 * line is prefixed with the detected quote marker sequence.
 *
 * The normalizer returns the same text length as the source slice
 * only when no prefix is needed; when a prefix IS added, the returned
 * display text is longer (by the prefix length). Callers must NOT
 * use the return length for source-position accounting (`stream.len`
 * is always based on the original formatted string).
 */

/**
 * Detect the markdown blockquote prefix at the given line start position,
 * including nesting depth. Returns the full prefix (e.g. `"> "`, `"> > "`),
 * or `null` if the line does not start with a blockquote marker.
 *
 * Handles simple blockquotes (`> text`) and nested blockquotes
 * (`> > text`, `> > > text`) with optional single spaces between
 * markers. The returned prefix always ends with a trailing space
 * so it can be directly prepended to text.
 *
 * This function does not handle:
 * - Indented blockquotes (leading whitespace before `>`)
 * - Continuation markers (lazy `>` continuation lines)
 */
export function detectQuotePrefix(formatted: string, lineStart: number): string | null {
  let i = lineStart;
  let prefix = "";

  while (i < formatted.length) {
    if (formatted[i] === ">") {
      prefix += ">";
      i++;
      // Consume exactly one optional space after `>`
      if (i < formatted.length && formatted[i] === " ") {
        prefix += " ";
        i++;
      } else {
        // `>` without trailing space — still a valid marker
        break;
      }
      // After consuming `> `, continue to check for nested `>`
      continue;
    }
    break;
  }

  // Ensure the prefix ends with a space (if we captured at least one marker)
  if (prefix.length > 0) {
    // If the prefix doesn't end with a space, add one
    if (prefix[prefix.length - 1] !== " ") {
      prefix += " ";
    }
  }

  return prefix.length > 0 ? prefix : null;
}

/**
 * Normalize a streamed chunk so its first line is self-contained for
 * markdown blockquote rendering.
 *
 * @param formatted - The full formatted assistant text from
 *                    `extractAssistantText()`.
 * @param sliceStart - Character offset where this chunk starts in
 *                     `formatted` (typically `stream.len`).
 * @param sliceEnd - Exclusive end offset (typically `boundaryPos` or
 *                   `formatted.length`).
 * @returns The display-normalized chunk text. Longer than the source
 *          slice when a quote prefix is inserted. Never shorter.
 *
 * ## When normalization applies
 *
 * Normalization is triggered when ALL of these are true:
 *   1. `sliceStart > 0` (not the first chunk).
 *   2. `sliceStart` is MID-LINE (not at a newline boundary).
 *   3. The line containing `sliceStart` begins with a blockquote
 *      marker sequence (`> `, `> > `, etc.).
 *
 * ## What normalization does
 *
 * Prepends the detected quote prefix to the first line-fragment of
 * the chunk. Complete subsequent lines are left unchanged (they
 * already carry the correct `> ` prefix from the formatted source).
 *
 * ## Testability
 *
 * Pure function: no I/O, no side effects, no module state. Deterministic.
 */
export function normalizeContinuationChunk(
  formatted: string,
  sliceStart: number,
  sliceEnd: number,
): string {
  // Chunks starting at position 0 are already self-contained.
  if (sliceStart === 0) {
    return formatted.slice(sliceStart, sliceEnd);
  }

  const chunk = formatted.slice(sliceStart, sliceEnd);
  if (chunk.length === 0) return chunk;

  // Walk backwards from sliceStart to find the start of the
  // logical line. The line is everything between two newlines
  // (or start-of-string and a newline, or a newline and end-of-string).
  let lineStart = sliceStart;
  while (lineStart > 0 && formatted[lineStart - 1] !== "\n") {
    lineStart--;
  }

  // Only normalize when sliceStart is MID-LINE (not at a new line).
  // If sliceStart is at the start of a fresh line, the chunk's first
  // character IS the start of that line — it already has the correct
  // prefix (or lacks one, if the line is unquoted).
  if (lineStart === sliceStart) {
    return chunk;
  }

  // Check if the current logical line begins with a blockquote marker.
  const prefix = detectQuotePrefix(formatted, lineStart);
  if (prefix === null) {
    return chunk; // Not inside a blockquote — no normalization.
  }

  // Prepend the quote prefix to the first line-fragment only.
  // Subsequent lines in a multi-line chunk already carry their
  // own `> ` prefix from the formatted source.
  const firstNewline = chunk.indexOf("\n");
  if (firstNewline === -1) {
    // Single-line continuation fragment — prefix the whole thing.
    return prefix + chunk;
  }

  // Multi-line chunk: prefix only the first line fragment.
  return prefix + chunk.slice(0, firstNewline) + chunk.slice(firstNewline);
}
