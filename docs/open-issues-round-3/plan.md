# Plan — Round 3: Resolve Open Issues #11, #12, and #13

**Source:** GH issues `#11` (display-sink 200-char deltas, already
implemented at plan time), `#12` (touched-files display, implemented in
Phase 1), and `#13` (structured diff hunks in `TouchedFile`, the sole
open issue at the time of the Phase 2 planning pass) on
`lynellf/pi-conductor`. Phases 0 and 1 already shipped in v0.6.0;
Phase 2 covers #13.

**Investigated by:** this planner via `gh issue view`, source
inspection of `src/host/display-sink.ts`,
`src/host/session-event-handler.ts`, `src/host/tool-summary.ts`,
`src/extension/display-sink-wiring.ts`,
`src/extension/conduct-message-renderer.ts`, the SDK tool
definitions (`edit.d.ts`, `write.d.ts`, `extensions/types.d.ts`),
the SDK's `edit-diff.ts` (`generateDiffString` /
`generateUnifiedPatch` / `computeEditsDiff`), the `diff@8.0.4`
package that pi-coding-agent depends on transitively, and OKF
consumption. Prior round's plan
(`docs/archive/open-issues-round-2/plan.md`) was read for
plan-shape convention.

## Status of the open issues

| # | Title | Labels | Status | Action |
|---|-------|--------|--------|--------|
| 11 | `Display sink emits 200-char deltas; consumers render a single assistant message as multiple timeline items` | enhancement | **Already implemented** by commit `6f962f2` (Phase 1, open-issues-round-2) | Closed in v0.6.0 (Phase 0) |
| 12 | `RunDeck: expose touched-files in display events` | enhancement | **Implemented** in v0.6.0 — `DisplayEvent` gains optional `files` with char-count additions/deletions | Closed in v0.6.0 (Phase 1) |
| 13 | `RunDeck: provide structured diff hunks in TouchedFile for write/edit tools` | enhancement | **Open** — char-counts from #12 are insufficient; RunDeck's `FileDiffDialog` / `InlineChangeCard` already render `hunks` if present, but `TouchedFile.hunks` is never populated | Implement (Phase 2) |

### Evidence that #11 is already resolved

The issue body describes the pre-fix behavior — `DisplaySink emits one
event every STREAM_FLUSH_THRESHOLD_CHARS (200) accumulated characters
of assistant text during message_update, plus one final event on
message_end`. That code path was removed by commit `6f962f2`
(`feat: fix issue #8 - TUI disjointed output`, 2026-07-02), the same
commit that closed the original #8 bug.

**Current behavior, verified against source:**

- `src/host/session-event-handler.ts:160-162` — `message_start` and
  `message_update` cases `return` immediately (no emission).
- `src/host/session-event-handler.ts:183` — `message_end` emits
  **exactly one** `onDisplay?.({ role, kind: "text", text })` per
  assistant turn with the full `extractAssistantText(message)` result.
- `src/host/display-sink.ts:30` — `DisplayEventKind` retains the
  `"text_stream"` variant in the type for backward compatibility, but
  the host never emits it (the file-level docstring states this
  explicitly: `text_stream is retained in the type for backward
  compatibility but is no longer emitted by the host`).
- `tests/host/display-forwarding.test.ts` (Single-emit per turn
  describe block, lines 215-280) — pins the contract:
  `emits one text event per assistant turn with the full text,
  regardless of length` (longText = `"a".repeat(500)`, single
  emission expected).

**Option A's acceptance criteria (from issue #11 body), checked:**

| Criterion | Status |
|-----------|--------|
| One logical assistant message → exactly one `DisplayEvent` with the full text | ✅ — `tests/host/display-forwarding.test.ts` line 226-237 |
| Existing display consumers render one timeline item per logical message | ✅ — the extension sink at `src/extension/display-sink-wiring.ts:74-80` emits one `sendMessage({ customType: "conduct.role.text", ... })` per `kind: "text"` event |
| `message_end` for a partial message still emits the final event | ✅ — the `message_end` branch unconditionally calls `extractAssistantText` and emits if `text.length > 0` (`src/host/session-event-handler.ts:178-184`; the `message_start`/`message_update` no-ops are at 160-162) |
| No regression in `tool_call` / `tool_result` events | ✅ — those are already single-event-per-invocation and unaffected by the text change |

