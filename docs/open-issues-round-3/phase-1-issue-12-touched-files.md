# Phase 1 — Issue #12: RunDeck touched-files in `DisplayEvent`

**Source:** [`../plan.md`](../plan.md); GH issue #12 (`RunDeck: expose
touched-files in display events`, enhancement). Sub-plan for the
architectural + implementation steps.

## Goal

Extend `DisplayEvent` with an optional `files` array so external
consumers (notably RunDeck's `createDisplaySink`) can reconstruct
which files a run touched — with additions/deletions counts — from
the display event stream. Populated by the host when a tool
invocation mutates a file; absent on read-only and machine tools.

This is an **additive** change. Consumers that don't read `event.files`
(the TUI bridge, current `subscribeToRecords` callers) are unaffected.

## What RunDeck needs (from issue #12 body)

RunDeck's run console (`src/server/run-deck/display-sink.ts`)
consumes `DisplayEvent` and re-shapes it into `payload.files` for
its `display` SSE event. The aggregation surface
(`src/lib/run-changes.ts`, `GET /api/runs/:runId/changes`) expects:

```ts
files: Array<{ path: string; additions: number; deletions: number }>
```

attached to `display` events with **last-write-wins** semantics.

The proposed minimal extension (verbatim from the issue):

```ts
interface DisplayEvent {
  readonly role: Role;
  readonly kind: DisplayEventKind;
  readonly text: string;
  readonly files?: ReadonlyArray<{
    readonly path: string;
    readonly additions?: number;
    readonly deletions?: number;
  }>;
}
```

## Spec

### Type changes

**`src/host/display-sink.ts`** — extend `DisplayEvent` with:

```ts
/** A single file mutation observed from a tool invocation. */
export interface TouchedFile {
  readonly path: string;
  /** Char-count of new content introduced by the tool call. */
  readonly additions?: number;
  /** Char-count of content removed by the tool call. */
  readonly deletions?: number;
}

export interface DisplayEvent {
  readonly role: Role;
  readonly kind: DisplayEventKind;
  readonly text: string;
  /**
   * Files touched by a mutating tool invocation. Populated only on
   * successful `tool_result` events for `write` and `edit` (read,
   * grep, find, ls intentionally excluded; `bash` is out of scope
   * for v1 — see plan Open Question 1).
   *
   * `additions` and `deletions` are char-count metrics derived from
   * the tool's args (we don't have pre-write file content for `write`;
   * for `edit`, `oldText` and `newText` per edit are summed). The
   * unit is bytes/chars, not lines — see plan Open Question 2.
   *
   * Optional: consumers that don't need file annotations can ignore
   * the field entirely. `text` and `tool_call` events never carry
   * `files`.
   */
  readonly files?: ReadonlyArray<TouchedFile>;
}
```

### Helper

**`src/host/display-sink.ts`** — new exported helper:

```ts
/**
 * Extract the list of files a tool invocation touched, with optional
 * additions/deletions char-counts. Returns:
 *
 * - `undefined` for non-mutating tools (`read`, `grep`, `find`, `ls`,
 *   the conductor machine tools `handoff`/`end`/`ask_user`, and any
 *   tool name not in `write`/`edit`). Callers use `undefined` to
 *   distinguish "not applicable" from "no files matched."
 * - A (possibly empty) `TouchedFile[]` for `write`/`edit` invocations.
 *   Empty when `args` is missing the expected fields (e.g., an
 *   `edit` call with no `edits` array, or a `write` call without a
 *   `content` field) — caller may choose to emit `files: []` for
 *   diagnostics or omit the field.
 *
 * **Metric unit:** char-count. `write` always reports `deletions: 0`
 * because the previous file content is not in the tool args; only
 * the new content is observable. `edit` sums `oldText.length` /
 * `newText.length` across the `edits[]` array.
 *
 * **Pure function** — no I/O, no SDK coupling beyond the typed
 * `args: unknown` shape. Unit-testable in isolation; does not import
 * from `@earendil-works/pi-coding-agent` (lives in `src/host/`).
 */
