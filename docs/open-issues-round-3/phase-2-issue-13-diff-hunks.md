# Phase 2 — Issue #13: structured diff hunks in `TouchedFile`

**Source:** [`../plan.md`](../plan.md); GH issue #13
(`RunDeck: provide structured diff hunks in TouchedFile for write/edit tools`,
enhancement). Sub-plan for the architectural + implementation steps. Builds
on Phase 1 (issue #12, shipped in v0.6.0), which introduced `TouchedFile` with
char-count additions/deletions — this phase extends it with structured diff
hunks.

## Goal

Extend `TouchedFile` with an optional `hunks` array so downstream consumers
(notably RunDeck's `FileDiffDialog` and `InlineChangeCard`) can render
line-level diffs from the display event stream. Populated by the host when a
file-mutating tool (`write`, `edit`) succeeds; absent on read-only, machine,
or `bash` tools.

This is an **additive** change. Consumers that don't read `hunks` (the TUI
bridge, RunDeck's char-count code paths) are unaffected. RunDeck's
`FileDiffDialog` already renders `hunks` when present — populating the field
enables the diff UX without consumer-side code changes.

## What RunDeck needs (from issue #13 body)

```ts
export interface HunkLine {
  readonly lineNumber: number;
  readonly content: string;   // line content with +/- prefix for add/del lines
  readonly kind: 'add' | 'del' | 'context';
}

export interface TouchedFile {
  readonly path: string;
  readonly additions?: number;
  readonly deletions?: number;
  /** Structured diff hunks for this file, if available. */
  readonly hunks?: ReadonlyArray<HunkLine>;
}
```

The `hunks` field should be populated when the host can compute a line-level
diff between the file's old content and new content after a `write` or
`edit` tool invocation.

**Design constraints from issue body:**

- **`write` tool:** args carry only `content`. To produce hunks, the host
  must read the previous file content from disk (if it exists), diff old
  vs new, and produce `HunkLine[]`. When no prior file exists (new file),
  all lines are `add` hunks.
- **`edit` tool:** args carry `oldText` and `newText` per edit. The host
  can produce hunks directly from these without reading disk — minimum is
  changed lines only; surrounding context is nice-to-have.
- **`bash` tool:** out of scope for v1 (same as Phase 1).
- **Fallback:** when `hunks` is omitted, downstream consumers handle it
  gracefully (RunDeck already does — shows "The run did not record
  structured diff hunks for this file.").

## Spec

### Dependency

**`package.json`** — add `diff` as a runtime dependency:

```json
"dependencies": {
  "diff": "^8.0.2"
}
```

`diff@^8.0.2` is the same library pi-coding-agent uses internally for
`edit-diff.ts` (`Diff.diffLines`, `Diff.createTwoFilesPatch`). It's mature,
pure JS (no install scripts, no `pnpm-workspace.yaml`
`onlyBuiltDependencies` update required), already a transitive dep at
v8.0.4, ships TypeScript declarations, and adds ~14KB to the dependency
tree.

The lockfile will resolve the exact version; commit the lockfile change.

**`pnpm-workspace.yaml`** — no change (no install scripts on `diff`).

### Type changes

**`src/host/display-sink.ts`** — extend `TouchedFile` with:

```ts
/**
 * A single line in a structured diff hunk.
 *
 * `lineNumber` is the position of the line in the appropriate file:
 *   - `add` lines → line number in the **new** file.
 *   - `del` lines → line number in the **old** file.
 *   - `context` lines → line number in the **new** file.
 *
 * `content` carries the rendered line text with a marker prefix
 * (`+` for `add`, `-` for `del`, none for `context`) so consumers
 * can render unified-diff-style output without re-classifying.
 *
 * **Edit-only line numbers:** for `edit` tool hunks (no surrounding
 * context), `add` line numbers count from 1 (synthetic new-file
 * position) and `del` line numbers count from 1 (synthetic old-file
 * position). The issue body explicitly accepts "hunks may be
 * edit-only without full-file context" — the alternative is to
 * read the file at `tool_execution_start`, which is deferred.
 *
 * For `write` tool hunks (full file read), `lineNumber` reflects
 * the real file positions because we diff against the captured
 * pre-write content.
 */
export interface HunkLine {
  readonly lineNumber: number;
  /** Line content with `+`/`-` prefix for `add`/`del` lines. */
  readonly content: string;
  readonly kind: 'add' | 'del' | 'context';
}

/** A single file mutation observed from a tool invocation. */
export interface TouchedFile {
  readonly path: string;
  /** Char-count of new content introduced by the tool call. */
  readonly additions?: number;
  /** Char-count of content removed by the tool call. */
  readonly deletions?: number;
  /**
   * Structured diff hunks for this file (issue #13).
   *
   * Populated only on successful tool invocations when hunks can be
   * computed:
   *   - `edit` — pure derivation from `args.edits[]` (changed lines
   *     only; sequential line numbers).
   *   - `write` — async I/O against the previous file content,
   *     captured at `tool_execution_start`. New files (no prior
   *     content) get all-`add` hunks starting from line 1.
   *
   * Absent for read-only tools (`read`, `grep`, `find`, `ls`),
   * machine tools (`handoff`, `end`, `ask_user`), `bash` (out of
   * scope for v1), and any case where the args are malformed or
   * the disk read fails (graceful degradation: char-counts still
   * flow, `hunks` is absent).
   *
   * Optional and additive — consumers that don't read `hunks` are
   * unaffected.
   */
  readonly hunks?: ReadonlyArray<HunkLine>;
}
```

### Helper module

**`src/host/hunk-diff.ts`** (new) — pure + I/O helpers for hunk
generation. Kept separate from `display-sink.ts` to honor the
~400 LOC ceiling and single-responsibility split (pure hunk logic
vs. public seam types). Imports `Diff` from `diff` package.

```ts
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
 */
export function parseDiffHunks(
  oldContent: string,
  newContent: string,
): ReadonlyArray<HunkLine>;
```

```ts
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
 */
export function buildWriteHunks(
  oldContent: string | null,
  newContent: string,
): ReadonlyArray<HunkLine>;
```

```ts
/**
 * Async I/O helper: read the previous content of `args.path` and
 * produce hunks for a `write` tool invocation. Used by the host's
 * `session-event-handler` at `tool_execution_end` to enrich the
 * display event with structured diff lines.
 *
 * **Timing:** the caller should invoke this from a Promise chain
 * that started at `tool_execution_start` (so we read the pre-mutation
 * content, not the post-mutation content). At `tool_execution_end`,
 * the file has already been written by the tool, so reading here
 * directly would yield the new content — useless for diffing.
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
 */
export async function loadWriteHunksForArgs(
  args: unknown,
): Promise<ReadonlyArray<HunkLine> | undefined>;
```

### Pure helper (in `display-sink.ts`)

**`src/host/display-sink.ts`** — new exported pure helper:

```ts
/**
 * Pure helper: produce structured diff hunks for a tool invocation
 * from its args. No filesystem I/O — `write` requires the previous
 * content to be supplied by the caller (use `loadWriteHunksForArgs`
 * from `hunk-diff.ts`).
 *
 * Returns:
 *   - `undefined` for non-mutating tools (`read`, `grep`, `find`,
 *     `ls`, machine tools, unknown tools). Callers omit the field.
 *   - `[]` for mutating tools whose args don't match the expected
 *     shape (graceful degradation).
 *   - `HunkLine[]` for `edit` (pure: derived from `args.edits[]`'s
 *     `oldText`/`newText` pairs — changed lines only, sequential
 *     line numbers).
 *   - `undefined` for `write` (caller must supply the previous
 *     content via `loadWriteHunksForArgs`; without it, we cannot
 *     produce hunks).
 */
export function extractFileHunks(
  toolName: string,
  args: unknown,
): ReadonlyArray<HunkLine> | undefined;
```

Implementation sketch:

- `edit`:
  - For each `{ oldText, newText }` in `args.edits[]`, split by `\n`,
    emit `del` lines (with sequential old-line counter starting at 1),
    then `add` lines (sequential new-line counter starting at 1).
  - `oldText` lines are prefixed with `-` in `content`; `newText` lines
    with `+`. Empty trailing element from trailing-`\n` split is dropped
    (matches `diff` package behavior).
  - If `args.edits` is missing/empty/non-array, return `[]`.
- `write`:
  - Return `undefined` (caller must supply `oldContent` via
    `loadWriteHunksForArgs`; `extractFileHunks` cannot do I/O by
    contract).
- Non-mutating tools (`read`, `grep`, `find`, `ls`, `handoff`, `end`,
  `ask_user`, unknown): return `undefined`.

### Wiring (in `session-event-handler.ts`)

**`src/host/session-event-handler.ts`** — extend the `pending` map and
both `tool_execution_start` / `tool_execution_end` branches.

`pending`'s entry shape grows:

```ts
// Before (Phase 1):
const pending = new Map<string, { summary: string; args: unknown }>();

// After (Phase 2):
const pending = new Map<
  string,
  {
    summary: string;
    args: unknown;
    /** Promise that resolves to the previous file content for `write` tool
     *  invocations. Captured at `tool_execution_start` (pre-mutation);
     *  consumed at `tool_execution_end` to diff against `args.content`. */
    writeOldContentPromise?: Promise<string | null>;
  }
>();
```

`tool_execution_start` — for `write` tools, fire-and-forget the
file read:

```ts
if (event.type === "tool_execution_start") {
  const summary = formatToolCallSummary(event.toolName, event.args);
  if (summary === null) return;
  const entry: { summary: string; args: unknown; writeOldContentPromise?: Promise<string | null> } = {
    summary,
    args: event.args,
  };
  // Issue #13: capture the previous file content for `write` so we
  // can produce structured diff hunks at `tool_execution_end`. The
  // file is still pre-mutation here; reading post-tool would yield
  // `args.content` (useless for diffing). Fire-and-forget — failures
  // are swallowed in `loadWriteHunksForArgs` (returns `undefined`).
  if (event.toolName === "write") {
    entry.writeOldContentPromise = loadWriteHunksForArgs(event.args);
  }
  pending.set(event.toolCallId, entry);
  return;
}
```

`tool_execution_end` — emit display event with hunks attached:

```ts
if (event.type === "tool_execution_end") {
  const buffered = pending.get(event.toolCallId);
  pending.delete(event.toolCallId);
  const line = formatToolCompletedLine(buffered?.summary, event.result, event.isError);
  if (line === null) return;

  if (event.isError) {
    // Errors omit `files` entirely (Phase 1 contract).
    onDisplay?.({ role, kind: "tool_result", text: line });
    return;
  }

  const mutations = extractFileMutations(event.toolName, buffered?.args);

  // Helper: emit a `tool_result` display event with the given hunks
  // attached to the existing mutations (or omit hunks if none).
  const emit = (hunks?: ReadonlyArray<HunkLine>): void => {
    const files =
      mutations !== undefined && mutations.length > 0
        ? mutations.map((f) =>
            hunks && hunks.length > 0 ? { ...f, hunks } : f,
          )
        : undefined;
    onDisplay?.({
      role,
      kind: "tool_result",
      text: line,
      ...(files !== undefined && { files }),
    });
  };

  // `edit` — pure, hunks from args.
  if (event.toolName === "edit") {
    emit(extractFileHunks(event.toolName, buffered?.args));
    return;
  }

  // `write` — async, await the captured pre-mutation content.
  const writePromise = buffered?.writeOldContentPromise;
  if (event.toolName === "write" && writePromise !== undefined) {
    writePromise
      .then((oldContent) => {
        const newContent =
          isObject(buffered?.args) && typeof buffered.args.content === "string"
            ? buffered.args.content
            : undefined;
        if (newContent === undefined) {
          emit();
          return;
        }
        emit(buildWriteHunks(oldContent, newContent));
      })
      .catch(() => emit()); // Defensive: loadWriteHunksForArgs already
                            // swallows, but a stray throw is safe here.
    return;
  }

  // Other tools: emit without hunks.
  emit();
}
```

Notes:

- The handler's `pending.delete` happens before the async disk-read
  callback fires. This is correct: by `tool_execution_end`, the entry
  is no longer needed for the synchronous flow.
- The async chain emits one additional `DisplayEvent` for `write`
  invocations, arriving ~1–5ms after the initial `tool_result` line.
  RunDeck's consumer is event-stream-based and tolerates multi-event
  deliveries; the user sees the tool completion line immediately
  and the hunks arrive in a follow-up event.
- For `edit`, no async deferral: pure helper emits synchronously
  inside the `tool_execution_end` branch.

### Module-size check

`src/host/hunk-diff.ts` is a new file. Expected LOC:

- File-level docstring + imports: ~30 lines.
- `parseDiffHunks`: ~40 lines (split + iterate parts + push HunkLines).
- `buildWriteHunks`: ~15 lines (delegates to `parseDiffHunks` or builds
  all-add for `null`).
- `loadWriteHunksForArgs`: ~30 lines (read disk + handle ENOENT +
  catch).
- Module-level docstring on file growth: ~15 lines.

Total ~130 LOC. Well under the 400 ceiling.

`src/host/display-sink.ts` grows by:

- `HunkLine` interface + JSDoc: ~30 lines.
- Extended `TouchedFile` JSDoc: ~10 lines.
- `extractFileHunks` helper + JSDoc: ~50 lines.

Total ~90 lines added; current file is ~270 LOC; new total ~360, still
under 400. If we exceed 400, split `HunkLine` + hunk helpers into
`hunk-types.ts` (mirroring the `hunk-diff.ts` split).

### Tests

**`tests/host/hunk-diff.test.ts`** (new) — pure helper unit tests:

- `parseDiffHunks`:
  - Empty old + empty new → `[]`.
  - Identical old and new → all `context` lines.
  - Single new file (`""` vs `"foo\nbar"`) → 2 `add` lines.
  - Full replacement (`"foo"` vs `"bar"`) → 1 `del` + 1 `add`.
  - Insertion in middle → surrounding `context` lines + `add` lines.
  - Deletion in middle → surrounding `context` lines + `del` lines.
  - Multi-line block change (multi-line `oldText` → multi-line `newText`).
  - Trailing newline semantics (drop empty trailing element).
- `buildWriteHunks`:
  - `null` old content → all `add` lines.
  - Non-null old content → delegates to `parseDiffHunks` (covered above).
  - Empty new content + null old → `[]`.
  - Empty new content + non-empty old → all `del` lines.
- `loadWriteHunksForArgs`:
  - Existing file with content → reads, produces `HunkLine[]` via
    `buildWriteHunks`.
  - Non-existent file (`ENOENT`) → returns all-`add` hunks (new file).
  - Missing `path` → returns `undefined`.
  - Non-string `path` → returns `undefined`.
  - Missing `content` → returns `undefined`.
  - Non-string `content` → returns `undefined`.
  - Non-object args → returns `undefined`.
  - Use real filesystem in a `mkdtemp`-created temp dir (matches the
    pattern at `tests/host/manifest.test.ts` for filesystem-touching
    tests).

**`tests/host/display-sink.test.ts`** (extend) — pure helper tests for
`extractFileHunks`:

- `edit` happy path (single edit) → `del` + `add` lines.
- `edit` happy path (multiple edits) → all `del` + `add` lines, in
  order.
- `edit` missing `path` → `[]`.
- `edit` missing `edits` → `[]`.
- `edit` empty `edits[]` → `[]`.
- `edit` non-string `oldText`/`newText` → line not emitted (skip).
- `write` → `undefined` (caller must supply previous content).
- `read` / `grep` / `find` / `ls` → `undefined`.
- `handoff` / `end` / `ask_user` → `undefined`.
- Unknown tool name → `undefined`.
- Malformed args (null, array, primitive) → `undefined`.

**`tests/host/display-forwarding.test.ts`** (extend) — integration
tests on `attachSessionEventHandler`:

- `edit` tool_result event carries `files[].hunks` for a successful
  invocation (synchronous emission).
- `write` tool_result event carries `files[].hunks` for a successful
  invocation (deferred emission via the captured
  `writeOldContentPromise`). Use the existing `makeSession()` factory
  pattern; for the file read, set up a temp dir in `beforeAll` and
  create a file there before emitting `tool_execution_start` (the
  pre-mutation read).
- `write` for a new file (no prior content) → all-`add` hunks.
- `write` for a file whose read fails (e.g., path is a directory) →
  no `hunks` field (graceful degradation).
- `read` / `grep` / `find` / `ls` tool_result events do NOT carry
  `hunks` (sanity check; existing test coverage already asserts no
  `files` field for these — the new assertion is that `files` is also
  absent when `hunks` would be the only reason to populate it, which
  is the same condition).
- `edit` with multiple edits populates `hunks` from all `edits[]`.
- `text` events never carry `files` (sanity check, unchanged from
  Phase 1).

Each integration test waits for the async emission to settle before
asserting — use `await new Promise(setImmediate)` or
`await flushPromises()` (small helper) so the test framework sees
both events.

### CHANGELOG and version bump

**`CHANGELOG.md`** — add a new version section (next minor or patch):
0.6.0 is already shipped; Phase 2 is additive on top of it.

Recommendation: bump to `0.7.0` (additive public-type extension +
new runtime dep, semver MINOR per the repo's cadence). If the
overseer prefers PATCH cadence for purely-additive optional fields,
use `0.6.1` — surface as Open Question 8.

```markdown
## [0.7.0] - YYYY-MM-DD

### Enhancement
- **TouchedFile carries structured diff hunks** (issue #13).
  `TouchedFile` gains an optional `hunks?: ReadonlyArray<HunkLine>`
  field, populated by the host on successful `tool_result` events
  for the `write` and `edit` built-in tools. Each `HunkLine` carries
  `lineNumber`, `content` (with `+`/`-` prefix for add/del lines),
  and `kind: 'add' | 'del' | 'context'`. For `edit`, hunks are
  derived purely from `args.edits[]` (changed lines only; sequential
  line numbers; surrounding context deferred). For `write`, hunks
  are computed by reading the previous file content at
  `tool_execution_start` (pre-mutation) and diffing against
  `args.content` at `tool_execution_end` (~1–5ms deferred emission).
  Read-only tools (`read`, `grep`, `find`, `ls`), machine tools
  (`handoff`, `end`, `ask_user`), and `bash` never populate `hunks`.
  RunDeck's `FileDiffDialog` already renders `hunks` when present —
  no consumer-side code changes. Spec:
  `docs/open-issues-round-3/phase-2-issue-13-diff-hunks.md`.

### Notes
- New runtime dependency: `diff@^8.0.2` (~14KB pure JS, the same
  library pi-coding-agent uses for `edit-diff.ts`). Lockfile updated.
- `pnpm-workspace.yaml` `onlyBuiltDependencies` unchanged —
  `diff` has no install scripts.
- No breaking changes to the public API surface. `hunks` is optional
  and additive; the TUI bridge, RunDeck's char-count code paths, and
  the char-count `additions`/`deletions` fields are all unchanged.
- Two new test files: `tests/host/hunk-diff.test.ts` (pure + I/O
  helper tests, ~12 cases) and extended `tests/host/display-sink.test.ts`
  (~10 new `extractFileHunks` cases) and `tests/host/display-forwarding.test.ts`
  (~6 new integration cases for wired hunks).
- Grep guard (`tests/grep-guard.test.ts`) and the
  `no-ctx.newSession`/`no-ctx.fork` extension grep guard continue to
  pass — the new code stays in `src/host/` and the new helper module.
```

**`package.json`** — bump `"version"` from `"0.6.0"` to `"0.7.0"` (or
`"0.6.1"` per Open Question 8).

## Tasks

### Task 2.1 — Add `diff@^8.0.2` runtime dependency

**Description:** Add `diff` to `package.json` `dependencies`, run
`pnpm install` to update the lockfile, verify `pnpm-workspace.yaml`
needs no change (no install scripts on `diff`).

**Acceptance criteria:**

- [x] `package.json` `"dependencies"` contains `"diff": "^8.0.2"`.
- [x] `pnpm-lock.yaml` reflects the new dep (one new entry for `diff`,
  or a hoist of the existing transitive to top level).
- [x] `pnpm install` succeeds without install-script warnings
  (`strictDepBuilds: true` from `pnpm-workspace.yaml` enforces this).
- [x] `pnpm-workspace.yaml` `onlyBuiltDependencies` is unchanged.

**Verification:**

- [x] `git diff package.json pnpm-lock.yaml` shows the expected
      changes.
- [x] `node -e "require('diff')"` succeeds at the workspace root.
- [x] `pnpm typecheck` clean.

### Task 2.2 — Add `HunkLine` type and extend `TouchedFile`

**Description:** Add the `HunkLine` interface to `src/host/display-sink.ts`
and extend `TouchedFile.hunks?: ReadonlyArray<HunkLine>`. Update
`DisplayEvent`'s file-level JSDoc to note that `hunks` is the new
issue-#13 field.

**Acceptance criteria:**

- [x] `HunkLine` interface exported from `src/host/display-sink.ts`
      with `lineNumber`, `content`, `kind`.
- [x] `TouchedFile.hunks?: ReadonlyArray<HunkLine>` added.
- [x] JSDoc explains line-number semantics (`add`/`context` = new
      file; `del` = old file; sequential for `edit`, real for
      `write`).
- [x] JSDoc documents the `write` async I/O deferral.
- [x] No other field changes (additive only).
- [x] File-level docstring at the top of `display-sink.ts` updated to
      reference issue #13 in the Phase 2 pass.

**Verification:**

- [x] `pnpm typecheck` clean.
- [x] `grep -n "hunks" src/host/display-sink.ts` shows the new
      declaration.

### Task 2.3 — Create `hunk-diff.ts` helper module

**Description:** Implement the pure + I/O helpers in a new
`src/host/hunk-diff.ts` file: `parseDiffHunks`,
`buildWriteHunks`, `loadWriteHunksForArgs`. Uses `diff` package's
`Diff.diffLines` for line-level LCS. Handles ENOENT for new files
(all-`add` hunks). Never throws.

**Acceptance criteria:**

- [x] `src/host/hunk-diff.ts` exists with the three exports.
- [x] `parseDiffHunks(oldContent, newContent)` returns `HunkLine[]`
      with correct `lineNumber`, `content` (with `+`/`-` prefix), and
      `kind` for each line in the diff.
- [x] `buildWriteHunks(null, newContent)` returns all-`add` lines
      starting at line 1.
- [x] `buildWriteHunks(oldContent, newContent)` delegates to
      `parseDiffHunks`.
- [x] `loadWriteHunksForArgs` reads `args.path` via `node:fs/promises.readFile`,
      captures `ENOENT` as a new-file case (all-`add` hunks), and
      swallows other I/O errors by returning `undefined`.
- [x] `loadWriteHunksForArgs` returns `undefined` for malformed args
      (missing/non-string `path` or `content`, non-object args).
- [x] Defensive: never throws.
- [x] JSDoc on each export documents the contract.

**Verification:**

- [x] `pnpm typecheck` clean.
- [x] `pnpm test tests/host/hunk-diff.test.ts` (Task 2.6) green.

### Task 2.4 — Add `extractFileHunks` pure helper in `display-sink.ts`

**Description:** Implement and export `extractFileHunks(toolName,
args)` in `src/host/display-sink.ts`. Pure function: derives hunks
from `args.edits[]` for `edit`; returns `undefined` for `write`
(caller must supply previous content) and for non-mutating tools.

**Acceptance criteria:**

- [x] `extractFileHunks` exported from `src/host/display-sink.ts`.
- [x] Returns `undefined` for `write`, `read`, `grep`, `find`, `ls`,
      `handoff`, `end`, `ask_user`, and unknown tool names.
- [x] Returns `HunkLine[]` for `edit` with valid `args.edits[]`,
      emitting `del` lines (prefix `-`) followed by `add` lines
      (prefix `+`) for each edit, with sequential line numbers.
- [x] Returns `[]` for `edit` with missing `path`, missing/empty
      `edits[]`, or non-array `edits`.
- [x] Defensive: never throws on malformed `args`.
- [x] JSDoc documents the contract and the `write` `undefined`
      return value (caller's responsibility).

**Verification:**

- [x] `pnpm typecheck` clean.
- [x] `pnpm test tests/host/display-sink.test.ts` (extended in
      Task 2.6) green.

### Task 2.5 — Wire `extractFileHunks` and `loadWriteHunksForArgs` into `session-event-handler`

**Description:** Modify `attachSessionEventHandler` in
`src/host/session-event-handler.ts` to:

1. Extend the `pending` map's entry shape with
   `writeOldContentPromise?: Promise<string | null>`.
2. In `tool_execution_start`, fire-and-forget
   `loadWriteHunksForArgs(event.args)` for `write` tools.
3. In `tool_execution_end`, branch on `event.toolName`:
   - `edit` → synchronously call `extractFileHunks` and emit.
   - `write` → `await` the buffered `writeOldContentPromise` via
     `.then()`, compute `buildWriteHunks(oldContent, args.content)`,
     emit.
   - Others → emit without hunks.
4. Update function-level JSDoc on `attachSessionEventHandler` and
   `onSessionEvent` to note that `tool_result` events may carry
   `files[].hunks`.

**Acceptance criteria:**

- [x] `tool_execution_start` for `write` fires
      `loadWriteHunksForArgs` and stores the promise in the
      `pending` entry.
- [x] `tool_execution_end` for `edit` attaches `hunks` from
      `extractFileHunks` synchronously.
- [x] `tool_execution_end` for `write` attaches `hunks` from
      `buildWriteHunks(oldContent, newContent)` after the buffered
      promise resolves; emission is deferred ~1–5ms.
- [x] `tool_execution_end` for read-only / machine / bash tools
      omits `hunks` (existing Phase 1 contract preserved).
- [x] Errored tool_results (`isError: true`) emit without `files`
      (Phase 1 contract preserved).
- [x] No change to `message_start`, `message_update`, or
      `message_end` branches — text events never carry `files` or
      `hunks`.
- [x] Function-level JSDoc updated on `attachSessionEventHandler`
      and `onSessionEvent`.

**Verification:**

- [x] `pnpm typecheck` clean.
- [x] `pnpm test tests/host/display-forwarding.test.ts` (extended
      in Task 2.6) green.

### Task 2.6 — Add tests

**Description:** Add unit tests for `parseDiffHunks`,
`buildWriteHunks`, `loadWriteHunksForArgs`, and `extractFileHunks`;
extend the existing `display-forwarding.test.ts` with integration
tests for the wired behavior.

**Files:**

- `tests/host/hunk-diff.test.ts` (new) — pure + I/O helper tests
  using `mkdtemp` for filesystem tests.
- `tests/host/display-sink.test.ts` (extend) — pure `extractFileHunks`
  tests.
- `tests/host/display-forwarding.test.ts` (extend) — integration
  tests for the wired behavior with async disk-read deferral.

**Acceptance criteria:**

- [x] `tests/host/hunk-diff.test.ts` exists with table-driven cases:
  - `parseDiffHunks` empty/identical/single-line/multi-line/insertion/
    deletion/multi-edit-block cases.
  - `buildWriteHunks` null-old/non-null-old/empty-new/non-empty-new.
  - `loadWriteHunksForArgs` existing-file (with content),
    non-existent-file (ENOENT → all-`add`), missing-path,
    non-string-path, missing-content, non-string-content,
    non-object-args.
- [x] `tests/host/display-sink.test.ts` has a new
      `describe("extractFileHunks", …)` block:
  - `edit` happy path (single + multiple edits).
  - `edit` missing path / edits / empty edits.
  - `edit` non-string `oldText`/`newText` skipped.
  - `write` returns `undefined`.
  - Read-only / machine / bash / unknown tools return `undefined`.
  - Malformed args return `undefined`.
- [x] `tests/host/display-forwarding.test.ts` has a new
      `describe("DisplayEvent.files[].hunks — issue #13", …)` block:
  - "edit tool_result emits `files[].hunks` synchronously"
  - "write tool_result emits `files[].hunks` after disk read"
  - "write tool_result for new file emits all-`add` hunks"
  - "write tool_result for unreadable path emits no `hunks`"
  - "read/grep/find/ls tool_results never carry `hunks`"
  - "text events never carry `hunks`"
  - For async assertions, await a small `flushPromises()` helper
    (one-line `await new Promise(setImmediate)`).
- [x] Each test asserts the exact `DisplayEvent` shape via
      `toHaveBeenCalledWith` (existing pattern in the file).

**Verification:**

- [x] `pnpm test tests/host/hunk-diff.test.ts` green.
- [x] `pnpm test tests/host/display-sink.test.ts` green (existing +
      new).
- [x] `pnpm test tests/host/display-forwarding.test.ts` green
      (existing + new).
- [x] `pnpm test` (full suite) green.

### Task 2.7 — CHANGELOG and version bump

**Description:** Add the version entry to `CHANGELOG.md` and bump
`package.json` (per Open Question 8: `0.7.0` MINOR vs `0.6.1` PATCH).

**Acceptance criteria:**

- [x] New section at the top of `CHANGELOG.md` (under or replacing
      the current `0.6.0` block, depending on whether 0.6.0 stays
      published or rolls into 0.7.0 — recommend keep 0.6.0 intact,
      add 0.7.0 above).
- [x] Section content matches the template in the "CHANGELOG and
      version bump" subsection above (or the implementer's
      refinement thereof).
- [x] `package.json` `"version"` is `"0.7.0"` (or `"0.6.1"` per
      Open Question 8).

**Verification:**

- [x] `git diff CHANGELOG.md package.json` shows the expected changes.

### Task 2.8 — Run full verification gate

**Description:** Per AGENTS.md "Verification" — confirm all phase
gates are green before declaring Phase 2 done.

**Acceptance criteria:**

- [x] `pnpm typecheck` clean.
- [x] `pnpm build` clean (`dist/` regenerated with new types).
- [x] `pnpm test` all green (no new or pre-existing failures).
- [x] `pnpm lint` (`biome check .`) clean.
- [x] `pnpm format:check` clean.
- [x] `tests/grep-guard.test.ts` passes (Phase 2 only touches
      `src/host/`, which is excluded from the guard; verify anyway).
- [x] `pnpm audit` shows no new high/critical advisories introduced
      by the new `diff@^8.0.2` dep.

## Dependencies

- Phase 1 (issue #12, shipped in v0.6.0) — `TouchedFile` exists with
  `path`, `additions?`, `deletions?`. Phase 2 extends it.
- No external runtime deps beyond the new `diff@^8.0.2` (Task 2.1).
- No upstream changes from pi-coding-agent required — `edit`'s
  result already carries `details: { diff, patch, firstChangedLine }`
  but Phase 2 does not need it (we re-derive hunks from `args`).

## Files likely touched

| File | Change |
|------|--------|
| `package.json` | Add `diff@^8.0.2` to `dependencies`; bump version to `0.7.0` (or `0.6.1`) |
| `pnpm-lock.yaml` | Reflect new dep (committed) |
| `src/host/display-sink.ts` | Add `HunkLine`; extend `TouchedFile.hunks?`; add `extractFileHunks`; update file-level docstring |
| `src/host/hunk-diff.ts` | New — `parseDiffHunks`, `buildWriteHunks`, `loadWriteHunksForArgs` |
| `src/host/session-event-handler.ts` | Extend `pending` entry shape; fire-and-forget file read at `tool_execution_start`; emit hunks at `tool_execution_end` (sync for edit, async for write) |
| `tests/host/hunk-diff.test.ts` | New — pure + I/O helper tests |
| `tests/host/display-sink.test.ts` | Extend — pure `extractFileHunks` tests |
| `tests/host/display-forwarding.test.ts` | Extend — integration tests for wired hunks |
| `CHANGELOG.md` | New `0.7.0` (or `0.6.1`) entry |

## Checkpoint: end of Phase 2

- [x] All Task 2.1–2.8 checkboxes ticked.
- [x] `TouchedFile` extended with `hunks`; `extractFileHunks`
      exported and tested.
- [x] `session-event-handler` attaches `hunks` on successful
      `write`/`edit` tool invocations (deferred emission for
      `write`).
- [x] `diff@^8.0.2` added as a runtime dep; lockfile committed.
- [x] CHANGELOG entry and version bump merged.
- [x] Full verification gate green.

## Out of scope (deferred)

- `bash` tool support (Open Question 1; same as Phase 1).
- Line-count additions/deletions (Open Question 2; same as Phase 1).
- Path normalization (recorded verbatim from args, same as Phase 1).
- `files` / `hunks` on `text` events (intentionally only on
  `tool_result`).
- Renaming `files` to `mutations` (Open Question 3; same as Phase 1).
- Real file-position line numbers for `edit` hunks (would require
  reading the file at `tool_execution_start` for `edit` too;
  deferred per Decision 12).
- Multi-file hunks for a single `edit` call (a single `edit` call
  targets one path; `write` likewise. No multi-file mutations
  possible from the conductor's tools).

## Plan-sufficiency note

This phase is dispatchable in a single, large-scope session (M+ per
task; ~8 tasks, of which 2.3, 2.5, and 2.6 are M+ each). It does not
need a UI designer (no UI changes — the TUI bridge ignores the new
field) or a researcher (no external documentation lookup needed; the
SDK types and `diff` package API are already in `node_modules/`).

The single highest-risk task is **2.5 (wiring)** because of the
async disk-read deferral. Mitigation: Task 2.6 includes explicit
integration tests for both the happy path (file exists with
content) and the error paths (ENOENT, unreadable, missing args).