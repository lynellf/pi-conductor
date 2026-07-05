/**
 * Pure + I/O helpers for structured diff hunk generation (issue #13).
 *
 * Phase 2 (open-issues-round-3, issue #13) extends `TouchedFile` with
 * an optional `hunks` field. This module provides:
 *
 * - `parseDiffHunks(oldContent, newContent)` — pure: parses the output
 *   of `Diff.diffLines` into `HunkLine[]`. Uses `Diff.diffLines` from
 *   the `diff` package (the same library pi-coding-agent uses for
 *   `edit-diff.ts`).
 *
 * - `buildWriteHunks(oldContent, newContent)` — pure: entry point for
 *   `write` tool hunk generation. `oldContent === null` produces
 *   all-`add` hunks (new file); non-null delegates to `parseDiffHunks`.
 *
 * - `loadWriteHunksForArgs(args)` — async I/O: reads the previous
 *   content of `args.path` from disk (at `tool_execution_start`,
 *   before the tool runs) and produces hunks for a `write` tool
 *   invocation. Never throws.
 *
 * All three are exported; `parseDiffHunks` and `buildWriteHunks` are
 * pure and unit-testable in isolation.
 */

import { readFileSync } from "node:fs";

import { diffLines } from "diff";

import type { HunkLine } from "./display-sink.js";

/**
 * Parse a structured diff between `oldContent` and `newContent` into
 * `HunkLine[]`. Uses `Diff.diffLines` from the `diff` package (the
 * same library pi-coding-agent uses for `edit-diff.ts`).
 *
 * - `add` lines → `kind: 'add'`, content prefixed with `+`.
 * - `del` lines → `kind: 'del'`, content prefixed with `-`.
 * - Unchanged lines → `kind: 'context'`, content as-is.
 *
 * **Line numbers:** `add` and `context` lines count from 1 in the
 * new file; `del` lines count from 1 in the old file. This matches
 * the convention used by the SDK's `generateDiffString` and by
 * standard unified-diff tooling.
 *
 * Pure function — no I/O, no SDK coupling. Unit-testable in
 * isolation.
 *
 * @param oldContent - The previous file content (or `""` for an empty file).
 * @param newContent - The new file content.
 */
export function parseDiffHunks(oldContent: string, newContent: string): ReadonlyArray<HunkLine> {
  const parts = diffLines(oldContent, newContent);

  // Early exit: if no parts have actual changes (no added or removed),
  // return an empty array — identical content has no diff to render.
  const hasChanges = parts.some((p) => p.removed || p.added);
  if (!hasChanges) return [];

  const hunks: HunkLine[] = [];

  // Track cumulative lines consumed from each file
  // netOffset = newPos - oldPos represents how much the new file is shifted
  // relative to the old file at the current position.
  let oldConsumed = 0;
  let newConsumed = 0;

  for (const part of parts) {
    const lines = part.value.split("\n");
    // Drop trailing empty element from trailing newline
    if (lines[lines.length - 1] === "") lines.pop();

    if (part.removed) {
      for (const line of lines) {
        // Del line: position in the old file
        hunks.push({
          lineNumber: oldConsumed + 1,
          content: `-${line}`,
          kind: "del",
        });
        oldConsumed++;
      }
    } else if (part.added) {
      for (const line of lines) {
        // Add line: position in the new file
        // new file position = old position + net offset (additions - deletions so far)
        const netOffset = newConsumed - oldConsumed;
        hunks.push({
          lineNumber: oldConsumed + netOffset + 1,
          content: `+${line}`,
          kind: "add",
        });
        newConsumed++;
      }
    } else {
      for (const line of lines) {
        // Context line: position in the new file
        // new file position = old position + net offset
        const netOffset = newConsumed - oldConsumed;
        hunks.push({
          lineNumber: oldConsumed + netOffset + 1,
          content: line,
          kind: "context",
        });
        oldConsumed++;
        newConsumed++;
      }
    }
  }

  return hunks;
}

/**
 * Build hunks for a `write` tool invocation given the previous
 * file content (or `null` for a new file) and the new content
 * from `args.content`.
 *
 * - `oldContent === null` (new file): all lines are `add` hunks
 *   starting from line 1.
 * - `oldContent !== null`: delegates to `parseDiffHunks`.
 *
 * Pure helper — does not read disk. The caller is responsible for
 * capturing the previous content (see `loadWriteHunksForArgs`).
 *
 * @param oldContent - The previous file content, or `null` if the file did not exist.
 * @param newContent - The new content being written.
 */
export function buildWriteHunks(
  oldContent: string | null,
  newContent: string,
): ReadonlyArray<HunkLine> {
  if (oldContent === null) {
    // New file: all lines are additions, line 1 onward
    const hunks: HunkLine[] = [];
    const lines = newContent.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    let lineNum = 1;
    for (const line of lines) {
      hunks.push({ lineNumber: lineNum++, content: `+${line}`, kind: "add" });
    }
    return hunks;
  }
  return parseDiffHunks(oldContent, newContent);
}

/**
 * I/O helper: read the previous content of `args.path` and produce
 * hunks for a `write` tool invocation. Used by the host's
 * `session-event-handler` at `tool_execution_start` to capture the
 * pre-mutation content for later diffing at `tool_execution_end`.
 *
 * **Timing:** the caller invokes this at `tool_execution_start`
 * (pre-mutation), not at `tool_execution_end` (post-mutation),
 * because the file has already been written by the tool at that point.
 *
 * Uses **synchronous** `readFileSync` (single small-file read, no
 * meaningful blocking) rather than async `readFile` to avoid microtask-
 * timing issues in the handler. The synchronous read means the pending
 * entry is fully populated before `tool_execution_start` returns,
 * and the handler's `tool_execution_end` branch can check
 * `writeHunks` synchronously.
 *
 * Returns `undefined` when:
 *   - `args.path` is missing or non-string.
 *   - `args.content` is missing or non-string.
 *   - The file does not exist (`ENOENT`) — caller treats as new file:
 *     `buildWriteHunks(null, newContent)` returns all-`add` hunks.
 *   - The disk read fails for any other reason (permission denied,
 *     I/O error) — caller falls back to char-counts only, omitting
 *     `hunks`.
 *
 * Never throws.
 *
 * @param args - The `args` from a `tool_execution_start` event for a `write` tool.
 * @returns `HunkLine[]` or `undefined`.
 */
export function loadWriteHunksForArgs(args: unknown): ReadonlyArray<HunkLine> | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const a = args as { path?: string; content?: string };
  const path = typeof a.path === "string" ? a.path : undefined;
  const content = typeof a.content === "string" ? a.content : undefined;
  if (path === undefined || content === undefined) return undefined;

  let oldContent: string | null = null;
  try {
    oldContent = readFileSync(path, "utf8");
  } catch (err) {
    // ENOENT: file does not exist → new file (all-`add` hunks).
    // Any other error (EACCES, EIO, etc.): degrade gracefully.
    const code = (err as { code?: string }).code;
    if (code !== "ENOENT") return undefined;
    // ENOENT → oldContent stays null → new file
  }

  return buildWriteHunks(oldContent, content);
}