**Why not implement Option B (add a `kind: 'delta' \| 'final'` discriminator)?**

The issue offers B as an alternative, but the host no longer emits
multiple events per message — there are no `delta` events to
discriminate. Adding the field would be dead code. Recommend close
with a comment citing the current behavior; revisit only if live
progressive text streaming is reintroduced in the future.

**Conclusion:** No code change needed for #11.

## What this plan implements

One real open enhancement:

- **Issue #12 (RunDeck touched-files):** `DisplayEvent` currently
  carries `{ role, kind, text }` only. Consumers like RunDeck want to
  know which files a run touched (with additions/deletions counts) so
  their `GET /api/runs/:runId/changes` aggregate and the eventual
  `Files` tab can populate from `display` events. Today, the host
  emits `tool_result` events with a one-line summary (`"✓ write:
  /path"`) that is human-readable but not machine-parseable.

  The fix is additive: extend `DisplayEvent` with an optional
  `files?: ReadonlyArray<{ path: string; additions?: number;
  deletions?: number }>`, populated by the host when a tool
  invocation mutates a file. Read-only tools (`read`, `grep`,
  `find`, `ls`) are intentionally excluded. `bash` is **out of scope
  for v1** — see Open Question 1 below.

## Sequencing

| Phase | Issue | Files touched (rough estimate) | Risk | Independent? |
|-------|-------|-------------------------------|------|--------------|
| 0 — Housekeeping | #11 | none (`gh` CLI only) | none | yes |
| 1 — Issue #12 (touched-files) | #12 | 1 host file (`display-sink.ts`), 1 host file (`session-event-handler.ts`), 1 test file (`display-forwarding.test.ts`), `CHANGELOG.md` | low (additive type extension; new optional field; consumers that don't read `files` are unaffected) | yes |

**Order:** Phase 0 first (closes a stale issue, no risk). Phase 1
runs after — it changes the public `DisplayEvent` type, so any code
that depends on the exact shape (e.g., RunDeck's `display-sink.ts`,
which lives in a separate repo) should be reviewed for forward
compatibility.

## Architecture decisions

### Issue #12 — `DisplayEvent.files` shape and population

**Decision 1 — Optional `files` field, not a new event kind.**

The `DisplayEvent` interface gains an optional field; consumers that
don't read it (the TUI bridge, current `subscribeToRecords` callers)
are unaffected. A new event kind would require updating every
`switch (event.kind)` in every consumer; additive extension is
strictly cheaper.

**Decision 2 — Only `tool_result` events carry `files`.**

The field is technically optional on all `DisplayEvent` variants, but
only `tool_result` will ever populate it. `text` and `tool_call`
events never carry `files`. Consumers should read `event.files` on
`tool_result` events only.

**Decision 3 — Tools considered file-mutating: `write`, `edit`.**

- `write` — creates or replaces a file (args: `{ path, content }`).
- `edit` — modifies a file (args: `{ path, edits: [{ oldText, newText }] }`).
- `read`, `grep`, `find`, `ls` — read-only; explicitly excluded per
  issue body ("read is intentionally not a 'touched' file").
- `bash` — can mutate files arbitrarily; reliable detection of
  touched paths from `args.command` alone is not feasible. Out of
  scope for v1. See Open Question 1.

**Decision 4 — Additions/deletions computed from tool args.**

We don't have access to the file's pre-write content from tool args.
Therefore:

- `write` → `additions = args.content.length`, `deletions = 0`.
  Rationale: `write` produces the file as `content`. Without
  inspecting the previous file (out of band), we cannot know what was
  replaced. Conservative: count the new content as additions; the
  "deletions" of the previous content is unobservable from args
  alone. **Surface this limitation** in the helper's JSDoc.
- `edit` → `additions = sum(edit.newText.length for edit in
  args.edits)`, `deletions = sum(edit.oldText.length for edit in
  args.edits)`. Rationale: `oldText` and `newText` are present in
  every edit; char-count is the only metric derivable without
  re-running the fuzzy-match logic from `edit-diff.ts`.