export function extractFileMutations(
  toolName: string,
  args: unknown,
): ReadonlyArray<TouchedFile> | undefined;
```

Implementation sketch:

- Switch on `toolName`:
  - `"write"`: `additions = args.content.length`, `deletions = 0`,
    `path = args.path`. Return `[{ path, additions, deletions }]`.
    Return `[]` if `path` is missing or non-string.
  - `"edit"`: iterate `args.edits`; for each `{ oldText, newText }`,
    sum `newText.length` (additions) and `oldText.length` (deletions).
    Return `[{ path, additions, deletions }]` if `path` is present.
    Return `[]` if `path` is missing or `edits` is missing/empty.
  - `"read" | "grep" | "find" | "ls"`: return `undefined`.
  - Conductor machine tools (`handoff`, `end`, `ask_user`) and
    unknown tool names: return `undefined`.
- Defensive parsing of `args` (mirror the patterns in
  `src/host/tool-summary.ts` — `safeString`, `safeArray`,
  `safeNumber` helpers or equivalent). Never throw; never trust
  shape.

### Wiring

**`src/host/session-event-handler.ts`** — modify the
`tool_execution_end` branch (current line ~140-153):

```ts
if (event.type === "tool_execution_end") {
  const summary = pending.get(event.toolCallId);
  pending.delete(event.toolCallId);
  const line = formatToolCompletedLine(summary, event.result, event.isError);
  if (line !== null) {
    // Issue #12: attach `files` for mutating tool invocations on
    // success. `extractFileMutations` returns `undefined` for
    // non-mutating tools; we attach `undefined` (no `files` field)
    // in that case. On error, omit `files` regardless — failed
    // tool calls did not necessarily mutate the workspace.
    const files =
      event.isError ? undefined : extractFileMutations(event.toolName, event.args);
    onDisplay?.({ role, kind: "tool_result", text: line, ...(files !== undefined && { files }) });
  }
  return;
}
```

Wait — `event.toolName` and `event.args` are available on the start
event (already used to build `summary`). They are also available on
the end event (`ToolExecutionEndEvent` carries them per the SDK
type at `node_modules/.pnpm/@earendil-works+pi-coding-agent@*/dist/core/extensions/types.d.ts`).
Using `event.args` on the end event avoids re-reading the buffered
summary's args (the summary is just a string).

Note: the existing handler uses `pending.get(event.toolCallId)` for
the summary, which carries only the formatted one-line text, not
the original args. For `extractFileMutations` we need the raw args.
The end event has `args: any`; use that.

### Tests

**`tests/host/display-forwarding.test.ts`** — extend the existing
"Phase 1 (open-issues-round-2)" suite with a new describe block:

```ts
describe("DisplayEvent.files — issue #12", () => {
  it("attaches files for a successful write tool_result", () => { ... });
  it("attaches files for a successful edit tool_result with multiple edits", () => { ... });
  it("does not attach files for read/grep/find/ls (read-only tools)", () => { ... });
  it("does not attach files for handoff/end/ask_user (machine tools)", () => { ... });
  it("does not attach files for an errored tool_result", () => { ... });
  it("returns an empty array (no `files` field) when args are malformed", () => { ... });
  it("text events never carry files", () => { ... });
});
```

Each case asserts the `files` field's presence/absence on the
emitted `DisplayEvent` shape. Use the existing `makeSession()`
factory pattern (no new test infrastructure needed).

**`tests/host/display-sink.test.ts`** (new) — pure unit tests for
`extractFileMutations`:

- Per-tool behavior (write, edit, read, grep, find, ls, machine
  tools, unknown tools).
- Edge cases (missing `path`, missing `content`, missing `edits`,
  empty `edits`, malformed `args`).
- Additions/deletions math (single edit, multiple edits,
  multi-line edit).

Mirror the table-driven style of `tests/host/tool-summary.test.ts`.

### CHANGELOG and version bump

**`CHANGELOG.md`** — add a new version section (next minor: 0.6.0,
since this is an additive public-type change):

```markdown
## [0.6.0] - YYYY-MM-DD

