# Plan — Release 0.5.3 (version bump + changelog reconciliation)

**Type:** release / chore.
**Source:** `docs/release-0.5.3/spec.md`.
**Status:** plan-ready. User decisions on the four open questions are
resolved — see "Resolved decisions" below.
**Scope:** two-file edit (`package.json`, `CHANGELOG.md`), one chore
commit, an annotated `v0.5.3` git tag, and three sequential
`npm publish` calls (overseer runs the publish steps; the plan
documents the order).

## Goal

Move the repo from `0.5.2` (declared in `package.json`) to `0.5.3`,
folding the live `[Unreleased]` section plus the unreleased work
since `ffb1123` (the 0.5.2 bump commit) into a single dated CHANGELOG
entry. No code changes; no test changes; no docs changes.

## Resolved decisions (from overseer, 2026-07-03)

| Open question (spec) | Resolution | Effect on plan |
|---|---|---|
| 1. Skip 0.5.1/0.5.2 on npm, or publish them first? | **Publish in order: 0.5.1 → 0.5.2 → 0.5.3** | Task 7 splits into 7a/7b/7c, each tied to its source commit |
| 2. Tag this release? | **Yes — annotated `v0.5.3` tag** | Task 6 promoted from optional to required |
| 3. CHANGELOG wording for the progressive-text behavior change | **Brief technical summary** | Task 2 wording is fixed as drafted (already technical; removes the conditional alternatives) |
| 4. Version literal — 0.5.3 vs 0.6.0 | **0.5.3 (patch)** | Pre-flight no longer needs a "if 0.6.0" branch; Tasks 2/3 reference `0.5.3` only |

## Pre-flight (read this before Task 1)

- The version literal in this plan is fixed at `0.5.3`. The
  "if 0.6.0" substitution branch from the spec is no longer live.
- No git tags exist in the repo. **This plan adds the first one
  (Task 6).** The convention going forward is `git tag -a vX.Y.Z -m
  "Release vX.Y.Z — see CHANGELOG.md"` for every future chore
  commit. Document this in the team's release-notes (out of scope
  here).
- The two historical bump commits exist on `main` and are reachable:
  `c5c241e` (0.5.1) and `ffb1123` (0.5.2). Each has `package.json`
  pinned at the corresponding version. The overseer's 0.5.1 and 0.5.2
  publishes (Tasks 7a, 7b) check out these commits, run
  `pnpm install --frozen-lockfile`, then `npm publish`, then return
  to `main`.
- `prepublishOnly` runs `pnpm typecheck && pnpm build && pnpm
  test`. The plan runs the same gate as a verification step before
  commit (Tasks 1 and 4) and re-runs it implicitly at each publish
  via `prepublishOnly`. **The plan does not run `npm publish`** —
  that is the overseer's call after the chore commit and tag land.

## Task index

| # | Task | Files | Scope |
|---|------|-------|-------|
| 1 | Verify pre-bump baseline is green | (none — read-only) | XS |
| 2 | Edit `CHANGELOG.md`: replace `[Unreleased]` with `[0.5.3]` dated entry | `CHANGELOG.md` | S |
| 3 | Edit `package.json`: bump version literal | `package.json` | XS |
| 4 | Verify post-edit gates green | (none — read-only) | XS |
| 5 | Single chore commit (tag is Task 6, not part of this commit) | git only | XS |
| 6 | Tag `v0.5.3` (now required per Resolved Decisions) | git only | XS |
| 7a | Publish 0.5.1 from commit `c5c241e` (overseer) | git + npm + secrets | out of plan |
| 7b | Publish 0.5.2 from commit `ffb1123` (overseer) | git + npm + secrets | out of plan |
| 7c | Publish 0.5.3 from main (after tag lands) | git + npm + secrets | out of plan |

## Task 1 — Verify pre-bump baseline

Run the project's full quality gate as listed in AGENTS.md
"Verification":

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

**Acceptance criteria:**

- [ ] All four commands exit `0`.
- [ ] No skip flags used (no `--no-verify`, no `--bail=0`); the gate
      is the gate.

**Why before the edit:** if the gate is already broken on `main`,
the post-edit verification (Task 4) is meaningless. Catching it
now keeps the chore commit the only diff.

**Verification:** command exit codes. If anything fails, stop and
surface to the overseer — this plan only ships clean releases.

## Task 2 — Edit `CHANGELOG.md`

**Description:** Replace the live `[Unreleased]` section with a
dated `## [0.5.3] - 2026-07-03` entry. The new entry captures
**all** user-visible changes since `ffb1123` (the 0.5.2 bump
commit):

