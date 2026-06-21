# Implementation Plan: Active Model in Status/List Output

## What I found

- `runStats(...)` in `src/host/stats.ts` is the shared projection behind `RunHandle.runStats()`, live status, and `/conduct:list`.
- `SessionLifecycleEvent.model` is already persisted on `session_started`; `Checkpoint.active_role_session` already identifies the live role/session file.
- Status and list rendering are pure/local extension formatting paths; no core reducer or persistence shape changes are required.
- Plan-review feedback requested four revisions before implementation: add build verification, make the public `RunStats`/`activeSession` shape explicit, add null/default-model rendering tests or justify coverage, and call out footer-width/model-string length as a deliberate over-budget choice.

## Overview

Add an additive `RunStats.activeSession` projection and render its model in the live status footer and `/conduct:list` only while a same-role active session is running. Preserve all existing output when no active session is present. This is a one-phase observability change; implementation should be small and local.

## Architecture decisions

- Derive active model from existing records only: latest checkpoint + matching `session_started` record.
- Keep `activeSession` optional on the `RunStats` interface for source compatibility with existing external object literals, but require `runStats(...)` and `RunHandle.runStats()` to return `ActiveSessionStats | null` every time.
- Re-export `ActiveSessionStats` through the same public barrels that already expose `RunStats`.
- Render exact model strings with no truncation. This deliberately exceeds the old narrow-footer budget when model names are long; correctness/identity wins for v1.
- Do not change reducer behavior, persisted record schemas, model resolution, or pi session spawning.

## Task list

### Task 1: Add `activeSession` to the host stats projection

**Description:** Extend the public stats surface and implement the pure active-session derivation from existing checkpoint/lifecycle records.

**Acceptance criteria:**

- [x] `src/host/stats.ts` exports `ActiveSessionStats`:
  - `role: Role`
  - `sessionFile: string`
  - `model: string | null`
- [x] `RunStats` includes `readonly activeSession?: ActiveSessionStats | null`.
- [x] `runStats(...)` always returns `activeSession` as an object or `null`.
- [x] `src/host/run-handle.ts`, `src/host/index.ts`, and `src/index.ts` re-export `ActiveSessionStats`.
- [x] Derivation returns `null` for no checkpoint, no active role session, stale role mismatch, or missing matching `session_started`.
- [x] Derivation returns the matching `session_started.model`, including `null` for the system/default model.

**Verification:**

- [x] Add/extend `tests/host/stats.test.ts` cases for declared model, default model (`model: null`), no-active-session, stale transient suppression, and missing `session_started`.
- [ ] Run `pnpm test -- tests/host/stats.test.ts`.
- [x] Run `pnpm typecheck` after export changes.

**Dependencies:** None.

**Files likely touched:**

- `src/host/stats.ts`
- `src/host/run-handle.ts`
- `src/host/index.ts`
- `src/index.ts`
- `tests/host/stats.test.ts`

**Estimated scope:** Medium (5 files).

### Task 2: Render active model in the live status line

**Description:** Update `formatConductStatus(stats)` to insert `model=<...>` only when `stats.activeSession` is present and non-null.

**Acceptance criteria:**

- [x] No active session keeps the existing line exactly unchanged.
- [x] Active declared model renders `model=<provider:id>`.
- [x] Active default/system model renders `model=<default>` when `activeSession.model === null`.
- [x] Long model names are not truncated; the old narrow-footer target is intentionally exceeded when needed.

**Verification:**

- [x] Add/extend `tests/extension/status.test.ts` with declared-model, default-model, explicit `activeSession: null`, and omitted-`activeSession` cases.
- [ ] Run `pnpm test -- tests/extension/status.test.ts`.

**Dependencies:** Task 1.

**Files likely touched:**

- `src/extension/status.ts`
- `tests/extension/status.test.ts`

**Estimated scope:** Small (2 files).

### Task 3: Render active model in `/conduct:list`