### Enhancement
- **DisplayEvent carries `files` for file-mutating tools** (issue #12).
  `DisplayEvent` gains an optional `files?: ReadonlyArray<TouchedFile>`
  field, populated by the host on successful `tool_result` events for
  the `write` and `edit` built-in tools. Each `TouchedFile` entry
  carries `path`, `additions`, `deletions` (char-count metrics derived
  from tool args — `write` reports `deletions: 0` since pre-write
  content is not observable). Read-only tools (`read`, `grep`,
  `find`, `ls`) and machine tools (`handoff`, `end`, `ask_user`) never
  populate `files`. `bash` is out of scope for this release. Consumers
  that don't need file annotations can ignore the field; the TUI
  bridge is unchanged. Spec: `docs/open-issues-round-3/phase-1-issue-12-touched-files.md`
  (§"Spec" and §"Tasks").
```

**`package.json`** — bump `"version"` from `0.5.3` to `0.6.0`. The
repo uses `[minor]` bump cadence for additive type changes (per the
changelog history: 0.5.0 added the chunk-streaming feature;
0.5.3 added pre-flight checks; 0.6.0 is consistent with an additive
public-type extension).

## Tasks

### Task 1.1 — Extend `DisplayEvent` with `files` (and `TouchedFile`)

**Description:** Add the `TouchedFile` interface and the optional
`files` field on `DisplayEvent` in `src/host/display-sink.ts`. Update
the file-level JSDoc to note that `files` is the new issue-#12 field
and that read-only tools never populate it.

**Acceptance criteria:**

- [ ] `TouchedFile` interface exported with `path`, `additions?`,
      `deletions?`.
- [ ] `DisplayEvent.files?: ReadonlyArray<TouchedFile>` added.
- [ ] File-level JSDoc updated; references issue #12.
- [ ] No other field changes (additive only — no breaking changes
      to the existing `role`/`kind`/`text` shape).
- [ ] `src/host/index.ts` and `src/index.ts` re-exports unchanged
      (the public type alias already covers all fields).

**Verification:**

- [ ] `pnpm typecheck` clean.
- [ ] `grep -n "files" src/host/display-sink.ts` shows the new
      field declaration.

### Task 1.2 — Add `extractFileMutations` helper

**Description:** Implement and export `extractFileMutations(toolName,
args)` in `src/host/display-sink.ts`. Pure function; no I/O; uses
the same defensive-parsing style as `src/host/tool-summary.ts`
(`safeString`, `safeArray`, `safeNumber`).

**Acceptance criteria:**

- [ ] `extractFileMutations` exported from `src/host/display-sink.ts`.
- [ ] Returns `undefined` for: `read`, `grep`, `find`, `ls`,
      `handoff`, `end`, `ask_user`, and any unknown tool name.
- [ ] Returns `[{ path, additions: number, deletions: 0 }]` for
      `write` with valid `{ path, content }` args.
- [ ] Returns `[]` for `write` with missing `path` or missing
      `content` (graceful degradation).
- [ ] Returns `[{ path, additions: number, deletions: number }]` for
      `edit` with valid `{ path, edits: [{ oldText, newText }, ...] }`,
      summing across `edits[]`.
- [ ] Returns `[]` for `edit` with missing `path`, missing `edits`,
      or empty `edits[]`.
- [ ] Defensive: never throws on malformed `args` (e.g., non-object,
      wrong types). Returns `undefined` or `[]` as appropriate.
- [ ] JSDoc documents the char-count metric choice and the
      `deletions: 0` for `write` limitation.

**Verification:**

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test tests/host/display-sink.test.ts` (Task 1.4) green.

### Task 1.3 — Wire `extractFileMutations` into `session-event-handler`

**Description:** Modify the `tool_execution_end` branch in
`src/host/session-event-handler.ts` to call
`extractFileMutations(event.toolName, event.args)` and conditionally
attach the result to the emitted `DisplayEvent.files` field.

**Acceptance criteria:**

- [ ] `tool_execution_end` branch calls `extractFileMutations`.
- [ ] `files` is attached only when `event.isError === false` AND
      `extractFileMutations` returns an array (non-`undefined`).
- [ ] Use the spread-with-condition pattern (see the
      `ProductionHost` precedent at
      `src/host/production-host.ts:353`) so the field is omitted
      entirely (not set to `undefined`) when not applicable:
      `...(files !== undefined && { files })`.
- [ ] No change to the `tool_execution_start` or `message_end`
      branches — `text` events never carry `files`.
- [ ] Function-level JSDoc on `attachSessionEventHandler` updated to
      note that `tool_result` events may carry `files`.

**Verification:**

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test tests/host/display-forwarding.test.ts` green
      (existing + new cases from Task 1.4).

### Task 1.4 — Add tests

**Description:** Add unit tests for `extractFileMutations` and
integration tests for the wired behavior in `session-event-handler`.

**Files:**

- `tests/host/display-sink.test.ts` (new) — pure helper tests.
- `tests/host/display-forwarding.test.ts` (extend) — integration
  tests on `attachSessionEventHandler`.

**Acceptance criteria:**

- [ ] `tests/host/display-sink.test.ts` exists with table-driven
      cases:
  - `write` happy path → `[{ path, additions: content.length, deletions: 0 }]`.
  - `write` with empty content → `additions: 0`.
  - `write` with missing `path` → `[]`.
  - `write` with non-string `path` → `[]`.
  - `edit` happy path (single edit) → correct additions/deletions
    from `oldText`/`newText`.
  - `edit` happy path (multiple edits) → summed additions/deletions.
  - `edit` with missing `path` → `[]`.
  - `edit` with empty `edits[]` → `[]`.
  - `read` / `grep` / `find` / `ls` → `undefined`.
  - `handoff` / `end` / `ask_user` → `undefined`.
  - Unknown tool name → `undefined`.
  - Malformed `args` (null, array, primitive) → `undefined` or `[]`
    without throwing.
- [ ] `tests/host/display-forwarding.test.ts` has a new
      `describe("DisplayEvent.files — issue #12", …)` block:
  - "attaches files for a successful write tool_result"
  - "attaches files for a successful edit tool_result with multiple edits"
  - "does not attach files for read/grep/find/ls"
  - "does not attach files for handoff/end/ask_user"
  - "does not attach files for an errored tool_result"
  - "does not attach files when args are malformed"
  - "text events never carry files"
- [ ] Each test asserts the exact `DisplayEvent` shape via
      `toHaveBeenCalledWith` (existing pattern in the file).

**Verification:**

- [ ] `pnpm test tests/host/display-sink.test.ts` green.
- [ ] `pnpm test tests/host/display-forwarding.test.ts` green
      (existing + new).
- [ ] `pnpm test` (full suite) green.

### Task 1.5 — CHANGELOG and version bump

**Description:** Add the version entry to `CHANGELOG.md` and bump
`package.json` to `0.6.0`.

**Acceptance criteria:**

- [ ] New section `## [0.6.0] - YYYY-MM-DD` at the top of
      `CHANGELOG.md`.
- [ ] Section content matches the template in the "CHANGELOG and
      version bump" subsection above (or the implementer's
      refinement thereof).