- The two entries already in `[Unreleased]` (`#5`, `#6`).
- The two user-reported bugs fixed since (`#8` TUI disjointed,
  `#9` resume context).
- The host-internal deletions (`boundary-flush.ts`,
  `markdown-continuation.ts`) and the new test coverage for
  them (mentioned only briefly; the deletion is not user-
  visible).
- The new `run_seeded` record variant + `RunHandle.originalGoal()`
  seam (additive; mention as a Host driver entry).
- The preflight warning, which is already in `[Unreleased]`.

The test-cleanup hardening (`6361892`) and the OKF deprecation
marks (`c0e412c`) are internal / docs-only and do not appear in the
CHANGELOG. The convention in this repo is to call out behavior
changes and user-visible fixes; internal cleanups live in the commit
log.

**Acceptance criteria:**

- [ ] The `## [Unreleased]` header is **gone**.
- [ ] A new `## [0.5.3] - 2026-07-03` header sits directly above
      `## [0.5.2] - 2026-06-30`.
- [ ] The new section is structured like 0.5.2's — at least
      `### Bug fixes` and `### Host driver` sub-headers; same
      sentence style (lead with a noun, link the issue number with
      `(closes #N)` where appropriate).
- [ ] Every issue that this release closes (`#5`, `#6`, `#8`, `#9`)
      is named in the body of the entry with its number.
- [ ] The `#8` entry explicitly notes the loss of live progressive
      text rendering as a user-visible behavior change. **Wording
      is fixed** (overseer chose the brief-technical style):
      *"Text and thinking content now render as one continuous
      block per assistant turn (`message_end`), not as progressive
      streamed chunks. Tool events remain per-event."*
- [ ] The `#9` entry names the new `run_seeded` record type and the
      `RunHandle.originalGoal()` seam, and notes that pre-existing
      in-flight runs (no `run_seeded`) fall back to the previous
      empty-goal behavior (migration safety).
- [ ] A closing `### Notes` block (matching the style of 0.5.2 and
      0.5.1) calls out:
  - No breaking changes to the public API surface (`src/index.ts`
    barrel is unchanged).
  - The renderer-map shrink (one fewer `conduct.role.*` key) is
    renderer-registry-only, not a library-consumer break.
  - The grep-guard tests continue to pass (no code touched).

**Suggested content block** (the implementer may rephrase, but the
issues cited must remain):