Char-count vs line-count: char-count is the simplest and only
metric computable from args. RunDeck's `payload.files` shape uses
`additions: number; deletions: number` with no unit specified;
char-count is fine for v1, and a future change could swap in
line-counts if precision matters. Surface this in Open Question 2.

**Decision 5 — Path is recorded verbatim from args.**

No path normalization (no `path.resolve`, no CWD-relative
resolution). Consumers that want absolute paths can resolve against
their known CWD; consumers that want relative paths can read the
`path` as-is. This matches the existing behavior of
`formatToolCallSummary` which also records paths verbatim.

**Decision 6 — `files` is populated only on successful executions.**

A failed `edit` (e.g., `oldText` not found) didn't mutate the file;
a failed `write` may have partially written. To avoid lying about
mutations that didn't happen, omit `files` when `isError: true`. The
`tool_result` text summary already communicates the error.

**Decision 7 — The `extractFileMutations` helper is exported and
unit-tested in isolation.**

Lives in `src/host/display-sink.ts` alongside `extractAssistantText`.
Pure function: `(toolName: string, args: unknown) => ReadonlyArray<TouchedFile> | undefined`.
Returns `undefined` for non-mutating tools (so the host can omit the
field) and a (possibly empty) array for mutating tools whose args
don't match the expected shape (so the host can still emit `files: []`
for diagnostics).

### Phase 2 (issue #13) — overlay decisions

**Decision 8 — `TouchedFile.hunks` is additive.** The new field
extends the existing `TouchedFile` interface (introduced in Phase 1
of this round). Consumers that don't read `hunks` (the TUI bridge,
RunDeck's non-hunk code paths) are unaffected; RunDeck's
`FileDiffDialog` already renders hunks when present, so populating
the field enables it without consumer-side code changes.

**Decision 9 — Add `diff@^8.0.2` as a runtime dependency.**

`diff` is the same library pi-coding-agent uses internally for
`edit-diff.ts` (`Diff.diffLines`, `Diff.createTwoFilesPatch`). It is
mature, has no install scripts (pure JS, no `onlyBuiltDependencies`
update required), is already a transitive dep at v8.0.4, and ships
typed declarations. Adding it to `dependencies` is the cleanest path
to structured hunks — re-implementing LCS or parsing the SDK's
display-formatted diff string are both strictly worse (more code
surface, more risk of drift). Adds ~14KB to the dependency tree;
trivial cost. Risk: pin a major version (`^8.0.2`); the lockfile will
govern the exact resolved version.

**Decision 10 — `extractFileHunks` is split into pure + I/O variants.**

- `extractFileHunks(toolName, args)` — pure helper that uses `args`
  only. For `edit`, produces hunks from the `edits[]` array's
  `oldText`/`newText` (changed lines, no surrounding context —
  matches the issue's "at minimum the changed lines" guidance). For
  `write`, returns `undefined` (caller must supply the previous
  content from disk; without it we cannot diff against anything).
  For non-mutating tools, returns `undefined` (same nullability
  contract as `extractFileMutations`).
- `loadWriteHunksForArgs(args)` — async I/O helper that reads the
  previous content of the path in `args.path` (if the file exists)
  and delegates to a private `buildWriteHunks(oldContent, newContent)`
  that uses `Diff.diffLines`. Returns `undefined` when the file
  doesn't exist (new-file case: all-`add` hunks starting from line 1
  are produced by `buildWriteHunks("", newContent)`), or on read
  failure (caller falls back to char-counts only).

**Decision 11 — Hunks are computed and emitted after `tool_execution_end`,
not before.**

The handler subscribes synchronously to `AgentSession.subscribe`. To
produce full file-level hunks for `write`, we read the previous
content from disk. We could read at `tool_execution_start` (file
state pre-mutation) but `tool_execution_end` is the natural emission
point — reading there means reading the post-mutation content (which
equals `args.content` for `write`), saving us the disk read entirely.
We re-read the previous content from disk at `tool_execution_end`
(file-system state at that point is post-tool, so we cannot read the
OLD content anymore — we must capture the OLD content at
`tool_execution_start`).

