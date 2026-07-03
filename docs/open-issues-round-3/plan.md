# Plan — Round 3: Resolve Open Issues #11 and #12

**Source:** GH issues `#11` (enhancement, display-sink 200-char deltas) and
`#12` (enhancement, RunDeck touched-files display) on `lynellf/pi-conductor`,
both opened 2026-07-03 by the repo owner. The orchestrator routed both
issues here after a researcher pass; this planner's job is sequencing,
verification of current state, and spec translation.

**Investigated by:** this planner via `gh issue view`, source inspection
of `src/host/display-sink.ts`, `src/host/session-event-handler.ts`,
`src/host/tool-summary.ts`, `src/extension/display-sink-wiring.ts`,
`src/extension/conduct-message-renderer.ts`, the SDK tool definitions
(`edit.d.ts`, `write.d.ts`, `extensions/types.d.ts`), and OKF
consumption. Prior round's plan
(`docs/archive/open-issues-round-2/plan.md`) was read for plan-shape
convention.

## Status of the two open issues at plan time

| # | Title | Labels | Status at plan time | Action |
|---|-------|--------|---------------------|--------|
| 11 | `Display sink emits 200-char deltas; consumers render a single assistant message as multiple timeline items` | enhancement | **Already implemented** by commit `6f962f2` (Phase 1, open-issues-round-2) | Close with comment (Phase 0) |
| 12 | `RunDeck: expose touched-files in display events` | enhancement | **Open** — `DisplayEvent` carries `{ role, kind, text }` only; no structured file annotations | Implement (Phase 1) |

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

## Acceptance criteria

The plan as a whole is "done" when:

- [ ] Issue `#11` is closed with a comment pointing at the current
      behavior (`src/host/session-event-handler.ts` line ~166-184;
      `tests/host/display-forwarding.test.ts` Single-emit per turn
      block). `gh issue view 11 --json state` returns `CLOSED`.