```markdown
## [0.5.3] - 2026-07-03

### Host driver
- **Pre-flight check: warn on unregistered providers** (issue #6,
  commit `44a4397`). At manifest-load time, when a `ModelRegistry`
  is supplied to `loadManifest` / `loadManifestFromString`, an
  advisory `"unregistered-provider"` warning is emitted for each
  `role.models[].entry` pair not registered in pi's runtime
  registry. Surfaced on the extension `/conduct` and `/conduct:resume`
  paths via `ctx.ui.notify` and on the `conduct` CLI via stderr.
  The runtime `ModelNotFoundError` from `spawnRole` is unchanged —
  providers registered by extensions that load after conductor
  (or dynamically) still resolve at use time. Spec:
  `docs/archive/issues-5-and-6/phase-2-provider-preflight.md`.
- **Resume context restores the original goal** (issue #9, commits
  `2145f53` and `566e9ee`). `startRun` now appends a new
  `run_seeded` record to the log immediately after the initial
  `checkpoint_snapshot`; `resumeRun` reads the latest `run_seeded`
  for the run and uses its `goal` as `initialGoal`. New
  `RunHandle.originalGoal(): string` seam surfaces the persisted
  goal for diagnostics. Pre-existing in-flight runs (no
  `run_seeded` record on disk) fall back to the previous
  empty-goal behavior — no regression. Spec:
  `docs/archive/open-issues-round-2/phase-2-issue-9-resume-context.md`.

### Bug fixes
- **Disjointed TUI output** (issue #8, commit `6f962f2`). Text and
  thinking content from a role's assistant turn now render as one
  continuous block in pi's TUI instead of as multiple visually-
  separated chunks. Root cause: pi's `CustomMessageComponent`
  hardcodes a leading `Spacer(1)` per `CustomMessage`, and the
  per-chunk `conduct.role.text_stream` emissions each inserted a
  fresh `CustomMessage` (with its Spacer). Fix: buffer chunks and
  emit exactly one `conduct.role.text` `CustomMessage` per turn
  at `message_end`. The `text_stream` `DisplayEventKind` variant
  is retained internally; the `text_stream` key is removed from
  `ConductMessageKind` and `createConductMessageRenderers`. Tool
  events (`conduct.role.tool`) remain per-event — they are
  atomic. **Behavior change:** live progressive text rendering is
  gone; the role's text and thinking appear all at once at
  `message_end`. Spec:
  `docs/archive/open-issues-round-2/phase-1-issue-8-tui-disjointed.md`.

### Documentation
- **`subscribeToRecords` contract surface** (issue #5). The full
  contract (FIFO ordering, fire-and-forget async, sync-throw and
  async-rejection isolation, re-entrant subscribe/unsubscribe,
  idempotent unsubscribe, empty-set fast path, durable backstop,
  out-of-scope) is documented at `docs/record-emitter-spec.md`
  (~166 lines added). No behavior change.

### Notes
- No breaking changes to the public API surface — `src/index.ts`
  is unchanged. The `subscribeToRecords` / `startRun` / `resumeRun`
  / `listRuns` / `createProductionHost` / `getDefaultBundle`
  exports from 0.5.0 hold. The only renderer-map delta
  (`conduct.role.text_stream` removed) is renderer-registry
  internals; no library consumer is expected to register against
  that customType.
- Two host-internal modules were deleted:
  `src/host/boundary-flush.ts` and `src/host/markdown-continuation.ts`.
  Neither was re-exported from `src/index.ts`. The
  `STREAM_FLUSH_THRESHOLD_CHARS` and `MAX_FLUSH_WINDOW_CHARS`
  constants are gone with them.
- New `PersistedRecord` variant `run_seeded` (host-owned,
  non-machine-event; the reducer never branches on it). Existing
  readers that exhaustively switch on `PersistedRecord.type` need
  a new arm; the project's OOS log (`src/persistence/log.ts:44`)
  is type-driven and in-repo readers are updated.
- The grep-guard test (`tests/grep-guard.test.ts`) and the
  `no-ctx.newSession` / `no-ctx.fork` extension grep guard
  continue to pass — no code outside `src/host/` and
  `src/extension/` (and the corresponding tests) was touched.
```

**Verification:**

- [ ] `git diff CHANGELOG.md` shows: `[Unreleased]` removed, one
      new `[0.5.3] - 2026-07-03` block inserted above the 0.5.2
      block, nothing else changed.
- [ ] No references to `0.5.2` were inserted or removed other than
      the version header rename.
- [ ] The existing `## [0.5.2] - 2026-06-30` header and content
      are byte-identical to their pre-edit state.

**Note on wording style:** The user chose "brief technical
summary" (Open Question 3, option 3a) for the `#8` entry. The
drafted wording above is already in that style — it states the
behavior change in technical terms (single-emit per turn at
`message_end`, removal of `text_stream` key, atomicity of tool
events) without a "user benefit" framing. **Do not rewrite the
`#8` entry to lead with user-facing benefit**; that would
re-introduce a decision the user has already closed.

## Task 3 — Edit `package.json#version`

**Description:** Change `"version": "0.5.2"` to
`"version": "0.5.3"` on line 3 of `package.json`. No other change
to `package.json`. The version literal is locked at `0.5.3`
(Overseer resolved Open Question 4 to the patch).

**Acceptance criteria:**

- [ ] `jq -r .version package.json` prints `0.5.3`.
- [ ] No other key in `package.json` was edited.
- [ ] `git diff package.json` is exactly one line.

**Verification:**

- [ ] `git diff package.json` shows the one-line change.
- [ ] `grep -c '"0.5.2"' package.json` returns `0`.
- [ ] `grep -c '"0.5.3"' package.json` returns `1`.

## Task 4 — Verify post-edit gates green

Re-run the same gate as Task 1:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

**Acceptance criteria:**

- [ ] All four commands exit `0`.
- [ ] `pnpm test` count is the same as Task 1 (no tests added or
      removed; this plan touches no code).
- [ ] `dist/package.json` (from `pnpm build`) reflects the new
      version — verify with `jq -r .version dist/package.json`
      (or read the file directly). This is the version consumers
      will import; it must match the source.

**Verification:** command exit codes and the version literal in
`dist/package.json`.

## Task 5 — Single chore commit

**Description:** Stage the two edited files and commit with the
project's existing bump-and-changelog message style.

```bash
git add CHANGELOG.md package.json
git commit -m "chore: bump to 0.5.3 and update changelog"
```

(The body is intentionally empty — matches `c5c241e` for 0.5.1 and
`ffb1123` for 0.5.2.)