- [ ] `package.json` `"version"` is `"0.6.0"`.

**Verification:**

- [ ] `git diff CHANGELOG.md package.json` shows the expected changes.

### Task 1.6 — Run full verification gate

**Description:** Per AGENTS.md "Verification" — confirm all phase
gates are green before declaring Phase 1 done.

**Acceptance criteria:**

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm build` clean (`dist/` regenerated with new types).
- [ ] `pnpm test` all green (no new or pre-existing failures).
- [ ] `pnpm lint` (`biome check .`) clean.
- [ ] `pnpm format:check` clean.
- [ ] `tests/grep-guard.test.ts` passes (Phase 1 only touches
      `src/host/` and `src/host/` is excluded from the guard, but
      verify anyway).
- [ ] `pnpm audit` shows no new high/critical advisories
      introduced by this change (no new deps).

## Dependencies

- Phase 0 (close #11) should land before Phase 1, so the
  open-issues list reflects reality during the implementation window.
- No external dependencies (no new packages).
- No upstream changes from pi-coding-agent required — the existing
  `ToolExecutionEndEvent` shape (`{ toolCallId, toolName, result,
  isError }`) carries the `toolName`; we read `args` from the same
  event object (already typed as `any`).

## Files likely touched

| File | Change |
|------|--------|
| `src/host/display-sink.ts` | Add `TouchedFile`, `files` field, `extractFileMutations` helper |
| `src/host/session-event-handler.ts` | Wire helper into `tool_execution_end` branch |
| `tests/host/display-sink.test.ts` | New — pure helper tests |
| `tests/host/display-forwarding.test.ts` | Extend — integration tests for the wired behavior |
| `CHANGELOG.md` | New 0.6.0 entry |
| `package.json` | Bump version |

## Checkpoint: end of Phase 1

- [ ] All Task 1.1–1.6 checkboxes ticked.
- [ ] `DisplayEvent` extended with `files`; `extractFileMutations`
      exported and tested.
- [ ] `session-event-handler` attaches `files` on successful
      `write`/`edit` tool invocations.
- [ ] CHANGELOG entry and version bump merged.
- [ ] Full verification gate green.

## Out of scope (deferred)

- `bash` tool support (Open Question 1).
- Line-count additions/deletions (Open Question 2).
- Path normalization (currently recorded verbatim from args).
- `files` on `text` events (intentionally only on `tool_result`).
- Renaming `files` to `mutations` (Open Question 3 — recommend
  `files` for consistency with RunDeck's proposed shape).

## Plan-sufficiency note

This phase is dispatchable in a single, medium-scope session (M per
task; ~6 tasks). It does not need a UI designer (no UI changes —
the TUI bridge ignores the new field) or a researcher (no external
documentation lookup needed; the SDK types are already in
`node_modules/`).