**Description:** Update each list line to append `model=<...>` between cost and transition trace only for active sessions.

**Acceptance criteria:**

- [x] No active session keeps existing list formatting exactly unchanged.
- [x] Active declared model renders `<runId> · <state> · running · $<cost> · model=<provider:id> ...`.
- [x] Active default/system model renders `model=<default>` when the matching `session_started.model` is `null`.
- [x] Existing transition trace formatting remains unchanged and follows the model token when both are present.

**Verification:**

- [x] Add/extend `tests/extension/conduct-list.test.ts` with synthetic JSONL cases for declared active model and default active model.
- [x] Preserve/keep no-active empty-history coverage.
- [ ] Run `pnpm test -- tests/extension/conduct-list.test.ts`.

**Dependencies:** Task 1.

**Files likely touched:**

- `src/extension/commands/list.ts`
- `tests/extension/conduct-list.test.ts`

**Estimated scope:** Small (2 files).

### Task 4: Update user-facing docs and run full verification

**Description:** Document the new status/list model token and run the full quality gates, including build verification requested by review.

**Acceptance criteria:**

- [x] `README.md` notes that status/list can show `model=<provider:id>` or `model=<default>` while a role session is active.
- [x] The docs do not claim model is shown for completed, failed, aborted, idle, or inconsistent runs.
- [ ] Plan checkboxes for completed acceptance/verification are ticked only after the implementer actually performs the corresponding work.

**Verification:**

- [x] Run targeted suite: `pnpm test -- tests/host/stats.test.ts tests/extension/status.test.ts tests/extension/conduct-list.test.ts`.
- [x] Run `pnpm typecheck`.
- [x] Run `pnpm build`.
- [x] Run `pnpm test`.
- [x] Run `pnpm lint`.
- [x] Run `pnpm format:check`.

**Dependencies:** Tasks 1-3.

**Files likely touched:**

- `README.md`
- `docs/active-model-status-spec.md`
- `docs/active-model-status/phase-1-active-model-status.md`

**Estimated scope:** Small (docs + verification).

## Checkpoint: Phase 1 complete

- [x] Public type contract is exported and source-compatible.
- [x] Status and list surfaces show exact active model only during active same-role sessions.
- [x] Default-model/null rendering is explicitly tested.
- [x] Existing no-active/completed formatting remains unchanged.
- [x] `pnpm typecheck`, `pnpm build`, targeted tests, full tests, `pnpm lint`, and `pnpm format:check` pass.

## Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Stale model displayed after handoff | User sees previous role's model as current | Require `active_role_session.role === current_role` before rendering. |
| Missing lifecycle record leads to guessed model | Incorrect observability | Return `activeSession: null`; never infer from manifest order. |
| Public `RunStats` test doubles break | External/source compatibility regression | Make `activeSession` optional in the interface; only `runStats(...)` guarantees object-or-null. |
| Footer crowding from long model names | Status line may exceed old narrow target | Deliberate v1 tradeoff; exact identity is more important than truncation. Revisit with a separate UI design if needed. |
| Build declarations omit new type | Consumers cannot import `ActiveSessionStats` | Include barrel exports and run `pnpm build`. |

## Open questions

None blocking.

## Panel feedback addressed

- Build verification: added `pnpm build` to the spec commands, Task 4 verification, and phase checkpoint.
- Public shape: specified `ActiveSessionStats`, `RunStats.activeSession`, object-or-null runtime guarantee, optional interface compatibility, and required barrel re-exports.
- Null/default-model rendering: required explicit tests for `activeSession.model === null` in host stats, status formatting, and list formatting; retained explicit no-active/omitted coverage.
- Footer width: documented exact model rendering as a deliberate over-budget footer choice and listed crowding as an accepted risk/tradeoff.

## Change summary

Revised implementation plan for the active-model status/list spec after plan-review feedback. The plan is intentionally one phase with four small sequential tasks: host projection, status rendering, list rendering, then docs/full verification.