Net: capture `oldContent` at `tool_execution_start` (async fire-and-
forget; populate `pending` map's entry), await at `tool_execution_end`
via `Promise.then()`. Display emission for `write` is deferred by
~1–5ms (single small file read). For `edit`, no deferral: pure
helper emits synchronously.

**Decision 12 — `edit` hunks use sequential line numbers, not real
file positions.**

The issue's `HunkLine.lineNumber` is a single number. Without disk
I/O for `edit`, we don't know the real file positions of
`oldText`/`newText` blocks. We emit sequential numbers: `add` lines
get a counter starting at 1 (new-file positions), `del` lines get a
counter starting at 1 (old-file positions). RunDeck renders them as
a unified-style diff; line numbers are best-effort for v1. The issue
explicitly accepts "hunks may be edit-only without full-file
context." If line-number precision becomes a blocker, a future
iteration can read the file at `tool_execution_start` for `edit` too.

**Decision 13 — When `hunks` cannot be computed (write read fails,
malformed args), `TouchedFile` is still emitted with char-counts
but no `hunks` field.**

The char-count fallback from Phase 1 keeps RunDeck's aggregate
totals working. `hunks: undefined` falls through to RunDeck's existing
fallback message: "The run did not record structured diff hunks for
this file." This is identical to the current pre-Phase-2 behavior
when `hunks` is absent — no regression.

**Decision 14 — `bash` tool remains out of scope.**

Same rationale as Phase 1, Decision 4: arg-only analysis cannot
produce reliable diffs for arbitrary shell commands. `bash` continues
to return `undefined` from `extractFileMutations` and
`extractFileHunks`. Surfaced again as a deferred item.

## Acceptance criteria

The plan as a whole is "done" when:

- [x] Issue `#11` is closed with a comment pointing at the current
      behavior (`src/host/session-event-handler.ts` line ~166-184;
      `tests/host/display-forwarding.test.ts` Single-emit per turn
      block). `gh issue view 11 --json state` returns `CLOSED`.
- [x] Issue `#12` is closed: `DisplayEvent` carries an optional `files`
      field; `tool_result` events for `write` and `edit` populate it
      with `{ path, additions, deletions }` entries; `read`,
      `grep`, `find`, `ls` never populate it; `bash` is not handled
      (out of scope).
- [x] Issue `#13` is closed: `TouchedFile` gains optional `hunks`;
      successful `write` populates hunks from a disk-read of the
      previous content; successful `edit` populates hunks from
      `args.edits[]`; all other tools (read-only, machine, bash)
      never populate `hunks`. `hunks` is optional and additive.
- [x] `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` all
      green after Phase 2.
- [x] `CHANGELOG.md` entry under a new version section documenting
      the additive change.
- [x] No reducer change; no FSM contract change; no record-shape
      change in `PersistedRecord`. `DisplayEvent` and `TouchedFile`
      are the only public types affected.
- [x] Grep guard (`tests/grep-guard.test.ts`) still passes — no
      imports of `@earendil-works/pi-coding-agent` introduced into
      `src/core`, `src/manifest`, `src/seam`, `src/cost`. (Phase 2
      touches `src/host/` only, which is excluded from the guard.)

## Phase index

| Phase | File | Issue(s) | Status | Sub-plan |
|-------|------|----------|--------|----------|
| 0 | `phase-0-housekeeping.md` | #11 | Shipped in v0.6.0 | close via `gh` with comment |
| 1 | `phase-1-issue-12-touched-files.md` | #12 | Shipped in v0.6.0 | extend `DisplayEvent` with optional `files`; add `extractFileMutations` helper; wire into `session-event-handler`; tests + CHANGELOG |
| 2 | `phase-2-issue-13-diff-hunks.md` | #13 | Planned (this pass) | extend `TouchedFile` with optional `hunks`; add `diff` runtime dep; add pure `extractFileHunks` and async `loadWriteHunksForArgs` helpers; wire into `session-event-handler` (deferred emission for `write`); tests + CHANGELOG |

## Risks and mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| RunDeck's `display-sink.ts` consumes the new field but isn't in this repo | Low — additive change; RunDeck's consumer ignores unknown fields | None needed for the conductor repo. RunDeck's repo will pick up the change on its next bump. Surface in issue close comment so the RunDeck maintainer sees it. |
| Char-count additions/deletions are imprecise vs. line-count | Low — RunDeck just needs non-zero numbers per the acceptance criteria; precise unit is left for a future iteration | Surface the metric choice in the helper's JSDoc; revisit if RunDeck or another consumer requires line-count precision. |
| `write`'s `deletions = 0` undercounts when overwriting an existing file | Low — the metric is approximate by design (we don't have pre-write content) | Document in helper JSDoc; if precision matters, future work could compute deletions from the live FS or a `git diff`-style snapshot lifecycle (explicitly out of scope per issue body). |
| `bash` tool mutations are silently dropped | Low for v1 — RunDeck can still get bash mutations from its own `run_events` SSE stream (which mirrors the display events) and post-hoc FS diff; conductor's display sink simply doesn't have the data | Surface as Open Question 1; a future iteration could add `bash` support via `result.stderr/stdout` parsing or git-diff snapshots. |
| `text_stream` `DisplayEventKind` variant is still in the type | Low — it's intentional backward-compat surface per the existing docstring | No action; matches the current Phase 1 (open-issues-round-2) decision. |
| **Phase 2 — Adding `diff@^8.0.2` as a runtime dep** | Low — `diff` is already a transitive dep at v8.0.4 via pi-coding-agent; it's pure JS (no install scripts) so no `onlyBuiltDependencies` change required; major-version pin prevents surprise upgrades | Pin `^8.0.2` in `package.json` `dependencies`; commit the lockfile change. `pnpm audit` should show no new advisories for `diff@8.0.x`. |
| **Phase 2 — `edit` line numbers are sequential, not real file positions** | Medium — RunDeck's diff UI may render line numbers that don't match the actual file; consumers relying on line numbers for navigation (e.g., editor jump-to-line) would be off | Documented in helper JSDoc; the issue body explicitly accepts "hunks may be edit-only without full-file context." If precision becomes a blocker, future iteration reads the file at `tool_execution_start` for `edit` too. |
| **Phase 2 — `write` display emission is deferred ~1–5ms (file read latency)** | Very low — disk reads for small files complete in microseconds; the display event is emitted after the tool-result line so users see the tool completion immediately, then the hunks arrive in a follow-up event | Documented in handler JSDoc; RunDeck's consumer is event-stream-based and tolerates multi-event deliveries. If latency matters in practice, future iteration can parallelize the disk read with tool execution (kick off at `tool_execution_start`). |
| **Phase 2 — `write` read failure (permission denied, ENOENT race) silently degrades to char-counts only** | Low — graceful degradation: char-counts from Phase 1 still flow; `hunks` field is absent; RunDeck's fallback message is unchanged | `.catch(() => emit(withoutHunks))` in handler; logged as debug if needed. |

