# Spec — Release 0.5.3

**Type:** release / chore.
**Date drafted:** 2026-07-03.
**Source:** orchestrator handoff flagged drift (`npm@0.5.0`, repo at
`0.5.2` with unreleased work). Researcher confirmed. This spec
describes the next version bump and the changelog reconciliation.

## What I found (investigation)

### State of the world

- `package.json` declares `"version": "0.5.2"`. No `package.json` /
  `pnpm-lock.yaml` changes in `ffb1123..HEAD` (verified with
  `git diff --stat ffb1123 HEAD -- package.json pnpm-lock.yaml` —
  empty).
- `CHANGELOG.md` carries three released headers — `0.5.0`
  (2026-06-24), `0.5.1` (2026-06-26), `0.5.2` (2026-06-30) — plus a
  live `[Unreleased]` section. The Unreleased section was created on
  2026-06-30 (commit `cbef5b39`, the #1–#4 triage) and received two
  entries on 2026-07-01 (commit `44a4397`): the `#6` unregistered-
  provider warning (host driver) and the `#5` `subscribeToRecords`
  contract surface note (documentation). Verified with
  `git blame CHANGELOG.md`.
- **No git tags exist** in the repo (`git tag --list` is empty).
  Released versions are identified by their `chore: ...` commits
  (`ffb1123` for 0.5.2, `c5c241e` for 0.5.1, `9b51e79` for 0.5.0)
  and by the `[x.y.z]` headers in `CHANGELOG.md`.
- The published surface on npm is **0.5.0**. The repo has shipped
  past that (0.5.1 and 0.5.2 are in the CHANGELOG and the code) but
  no commit / tag / publish flow landed for either intermediate
  version. The drift is real and unresolved.

### Commits and CHANGELOG gap since 0.5.2

`git log --oneline ffb1123..HEAD` shows seven commits:

| SHA | Subject | Captured in CHANGELOG? |
|---|---|---|
| `b6f6f8f` | Merge PR #10 | (merge) |
| `44a4397` | feat: add model registry support for provider registration checks | **yes** (Unreleased → Host driver) |
| `8a0d0b9` | Merge PR #7 | (merge) |
| `6f962f2` | feat: fix issue #8 — TUI disjointed output | **no** |
| `2145f53` | feat: fix issue #9 — resume context restores original goal | **no** |
| `566e9ee` | feat: implement Phase 2 Issue #9 — persist original run goal on resume | **no** (paired with #9) |
| `6361892` | fix: harden test cleanup for fake-timer isolation across files | **no** |
| `c0e412c` | feat: mark markdown continuation and chunk-boundary blockquote loss components as deprecated | **no** (OKF-only) |

Two bugs reported by the repo owner on 2026-07-02 (`#8`, `#9`) plus
the `44a4397` preflight warning and a test-cleanup hardening landed
since the last bump. The `[Unreleased]` section is partially stale:
it covers only `#5` / `#6` and does not yet cover `#8`, `#9`, the
test cleanup, or the OKF deprecations.

### Scope and blast radius

- Two production-source files change: `package.json` (one number)
  and `CHANGELOG.md` (one section move + content additions).
- No code changes; no test changes; no docs changes; no
  `src/host/`, `src/extension/`, `src/core/`, `src/manifest/`,
  `src/seam/`, `src/cost/`, `src/persistence/` touches. The grep
  guards (`tests/grep-guard.test.ts`, the extension grep guard)
  cannot regress because this release does not touch code at all.
- The `prepublishOnly` script in `package.json` runs
  `typecheck && build && test`, so any accidental code-touch in
  scope creep would be caught at the gate.

## Decision: version bump → 0.5.3 (patch)

**Recommended:** `0.5.2 → 0.5.3` (patch).

Rationale, scored against the actual changes:

1. **No public API break.** `src/index.ts` barrel is unchanged. The
   `subscribeToRecords` / `startRun` / `resumeRun` / `listRuns` /
   `createProductionHost` / `getDefaultBundle` surface from 0.5.0
   holds; only the bodies behind it move (resume now reads the
   persisted goal; new `run_seeded` record is appended; preflight
   emits warnings when a `ModelRegistry` is supplied).
2. **`ConductMessageKind` shrinks; renderer map shrinks.** The
   `conduct.role.text_stream` key was removed from
   `createConductMessageRenderers` and the `text_stream` variant
   was removed from `ConductMessageKind`. These are renderer-registry
   entries, not part of `src/index.ts`. No third-party consumer is
   expected to register against these customTypes (the renderer map
   is registered once inside `extensions/conduct.ts`); a future
   conductor extension would call `createConductMessageRenderers`
   itself and observe only the post-fix keys.
3. **Host-internal removals.** `src/host/boundary-flush.ts` and
   `src/host/markdown-continuation.ts` were deleted. They were
   host-internal (per the AGENTS.md grep-guard posture for
   `src/host/`) and not re-exported from `src/index.ts`. Library
   consumers cannot reach them.
4. **`RunHandle.originalGoal()`** is additive. The seam surfaces the
   persisted goal for diagnostics; no existing caller needs to
   change.
5. **`PersistedRecord` union grew.** `RunSeededRecord` is a new
   host-owned, non-machine-event variant. The reducer never
   branches on it. Disk-log readers that exhaustively switch on
   `PersistedRecord.type` would need a new arm, but the project
   uses an OOS / type-driven log (see `src/persistence/log.ts:44`);
   in-repo readers are exhaustively updated by the same commit
   series that introduced the variant.

All five points argue for a **patch** under semver 2.0.0: bug
fixes (#8, #9), additive features (`originalGoal()`, `run_seeded`,
the preflight warning), internal cleanups (the two deleted modules,
the OKF deprecations). Nothing crosses the `src/index.ts` boundary.

**Alternative considered — 0.6.0 (minor).** Would be defensible if
the `text_stream` removal is read as a user-visible regression
("progressive text typing is gone"). The CHANGELOG should call this
out regardless of version so the user can decide whether to upgrade.
If the reviewer / overseer prefers 0.6.0, the only mechanical
change in this plan is the version literal; everything else is
identical.

## Out of scope for this release

- **Publishing to npm.** The repo has no `npm publish` workflow and
  no secrets wired. `prepublishOnly` runs `typecheck && build &&
  test`, but the actual `npm publish` call is the overseer's call.
  This plan prepares the artifacts; publishing is the next step
  after review.
- **Tagging.** No tags exist in the repo for any prior release. If
  the overseer wants tags starting with this release, the plan
  adds a tagging task; otherwise the commit message is the
  identifier (the project's existing convention).
- **Reconciling 0.5.1 and 0.5.2 on npm.** Those versions are in
  `CHANGELOG.md` and the code but were never published. Going
  straight to 0.5.3 is the most pragmatic fix for the drift; the
  CHANGELOG entry for 0.5.3 will summarize what landed since 0.5.2
  (the new work). 0.5.1 and 0.5.2 stay as dated headers with their
  original content; if the overseer prefers to publish them in
  order, see Open Question 1 below.
- **Closing GH issues `#8` and `#9`.** Both fixes are merged on
  `main`. The `gh issue close … --reason completed` call is a
  housekeeping step, owned by the implementer of this plan or the
  overseer; it does not block the version bump.

## Open questions — resolved 2026-07-03

The four open questions below were surfaced to the overseer via
`ask_user`. The user's selection was **option index "1a + 2a + 3a +
4"** (publish 0.5.1/0.5.2 first, tag the release, brief technical
wording, version 0.5.3 patch). The plan at
`docs/release-0.5.3/plan.md` reflects these resolutions in its
"Resolved decisions" table.

1. **Skip 0.5.1 / 0.5.2 on npm, or publish them first?**
   **Resolved: publish in order** — 0.5.1 first (from commit
   `c5c241e`), then 0.5.2 (from commit `ffb1123`), then 0.5.3
   (from main after the chore commit and tag land). Rationale
   recorded in plan §"Why the order matters" — keeps the public
   npm history monotonic and avoids a hard `0.5.0 → 0.5.3` gap.
2. **Tag this release?**
   **Resolved: yes.** `git tag -a v0.5.3 -m "Release v0.5.3 —
   see CHANGELOG.md"` runs immediately after the chore commit
   lands. This is the first tag in the repo; the convention is
   `vX.Y.Z` annotated tags for every future chore commit.
3. **Should the 0.5.3 CHANGELOG entry call out the loss of live
   progressive text rendering?**
   **Resolved: yes, with brief technical wording.** The `#8`
   entry in Task 2 of the plan uses the technical phrasing the
   spec draft already proposed: *"Text and thinking content now
   render as one continuous block per assistant turn
   (`message_end`), not as progressive streamed chunks. Tool
   events remain per-event."* No "user benefit" framing — that
   option (3b) was rejected.
4. **Version literal — 0.5.3 vs 0.6.0.**
   **Resolved: 0.5.3 (patch).** Consistent with the spec's
   default. The "if 0.6.0" substitution branch in the plan's
   pre-flight is removed; the version literal is locked at
   `0.5.3`.

## Acceptance criteria

The release is "done" when:

- `package.json#version` reads `"0.5.3"`.
- `CHANGELOG.md` has a `## [0.5.3] - 2026-07-03` header whose
  content captures all user-visible changes since
  `## [0.5.2] - 2026-06-30`. The previous `[Unreleased]` section is
  removed (its entries fold into 0.5.3 or, for the `#5` doc note,
  are noted as already covered by the spec file's existence).
- `pnpm typecheck && pnpm build && pnpm test` are green (the
  `prepublishOnly` script asserts this; running it locally before
  commit is the verification).
- `git grep "0\.5\.[02]" -- package.json` returns zero hits;
  `grep -rn "0\.5\.2" README.md` returns the same (no stale version
  literal in user-facing docs).
- The single commit message matches the project's existing pattern:
  `chore: bump to 0.5.3 and update changelog` (matches
  `c5c241e` for 0.5.1).

## Telemetry (planner)

- `okf_docs_read`: 1
  (`.okf/concepts/manifest-validation-boundary.md` — checked to
  confirm the preflight entry in the existing Unreleased section
  was correctly scoped; the other `.okf/` docs were touched only
  by `c0e412c` / `6361892` since 0.5.2 and are not directly
  load-bearing for this release)
- `okf_tokens_read`: ~3K
- `files_scanned_before_okf`: 1 (`.okf/` directory listing)
- `files_scanned_after_okf`: 9 (`package.json`, `CHANGELOG.md`,
  two archive plan docs for context, `git log` output, three
  commit `git show` outputs for diff size, `git blame CHANGELOG.md`
  to verify when entries landed, `git tag --list` to confirm no
  tags, `git diff --stat` to confirm no package.json changes since
  the 0.5.2 bump)
- `repo_scan_tokens_before_okf`: ~unknown
- `repo_scan_tokens_after_okf`: ~25K
- `planner_cost_before_okf`: unknown
- `planner_cost_after_okf`: unknown
- `stale_okf_hits`: 0
- `missing_okf_hits`: 0

## Knowledge candidates (for `okf-curator` follow-on, not blocking)

- "Release cadence in this repo is implicit — no `npm publish`
  workflow, no tags, no CI publish job. Version bumps are paired
  `package.json` + `CHANGELOG.md` edits landed as `chore: bump
  to x.y.z and update changelog` commits. The published-npm
  version can lag the repo by several patch levels; reconciling
  the drift is a manual chore-and-publish step, not an automated
  gate." (Stable release-process fact; useful for the next
  drift-detector the orchestrator dispatches.)
- "Release-bump pattern: when moving `[Unreleased]` into a dated
  header, fold in any commits since the previous bump that are
  not yet captured. Cover user-visible behavior changes, not
  internal cleanups (test-cleanup, OKF doc-only updates)." (Stable
  CHANGELOG-discipline fact.)