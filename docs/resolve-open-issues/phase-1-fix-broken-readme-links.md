# Phase 1 — Fix broken README links (issue #4)

**Spec authority:** Orchestrator handoff brief (issue #4 body lists the exact broken
links; this phase implements the fix).
**Resolves:** #4

## What I found

Issue #4 is a documentation bug. The reporter (@lynellf, repo owner) identified
broken links in `README.md` after pi moved to a monorepo. Verified findings:

### External links (the repo pi-coding-agent was renamed to earendil-works/pi monorepo)

| Line | Current | Verifies (HEAD) | Fix |
| ---- | ------- | --------------- | --- |
| 27   | `https://github.com/earendil-works/pi-coding-agent` | 404 | `https://github.com/earendil-works/pi` |
| 233  | `https://github.com/earendil-works/pi-coding-agent/blob/main/docs/quickstart.md` | 404 | `https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/quickstart.md` |
| 236  | `https://github.com/earendil-works/pi-coding-agent/blob/main/docs/sdk.md` | 404 | `https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md` |
| 244  | `@earendil-works/pi-coding-agent` package at `docs/quickstart.md` | n/a (prose; update the package name to `@earendil-works/pi` for consistency, keep the in-package path) | `@earendil-works/pi` package at `packages/coding-agent/docs/quickstart.md` |
| 245  | `@earendil-works/pi-coding-agent` package at `docs/sdk.md` | n/a | `@earendil-works/pi` package at `packages/coding-agent/docs/sdk.md` |

Verification of the new external URLs (curl HEAD, 2026-06-30):
- `https://github.com/earendil-works/pi` → 200
- `https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/quickstart.md` → 200
- `https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/sdk.md` → 200

### Internal links (file moved to `docs/archive/` and one was never a real file)

| Line | Current | Verifies on disk | Fix |
| ---- | ------- | ---------------- | --- |
| 81   | `docs/orchestrator-fsm-spec.md` (relative) | file lives at `docs/archive/orchestrator-fsm-spec.md` | update to `docs/archive/orchestrator-fsm-spec.md` (the file was archived; do not move it back) |
| 342  | `docs/record-emitter-spec.md` (relative) | **file does not exist** (no commit in `git log --all` ever created it) | see decision below |
| 405  | `docs/record-emitter-spec.md` (relative) | (same) | (same) |
| 436  | `docs/orchestrator-fsm-spec.md` (relative) | (same as line 81) | (same) |
| 438  | `docs/record-emitter-spec.md` (relative) | (same as line 342) | (same) |
| 485  | `docs/orchestrator-fsm-spec.md` (relative) | (same as line 81) | (same) |

### `docs/record-emitter-spec.md` — decision

The spec file `docs/record-emitter-spec.md` is referenced in four README sections
but was never created. The README prose describes the `subscribeToRecords` API
and a consumer-extension pattern; the implementation is in
`src/host/record-emitter.ts` and a public-API surface is exported from
`src/host/index.ts`. Two options were considered:

- **(a) Create a stub spec.** Work deferred — out of scope for an issue-triage
  PR; would be its own spec doc per AGENTS.md.
- **(b) Repoint to the source file as the authority.** The README's contract
  claims (FIFO, fire-and-forget async, sync-throw / async-rejection isolation,
  re-entrant subscribe / unsubscribe, idempotent unsubscribe, durable backstop)
  are *implementation* properties, not architectural ones. For a triage PR that
  fixes broken links only, repointing to `src/host/record-emitter.ts` (with
  JSDoc pointers where they exist) is the surgical fix.

**Decision: (b).** Replace the four `docs/record-emitter-spec.md` references
with `src/host/record-emitter.ts` (the actual source of truth today). The
follow-up work — a dedicated spec — is filed as a separate enhancement issue
(not in scope for this triage).

## Tasks

- [x] **T1.1** Update `README.md` line 27: link text `[pi]` → URL
      `https://github.com/earendil-works/pi`.
- [x] **T1.2** Update `README.md` line 233: URL → monorepo path
      `https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/quickstart.md`.
- [x] **T1.3** Update `README.md` line 236: URL → monorepo path
      `https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md`.
- [x] **T1.4** Update `README.md` lines 243–245: prose copy —
      - line 243: keep "If those links 404…" sentence; the monorepo path
        (`packages/coding-agent/docs/`) is now the canonical path, so the
        "may be a monorepo at `earendil-works/pi` under `packages/coding-agent/docs/`"
        hedge becomes a positive statement. Simplify to: "The same files ship
        inside the installed `@earendil-works/pi` package at
        `packages/coding-agent/docs/quickstart.md` and `packages/coding-agent/docs/sdk.md`."
      - line 244: `@earendil-works/pi-coding-agent` → `@earendil-works/pi`;
        in-package path → `packages/coding-agent/docs/quickstart.md`.
      - line 245: same, for `sdk.md`.
- [x] **T1.5** Update `README.md` lines 81, 436, 485 (3x): relative path
      `docs/orchestrator-fsm-spec.md` → `docs/archive/orchestrator-fsm-spec.md`
      (the file's current location; do not move it back).
- [x] **T1.6** Update `README.md` lines 342, 405, 438 (3x): relative path
      `docs/record-emitter-spec.md` → `src/host/record-emitter.ts` (the
      implementation is the authority today; a dedicated spec is filed as
      follow-up — see "Triage" in phase 3).
- [x] **T1.7** Spot-check the rendered GitHub Markdown in a PR preview to
      confirm the link list visually resolves.

## Verification

- `git grep -nE 'earendil-works/pi-coding-agent' -- README.md` returns zero
  hits. (The string is also embedded in other prose like the `import` block at
  the bottom; that block imports `@earendil-works/pi-coding-agent` correctly
  and is out of scope here.)
- `git grep -nE 'docs/(orchestrator-fsm-spec|record-emitter-spec)\.md' --
  README.md` returns zero hits (both relative paths removed from the README).
- `git grep -nE 'docs/archive/orchestrator-fsm-spec\.md' -- README.md`
  returns three hits (the canonical new location).
- `git grep -nE 'src/host/record-emitter\.ts' -- README.md` returns four hits
  (the four `record-emitter-spec.md` references, repointed).
- A `pnpm lint` and `pnpm typecheck` pass (README is plain text; no syntax
  gate, but a clean run catches accidental edits to surrounding files).
- Visual PR diff on GitHub shows all green link checkers (or manual
  click-through of each updated link).

## Out of scope

- Creating a `docs/record-emitter-spec.md` (filed as a separate enhancement;
  see phase 3, "Triage actions" → "File follow-up issues").
- Touching the import block / `package.json` peer-dependency declaration
  (`@earendil-works/pi-coding-agent` is the published package name; pi
  re-exports the coding-agent under the monorepo path but the npm package
  retains its original name — that posture is preserved).
- Renaming `docs/archive/orchestrator-fsm-spec.md` back to `docs/` (the file
  was deliberately archived; reversing the move is its own decision and not
  what the reporter asked for).
