/**
 * Durable file-mutation telemetry — issue #22.
 *
 * Pure value types shared by the host's display projection and its append-only
 * record log. Keeping the metadata here ensures replay consumers receive the
 * same changed-file facts that the interactive display shows.
 */

import type { Role } from "../core/types.js";

/**
 * A single line in a structured diff hunk (issue #13).
 *
 * `lineNumber` is the position in the appropriate file: `add` and `context`
 * use the new file; `del` uses the old file. Edit-only hunks use synthetic
 * sequential positions because they are derived from `args.edits[]`; write
 * hunks use actual positions from the pre-mutation file content.
 */
export interface HunkLine {
  /** Position in the old or new file, depending on `kind`. */
  readonly lineNumber: number;
  /** Rendered content with a `+` or `-` marker when applicable. */
  readonly content: string;
  readonly kind: "add" | "del" | "context";
}

/**
 * A file changed by a successful `write` or `edit` call.
 *
 * `additions` and `deletions` are character counts derived from tool
 * arguments: `write` reports the new content length and zero deletions, while
 * `edit` sums all `oldText` / `newText` lengths. `hunks` is optional structured
 * line-level context when the host can derive it (issue #13): purely from edit
 * arguments, or from a write's captured pre-mutation content. Hunk derivation
 * failure never removes the trustworthy char-count metadata.
 */
export interface TouchedFile {
  readonly path: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly hunks?: ReadonlyArray<HunkLine>;
}

/**
 * Host-owned, replayable telemetry for one confirmed file-mutating tool call.
 *
 * Appended through `Host.persistRecord` so the JSONL log and in-process
 * `conductor:record` subscribers observe the same durable record (issue #22).
 */
export interface FileMutationRecord {
  readonly type: "file_mutation";
  readonly run_id: string;
  readonly role: Role;
  readonly session_id: string;
  readonly session_file: string;
  readonly tool_name: "write" | "edit";
  readonly files: ReadonlyArray<TouchedFile>;
  readonly ts: number;
}