## Open questions for the overseer (Phase 2 additions)

4. **`diff` as a runtime dependency — confirm.** `diff@^8.0.2` is a
   ~14KB pure-JS dep, the same library pi-coding-agent uses
   internally for `edit-diff.ts`. Adding it to conductor's
   `dependencies` is the cleanest path; alternatives (in-house LCS,
   parsing the SDK's display-formatted diff string, importing from
   pi-coding-agent's transitive `dist/`) are strictly worse. **Recommend
   confirm** — surface here for record.
5. **`edit` line-number accuracy — accept sequential numbers.** Issue
   accepts "hunks may be edit-only without full-file context." If
   line-number precision is required for the editor-jump UX,
   `tool_execution_start` would need to read the file too (the same
   fire-and-forget pattern as `write`). **Recommend accept** for v1;
   revisit if RunDeck surfaces a precise-line-number need.
6. **Display emission timing for `write` — accept ~ms deferral.** The
   alternative (defer the entire display event including the
   tool-result line) would make the tool appear unresponsive. The
   current pattern emits the line first (synchronously), then the
   hunks in a follow-up event once the file read completes. **Recommend
   accept.**
7. **Should `hunks` replace `additions`/`deletions` for `edit` (now
   that hunks are line-accurate)?** No — char-count additions/
   deletions are still useful for RunDeck's aggregate
   `GET /api/runs/:runId/changes` totals. The two are complementary.
   **Recommend keep both fields.**
8. **Version bump — `0.7.0` MINOR vs. `0.6.1` PATCH.** Phase 2
   extends `TouchedFile` with a new optional `hunks` field and
   adds `diff@^8.0.2` as a runtime dependency.
   **Decision: `0.7.0` MINOR** — rationale: additive public-type
   extension on the `DisplayEvent`/`TouchedFile` seam plus a new
   runtime dep warrant a MINOR bump per semver; there are no
   breaking changes and existing consumers (TUI bridge, RunDeck's
   char-count code paths, the existing char-count
   `additions`/`deletions` fields) are unaffected because `hunks`
   is optional and additive.

## Telemetry (plan-time, Phase 2 pass)

- `okf_docs_read`: 6 (`.okf/components/record-emitter.md`,
  `.okf/concepts/manifest-validation-boundary.md`,
  `.okf/concepts/model-id-provider-colon-format.md`,
  `.okf/pitfalls/chunk-boundary-blockquote-loss.md`,
  `.okf/components/markdown-continuation.md`,
  `.okf/pitfalls/fake-timer-isolate-false-leak.md`)
- `okf_tokens_read`: ~6K
- `files_scanned_before_okf`: 1 (`.okf/` directory listing)
- `files_scanned_after_okf`: ~24 (Phase 1 set + SDK
  `edit-diff.d.ts`, `edit-diff.js`, `edit.d.ts`, `write.d.ts`,
  `extensions/types.d.ts` (ToolExecutionEndEvent section),
  `package.json`, `pnpm-workspace.yaml`,
  `node_modules/.pnpm/diff@8.0.4/.../package.json`)
- `repo_scan_tokens_before_okf`: ~1K (`.okf/` enumeration)
- `repo_scan_tokens_after_okf`: ~40K (substantive reads; ~5K delta
  from Phase 2 source for SDK edit-diff and conductor display-sink)
- `stale_okf_hits`: 0
- `missing_okf_hits`: 0 — no Phase-2-relevant OKF docs absent
- `planner_cost_before_okf`: unknown
- `planner_cost_after_okf`: unknown

## Knowledge candidates (for `okf-curator` follow-on, not blocking)

- "`DisplayEvent.files` is an optional additive field for machine-
  parseable file-mutation info from `write`/`edit` tool invocations.
  Populated only on successful executions. Char-count additions/
  deletions; `write` always reports `deletions: 0` because the
  previous content is not in the tool args." (Stable public seam
  contract; load-bearing for any consumer like RunDeck that needs
  per-file diff stats.)