**Acceptance criteria:**

- [ ] `git show --stat HEAD` shows exactly two files changed:
      `CHANGELOG.md` and `package.json`.
- [ ] Commit message is exactly
      `chore: bump to 0.5.3 and update changelog` (one line, no
      body).
- [ ] `git status` is clean after the commit.

**Verification:** `git log -1 --format=%s` matches the message;
`git show --stat HEAD` matches the two-file diff.

## Task 6 — Tag `v0.5.3`

**Now required** — the overseer approved Open Question 2 (option
2a: tag this release). This is the first tag in the repo. The
convention going forward is `git tag -a vX.Y.Z -m "Release vX.Y.Z —
see CHANGELOG.md"` for every future chore commit.

```bash
git tag -a v0.5.3 -m "Release v0.5.3 — see CHANGELOG.md"
```

This task runs **after Task 5 lands the chore commit on `main`** —
the tag points at the commit, not at the working tree. The tag
also serves as the source for the 0.5.3 publish step (Task 7c)
and gives downstream consumers a stable reference for the
release tarball.

**Acceptance criteria:**

- [ ] `git tag --list` includes `v0.5.3`.
- [ ] `git show v0.5.3 --no-patch` shows the chore commit (the
      `chore: bump to 0.5.3 and update changelog` commit from Task 5).
- [ ] `git log v0.5.3..main --oneline` is empty (tag is at HEAD).

## Task 7 — Publish 0.5.1, 0.5.2, then 0.5.3 (overseer-driven)

**Not in scope for this plan** — the agents do not have npm auth
secrets. The overseer runs each publish. The plan documents the
order and the steps so the flow is reproducible.

The user chose option **1a** for Open Question 1: publish 0.5.1
and 0.5.2 (which were historically skipped on npm) **before**
publishing 0.5.3, so the public npm history is monotonic
(`0.5.0 → 0.5.1 → 0.5.2 → 0.5.3`) instead of jumping from
`0.5.0` straight to `0.5.3`.

`prepublishOnly` (`package.json`) runs `pnpm typecheck && pnpm
build && pnpm test` automatically before each publish, so the
gate cannot be skipped at publish time.

### Task 7a — Publish 0.5.1 (from commit `c5c241e`)

```bash
git checkout c5c241e
pnpm install --frozen-lockfile
npm publish   # or `pnpm publish`; `prepublishOnly` gates this
git checkout main
```

At commit `c5c241e`, `package.json` reads `"version": "0.5.1"`
(verified: `git show c5c241e:package.json` line 3).

**Acceptance criteria (overseer confirms):**

- [ ] `git checkout c5c241e` succeeds; working tree is clean.
- [ ] `pnpm install --frozen-lockfile` exits 0 (lockfile is
      consistent with `c5c241e`'s `package.json`).
- [ ] `npm view pi-conductor version` returns `0.5.1` after the
      publish.
- [ ] `git checkout main` returns to the chore-commit HEAD; no
      stray changes left in the working tree.

### Task 7b — Publish 0.5.2 (from commit `ffb1123`)

```bash
git checkout ffb1123
pnpm install --frozen-lockfile
npm publish
git checkout main
```

At commit `ffb1123`, `package.json` reads `"version": "0.5.2"`
(verified: `git show ffb1123:package.json` line 3).

**Acceptance criteria (overseer confirms):**

- [ ] `git checkout ffb1123` succeeds; working tree is clean.
- [ ] `pnpm install --frozen-lockfile` exits 0.
- [ ] `npm view pi-conductor version` returns `0.5.2` after the
      publish (replacing 0.5.1 as the highest).
- [ ] `git checkout main` returns to the chore-commit HEAD.

### Task 7c — Publish 0.5.3 (from main, after Tasks 5 and 6)

```bash
git checkout main
pnpm install --frozen-lockfile
npm publish
```

At `main` after the chore commit and tag, `package.json` reads
`"version": "0.5.3"` and `git describe --tags` returns
`v0.5.3`.

**Acceptance criteria (overseer confirms):**

- [ ] `git describe --tags` returns `v0.5.3`.
- [ ] `pnpm install --frozen-lockfile` exits 0.
- [ ] `npm view pi-conductor version` returns `0.5.3` (the new
      highest).
- [ ] The publish tarball's `package.json` shows `0.5.3` (verify
      with `npm view pi-conductor@0.5.3 dist` or download the
      tarball and read `package/package.json`).

### Why the order matters