- [ ] Issue `#12` is closed: `DisplayEvent` carries an optional `files`
      field; `tool_result` events for `write` and `edit` populate it
      with `{ path, additions, deletions }` entries; `read`,
      `grep`, `find`, `ls` never populate it; `bash` is not handled
      (out of scope).
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` all
      green after Phase 1.
- [ ] `CHANGELOG.md` entry under a new version section documenting
      the additive change.
- [ ] No reducer change; no FSM contract change; no record-shape
      change in `PersistedRecord`. DisplayEvent is the only public
      type affected.
- [ ] Grep guard (`tests/grep-guard.test.ts`) still passes — no
      imports of `@earendil-works/pi-coding-agent` introduced into
      `src/core`, `src/manifest`, `src/seam`, `src/cost`. (Phase 1
      touches `src/host/` only, which is excluded from the guard.)

## Phase index

| Phase | File | Issue(s) | Sub-plan |
|-------|------|----------|----------|
| 0 | `phase-0-housekeeping.md` | #11 | close via `gh` with comment |
| 1 | `phase-1-issue-12-touched-files.md` | #12 | extend `DisplayEvent` with optional `files`; add `extractFileMutations` helper; wire into `session-event-handler`; tests + CHANGELOG |

## Risks and mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| RunDeck's `display-sink.ts` consumes the new field but isn't in this repo | Low — additive change; RunDeck's consumer ignores unknown fields | None needed for the conductor repo. RunDeck's repo will pick up the change on its next bump. Surface in issue close comment so the RunDeck maintainer sees it. |
| Char-count additions/deletions are imprecise vs. line-count | Low — RunDeck just needs non-zero numbers per the acceptance criteria; precise unit is left for a future iteration | Surface the metric choice in the helper's JSDoc; revisit if RunDeck or another consumer requires line-count precision. |
| `write`'s `deletions = 0` undercounts when overwriting an existing file | Low — the metric is approximate by design (we don't have pre-write content) | Document in helper JSDoc; if precision matters, future work could compute deletions from the live FS or a `git diff`-style snapshot lifecycle (explicitly out of scope per issue body). |
| `bash` tool mutations are silently dropped | Low for v1 — RunDeck can still get bash mutations from its own `run_events` SSE stream (which mirrors the display events) and post-hoc FS diff; conductor's display sink simply doesn't have the data | Surface as Open Question 1; a future iteration could add `bash` support via `result.stderr/stdout` parsing or git-diff snapshots. |
| `text_stream` `DisplayEventKind` variant is still in the type | Low — it's intentional backward-compat surface per the existing docstring | No action; matches the current Phase 1 (open-issues-round-2) decision. |

## Open questions for the overseer

1. **`bash` tool support — defer or implement now?** The issue body
   says "populated by the host as it processes tool invocations that
   mutate files" without specifying `bash`. The simplest v1 excludes
   `bash` (we can't reliably extract touched paths from `args.command`).
   Options:
   - **A — Defer** (current proposal). `bash` mutations are not
     reported via `files`; consumers rely on post-hoc FS diff or
     `git status`. Lowest complexity.
   - **B — Heuristic via result**: parse `args.command` and
     `result.content[0].text` for path-like tokens. Brittle; many
     false positives.
   - **C — Git-diff snapshots**: track FS state per role session
     (start-of-turn snapshot → end-of-turn snapshot → diff). Most
     accurate but requires new FS I/O and a new persistence concern.
     Issue explicitly says this is "out of scope for this issue."
2. **Additions/deletions unit — char or line?** Issue leaves this
   open. Char-count is the only metric derivable from args. If
   line-count precision matters, we'd need to either (a) use the
   SDK's `generateUnifiedPatch` from `edit-diff.ts` (runtime
   computation, requires the actual file on disk) or (b) implement
   a simple LCS diff over `oldText`/`newText` per edit. Both add
   complexity; recommend defer.
3. **Should the new field be named `files` or `mutations`?** Issue
   proposes `files`. `mutations` is more precise (it conveys "files
   that were changed, with diff stats") and avoids confusion with
   "files attached to the message" or "files in scope." Recommend
   `files` for consistency with RunDeck's proposed shape; surface
   for overseer review.

The phase docs include a Task 0 for each question that lands the
answer.

## Telemetry (plan-time)

- `okf_docs_read`: 6 (`.okf/components/record-emitter.md`,
  `.okf/concepts/manifest-validation-boundary.md`,
  `.okf/concepts/model-id-provider-colon-format.md`,
  `.okf/pitfalls/chunk-boundary-blockquote-loss.md`,
  `.okf/components/markdown-continuation.md`,
  `.okf/pitfalls/fake-timer-isolate-false-leak.md`)
- `okf_tokens_read`: ~6K
- `files_scanned_before_okf`: 1 (`.okf/` directory listing)
- `files_scanned_after_okf`: ~18 (`src/host/display-sink.ts`,
  `src/host/session-event-handler.ts`, `src/host/tool-summary.ts`,
  `src/host/tool-wrapper.ts`, `src/host/seam.ts`,
  `src/host/index.ts`, `src/extension/display-sink-wiring.ts`,
  `src/extension/conduct-message-renderer.ts`,
  `src/extension/commands/start.ts`, `src/extension/commands/resume.ts`,
  `extensions/conduct.ts`, `src/host/production-host.ts`,
  `src/host/production-host-factory.ts`, `src/index.ts`,
  `tests/host/display-forwarding.test.ts`,
  `tests/extension/tui-bridge.test.ts`, `tests/extension/conduct-message-renderer.test.ts`,
  pi SDK `edit.d.ts`, `write.d.ts`, `extensions/types.d.ts`,
  `docs/archive/open-issues-round-2/{plan,phase-0-housekeeping,phase-1-issue-8-tui-disjointed}.md`,
  `CHANGELOG.md`, `package.json`, `biome.json`, `lefthook.yml`)
- `repo_scan_tokens_before_okf`: ~1K (`.okf/` enumeration)
- `repo_scan_tokens_after_okf`: ~35K (substantive reads)
- `stale_okf_hits`: 0
- `missing_okf_hits`: 0
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