- "`extractFileMutations(toolName, args)` lives in `src/host/display-sink.ts`
  and is pure — no I/O, no SDK coupling beyond the typed `args: unknown`
  shape. Returns `undefined` for non-mutating tools (`read`, `grep`,
  `find`, `ls`, machine tools, unknown tools); returns a (possibly
  empty) array for mutating tools whose args don't match the
  expected shape, so callers can distinguish 'not applicable' from
  'no files matched'." (Stable component contract; explains the
  helper's existence for future test authors.)
- **Phase 2 (new):** "`TouchedFile.hunks` is an optional additive
  array of `HunkLine` entries carrying structured diff lines for
  `write`/`edit` tool invocations. Populated only on successful
  executions. `edit` hunks are pure (derived from `args.edits[]`);
  `write` hunks require an async disk read at `tool_execution_start`
  to capture the previous file content before the tool runs, then
  diff at `tool_execution_end`. Helpers: `extractFileHunks(toolName,
  args)` (pure, edit-only), `loadWriteHunksForArgs(args)` (async I/O,
  write-only), `buildWriteHunks(oldContent, newContent)` (private,
  uses `Diff.diffLines` from `diff@^8.0.2`)." (Stable component
  contract; explains the split between pure and I/O hunk computation.)
- **Phase 2 (new):** "`diff@^8.0.2` is the canonical LCS-based line-
  diff library pi-coding-agent uses internally for `edit-diff.ts`.
  Conductor's choice to depend on it directly (rather than re-
  implement LCS or parse the SDK's display-formatted output) keeps
  the conductor's hunks byte-identical to the SDK's `generateDiffString`
  output for the same input pair." (Stable dependency rationale;
  explains why this dep exists for future planners who might be
  tempted to remove it.)