Publishing 0.5.3 before 0.5.1 and 0.5.2 would make the npm
history `0.5.0 → 0.5.3` with a hard gap. Two practical issues:

1. `npm install pi-conductor@latest` would resolve to `0.5.3`
   for users who expect `0.5.1` or `0.5.2` content. The
   `0.5.1` / `0.5.2` changelog entries reference commits that
   never shipped on npm, so users on those versions would see
   no npm record of the changelog text.
2. The npm registry shows the publish date as the version's
   release date. Skipping 0.5.1/0.5.2 forever marks them as
   "skipped" in the public record.

Publishing in order keeps the registry honest.

### Dry-run verification (optional)

If the overseer wants a pre-flight dry-run before any of the
three publishes:

```bash
npm publish --dry-run
```

This packs the tarball, prints the file list, and exits without
uploading. The plan adds this only if the overseer requests it —
the `prepublishOnly` gate (typecheck/build/test) provides
sufficient confidence for a clean release.

### Resuming mid-flow (mitigation)

If Tasks 7a or 7b fail mid-stream (network error, registry 500,
auth glitch), the overseer can safely retry from the failing
commit. The registry does not advance to a higher version until
the publish succeeds. After any failure, run:

```bash
git status            # confirm clean (detached HEAD is fine)
git checkout main      # return to main if not already there
```

and re-run the failed task's command. **Do not** advance to the
next publish (7b after a 7a failure; 7c after a 7b failure)
until the previous one succeeds — the registry must see the
versions in monotonic order.

## Checkpoint: end of release

- [ ] `package.json#version` is `0.5.3`.
- [ ] `CHANGELOG.md` `[Unreleased]` is gone; `## [0.5.3] -
      2026-07-03` is in place above the 0.5.2 header.
- [ ] All gates green (Task 1 and Task 4).
- [ ] `dist/package.json` matches `package.json#version`.
- [ ] One chore commit on `main` (Task 5).
- [ ] `v0.5.3` annotated tag exists on the chore commit (Task 6).
- [ ] `npm view pi-conductor version` returns `0.5.1` after
      Task 7a.
- [ ] `npm view pi-conductor version` returns `0.5.2` after
      Task 7b.
- [ ] `npm view pi-conductor version` returns `0.5.3` after
      Task 7c.

## Risks and mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Pre-bump gate is already broken | Low — Task 1 catches it | Task 1 runs the gate before any edits; halt the plan if it fails and surface to the overseer |
| CHANGELOG rephrasing loses a citation (e.g. drops `(closes #N)`) | Low — reviewers may flag | Acceptance criterion: every closed issue `#N` is named in the new section |
| `dist/package.json` lags `package.json` | Low — consumers get stale version | Task 4 verifies `dist/package.json#version` matches the source after `pnpm build` |
| `pnpm install --frozen-lockfile` fails on historical commits 7a / 7b (lockfile drift) | Low — blocks the publish | If `--frozen-lockfile` is too strict for an old commit, fall back to `pnpm install` (matches the pre-`0.6.0` workflow) and document the deviation. Each historical bump commit is a one-file `package.json` edit; lockfile drift is unlikely but possible if pi ecosystem deps moved. |
| Task 7a or 7b fails mid-publish (network / registry 500 / auth glitch) | Low — blocks later tasks | Registry does not advance to a higher version until each publish succeeds. Overseer retries the failing task from the same commit; do not advance to 7b / 7c until 7a / 7b completes successfully. `git status` + `git checkout main` reconciles any detached HEAD. |
| Tag is created on the wrong commit (e.g., before Task 5 lands) | Low — `git describe` would point at the previous bump | Task 6 explicitly says "after Task 5 lands". Acceptance criterion `git log v0.5.3..main --oneline` is empty catches the case where main advanced past the tag. |
| 0.5.1 / 0.5.2 already published by another channel before this plan runs | Low — `npm publish` would refuse a duplicate | `npm view pi-conductor versions --json` before Task 7a; if 0.5.1 or 0.5.2 is already on the registry, skip the matching task. Surface to overseer. |

## Plan-sufficiency note

This plan is dispatchable in a single small session: Tasks 1–6
land the agent-side work (version bump, CHANGELOG edit, gate
verification, chore commit, tag) in XS scope, each. Tasks 7a/7b/7c
are explicitly out of scope for agents — they document the
overseer's three sequential `npm publish` calls, each gated by
`prepublishOnly`. No reviewer pass is required before the chore
commit lands; the existing project gate (`typecheck && build &&
test`, plus `lint` per AGENTS.md) must be green before and after
the edits.