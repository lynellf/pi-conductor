# Phase 2 — Issue #9: Agent roles confused when resuming

**Source:** [`../plan.md`](../plan.md); GH issue #9 (`Agent roles are
confused when resuming a session`, bug). Sub-plan for the
architectural + implementation steps.

## Goal

When a user runs `/conduct:resume <run_id>`, the orchestrator session
that re-engages after a worker handoff must see the **original run
goal** in the run-memory artifact (`RunMemory.goal`). Today the goal
field is empty (`""`) on resume because
`src/extension/commands/resume.ts:111` passes `goal: ""` to
`resumeRun`. The orchestrator LLM therefore has no statement of what
the run was originally trying to accomplish, and produces confused
behavior when re-engaging after a worker handoff.

## What the user reported

> "Is any context of a prior run provided as an event payload when
> resuming runs? If we're unable to provide context from the
> telemetry stored on disk, we should correct that."

The user is asking two questions:

1. *Is any prior-run context being passed?* — Yes: `last_message`
   (`from`, `text`, `suggests_next`), `visit_history`, `per_role_cost`,
   `run_cost_to_date`, `remaining_budget`, `next_candidates`. The
   run-memory builder reads these from persisted records via
   `buildRunMemory` (`src/core/run-memory.ts:135`). However, the
   `goal` field is empty on resume.
2. *If unable, correct it.* — We *are* able (records are stored on
   disk); the gap is the empty `goal` field. The fix is to surface the
   original goal at resume time.

## Root cause (verified)

`src/extension/commands/resume.ts:111` passes `goal: ""` to
`resumeRun`. The loop at `src/host/loop.ts:265–277` constructs the
seed for each orchestrator session via
`formatRunMemorySeed(runMemory)` (`src/host/run-memory.ts:84`), which
includes the `goal` field from `memory.goal`. `memory.goal` is set in
`buildRunMemory` from `opts.goal`
(`src/core/run-memory.ts:106`), which is `opts.initialGoal`, which is
the `goal` argument to `startRun` / `resumeRun`. On
`/conduct:resume`, that argument is `""`.

The spec explicitly disclaims the goal on resume
(`src/extension/commands/resume.ts:84–88`):

> "Resume does not carry a goal (the run's existing checkpoint +
> run memory are the seed); the goal arg to resumeRun is used only
> if the resume path needs a fresh prompt."

The spec assumes the original goal flows through the run memory, but
the run memory reads `goal` from the constructor argument every
time — never from the persisted records.

## Design decisions (must be confirmed before Task 2.1 lands)

### Decision 1 — Persist the goal as a new `PersistedRecord` variant

**Recommendation:** Add `"run_seeded"` to the `PersistedRecord` union
in `src/persistence/log.ts:44`. The record is host-owned and
non-machine-event (the reducer never inspects it), analogous to
`"checkpoint_snapshot"` (a host-owned, non-machine-event record
wrapping run-level data). At `startRun` time, the host appends one
`run_seeded` record immediately after the initial
`checkpoint_snapshot`. At `resumeRun` time, the host reads the latest
`run_seeded` for the run and uses its goal as `initialGoal`.

**Record shape:**

```ts
interface RunSeededRecord {
  readonly type: "run_seeded";
  readonly run_id: string;
  readonly goal: string;
  readonly ts: number;
}
```

**Wiring:**

- `startRun` (`src/host/api.ts:75`) calls `loaded.persistSeed`, which
  appends a `run_seeded` to the log. Order: initial
  `checkpoint_snapshot` → `run_seeded` → first transition.
- `resumeRun` (`src/host/api.ts:180`) reads `log.latestRunSeed(runId)`
  to recover the goal. Absent (a run started before this change
  shipped) → fall back to `""` (existing behavior; no regression for
  in-flight runs).
- The orchestrator session seeded by the loop sees the goal in the
  run memory, exactly as today, with one difference: the goal is now
  non-empty on resume.

**Why this shape, not a `Checkpoint` field:**

- `Checkpoint` is a frozen, append-only snapshot (`spec §11.1`).
  Adding a required field breaks every existing in-flight run's
  snapshot schema; making it optional branches every reader. The
  record-form keeps the snapshot untouched.
- Mirrors the existing `checkpoint_snapshot` precedent — host-owned
  metadata that the reducer never sees, lives in the same log, uses
  the same append-only contract.
- The host-agnostic core (the reducer at `src/core/`) does not need
  any change. `buildRunMemory` already accepts `opts.goal`
  (`src/core/run-memory.ts:106`); we only change where the value
  comes from on resume.

**Migration safety:**

- Old runs without a `run_seeded` record: `latestRunSeed(runId)`
  returns `null`; `resumeRun` falls back to `""` (today's behavior).
  No regression for users with pre-existing in-flight runs.
- New runs after the change: a `run_seeded` is always appended at
  start.

### Decision 2 — Should the extension allow overriding the goal on resume?

**Recommendation:** Not in this round. The
`ResumeRunOptions.goal` parameter stays in the API (it's already
present); the extension always passes `""`. A future
`/conduct:resume <run_id> --goal <text>` could give the user a way
to redirect the orchestrator at resume time, but that is a different
UX change and out of scope. Surface this as a follow-up.

**Trade-off surfaced (overseer sign-off requested):** the
`ResumeRunOptions.goal` arg becomes effectively cosmetic for now; if
the user-supplied goal is ever non-empty in the future, the loop
should use it in preference to the persisted `run_seeded`. Defer the
precedence rule.

### Decision 3 — Should `RunHandle` expose the persisted goal?

**Recommendation:** Add a `RunHandle.originalGoal(): string` method
that reads the latest `run_seeded` from the log. The handle is the
canonical seam for "things about this run"; the extension can call
`handle.originalGoal()` for diagnostics, status-line display, or any
future UX that wants to show the original goal without walking the
log itself.

**Acceptance criteria:**

- [ ] `RunHandle.originalGoal()` returns the string from the latest
      `run_seeded` record (or `""` if absent).
- [ ] The handle's existing surface (`loadedManifest`, `completion`,
      `runConfig`, `abort()`) is unchanged.

## Sub-tasks (after Decision 1 sign-off)

### Task 2.1 — Add `run_seeded` to the `PersistedRecord` union

**Description:** Add the type alias for `RunSeededRecord` in
`src/persistence/log.ts` (or `src/core/types.ts` per the project's
host-agnostic convention for record shapes) and union it into
`PersistedRecord`. Ensure every existing
`PersistedRecord.type`-switch is updated (`src/persistence/log.ts` —
the `InMemoryRecordLog.append` routing already supports non-checkpoint
records via `run_id`).

**Acceptance criteria:**

- [ ] `PersistedRecord` includes the new variant.
- [ ] `InMemoryRecordLog.append` accepts the new variant (no schema
      change to its routing logic).
- [ ] `FileRecordLog` accepts the new variant on disk (verify the
      JSONL writer is type-driven by `PersistedRecord`; if it
      dispatches by `type`, add the new branch).
- [ ] `grep -r "PersistedRecord" src/core` confirms the core does not
      import the new variant — the host owns it.

**Verification:**

- [ ] `pnpm typecheck` green.
- [ ] `pnpm test -- persistence` green.

**Dependencies:** None.

**Files likely touched:**

- `src/persistence/log.ts` (record type + union).
- `src/host/log-file.ts` (verify JSONL write handles the variant).
- Maybe `src/core/types.ts` if record shapes live there.

**Estimated scope:** S.

### Task 2.2 — `RecordLog.latestRunSeed(runId): string | null`

**Description:** Add a method to the `RecordLog` interface returning
the latest `run_seeded.goal` for the run (or `null`). Pure over the
log; no reducer involvement. Implement in both `InMemoryRecordLog`
(reverse walk — same pattern as `latestCheckpoint`) and `FileRecordLog`.

**Acceptance criteria:**

- [ ] New method on the `RecordLog` interface.
- [ ] Both implementations return the latest `run_seeded.goal` for
      the run, or `null` if no record exists.
- [ ] Returns `null` for runs that pre-date the change (no
      `run_seeded` records).
- [ ] Walk is O(n) over the run's records (acceptable; runs are
      bounded).

**Verification:**

- [ ] Unit tests pin the contract: latest record wins on multiple
      seeds (defensive — `startRun` only seeds once, but the API
      contract holds); no record → `null`; not-found runId → `null`.

**Dependencies:** Task 2.1.

**Files likely touched:**

- `src/persistence/log.ts` (interface + `InMemoryRecordLog` impl).
- `src/host/log-file.ts` (`FileRecordLog` impl).
- `tests/persistence/log.test.ts` (new case).

**Estimated scope:** S.

### Task 2.3 — `startRun` writes a `run_seeded`; `resumeRun` reads it

**Description:** Modify `src/host/api.ts` so:

- `startRun` appends a `run_seeded` record right after the initial
  `checkpoint_snapshot`. The record carries `run_id`, `goal:
  opts.goal`, `ts: Date.now()`.
- `resumeRun` reads `log.latestRunSeed(runId)`. If non-null, pass it
  as `goal` to `runWithCompletion`. If `null`, pass `opts.goal`
  (which today is `""`); this preserves existing behavior for runs
  started before this change shipped.

**Acceptance criteria:**

- [ ] `startRun(manifest, { goal: "fix the bug" })` produces a
      `run_seeded` record in the log with `goal: "fix the bug"`.
- [ ] `resumeRun(manifest, runId, { goal: "" })` restores `goal`
      from the log (verified via the run memory seed that the
      orchestrator session receives).
- [ ] `resumeRun` on a run that has no `run_seeded` record does not
      throw; the loop receives `goal: ""` (existing behavior).

**Verification:**

- [ ] End-to-end test in `tests/host/resume.test.ts`:
  - `startRun` with `goal: "fix the bug in foo.ts"`.
  - Drive the orchestrator → worker → orchestrator cycle.
  - Kill the run mid-worker (or just stop).
  - `resumeRun` with `goal: ""`.
  - Inspect the run-memory seed the orchestrator session receives
    on its next visit. The seed's `goal:` line is
    `"fix the bug in foo.ts"`, not empty.
- [ ] Migration test: build a `FileRecordLog` directly with no
  `run_seeded` record, then `resumeRun` does not throw and uses
  `""`.

**Dependencies:** Tasks 2.1, 2.2.

**Files likely touched:**

- `src/host/api.ts` (startRun, resumeRun).
- `tests/host/resume.test.ts` (new cases).

**Estimated scope:** M (1–3 host files + tests).

### Task 2.4 — `RunHandle.originalGoal()`

**Description:** Add the new method per Decision 3. It uses
`this.log.latestRunSeed(this.runId)`. Returns `""` if absent.

**Acceptance criteria:**

- [ ] `RunHandle` constructor signature unchanged.
- [ ] `originalGoal()` reads the latest `run_seeded` from the log.
- [ ] No callers in this phase use it; this lands the seam so future
      work can show it in the status line or notification
      surfaces without further refactor.

**Verification:**

- [ ] Unit test in `tests/host/run-handle.test.ts`:
  - Construct a handle with a `RunSeededRecord` → originalGoal
    returns the goal.
  - Without → returns `""`.
  - With multiple (defensive) → returns the latest.

**Dependencies:** Task 2.2.

**Files likely touched:**

- `src/host/run-handle.ts` (new method).
- `tests/host/run-handle.test.ts` (new case).

**Estimated scope:** S.

### Task 2.5 — `src/extension/commands/resume.ts` — no behavior change required, but verify

**Description:** Once Tasks 2.1–2.3 land, the extension's
`resumeRun({ goal: "" })` call still works — `""` flows in, gets
overridden inside `resumeRun` by the latest `run_seeded` value
before reaching the loop. No code change in the extension is
required.

**Acceptance criteria:**

- [ ] Manual walkthrough or extension-level integration test:
  `/conduct "fix the bug"` → orchestrator seeded → worker spawns →
  worker finishes, hand off back to orch → user types `/conduct:resume <runId>` → orchestrator sees the original goal.

**Verification:**

- [ ] `tests/extension/conduct-resume.test.ts` (or equivalent)
      drives a scenario where the run memory's `goal` field is
      asserted non-empty after a resume.

**Dependencies:** Task 2.3.

**Files likely touched:** None, ideally. If the test surfaces a
gap, fix it; document any code change in the phase archive.

**Estimated scope:** XS.

### Task 2.6 — OKF note (post-merge, `okf-curator`)

**Description:** A short durability note for the architectural
decision: "Run-start goal lives in the run log as a `run_seeded`
record. `resumeRun` reconstructs the original goal from the log
instead of taking it from the CLI/extension argument. The
host-agnostic core is unchanged; the goal lives where all other
host-side run-level metadata lives."

**Acceptance criteria:**

- [ ] New file (or addition to existing concept doc):
      `.okf/concepts/run-seed-goal.md`. Curator-owned.

**Dependencies:** Phase 2 merged.

**Files likely touched:**

- `.okf/concepts/run-seed-goal.md` (new).

**Estimated scope:** XS.

## Implementation order

1. **Task 2.1.** Add the new record type. No behavior change yet.
2. **Task 2.2.** Add `latestRunSeed` to `RecordLog`. No behavior
   change yet.
3. **Task 2.3.** Wire `startRun` and `resumeRun`. Behavior change
   lands here.
4. **Task 2.4.** Add the `RunHandle` seam. (Optional in this round —
   Phase 2.4 lands the API but no consumer.)
5. **Task 2.5.** Verify extension path end-to-end.
6. **Task 2.6.** OKF (post-merge).

Tests-first recommended: write the failing end-to-end test from Task
2.3 before changing `api.ts`, then make it pass.

## Checkpoint: end of Phase 2

- [ ] `pnpm typecheck` green.
- [ ] `pnpm lint` green.
- [ ] `pnpm test` green.
- [ ] `pnpm build` emits `dist/` with `.d.ts`.
- [ ] Manual walkthrough: `/conduct "fix the bug in foo.ts"` →
      orchestrator and worker run → `/conduct:resume <run_id>` →
      orchestrator re-engages with the same goal in context.
- [ ] Pre-change in-flight runs continue to work (no `run_seeded`
      record, fall back to empty goal as before).
- [ ] GH issue #9 is closed via `gh issue close 9 --reason completed`
      with a comment pointing at the diff and the archive folder.

## Out of scope

- Adding a `--goal` override flag to `/conduct:resume`. Future
  enhancement; one-line defer.
- Refactoring `RunHandle` to expose more `record`-level accessors.
- Changing `Checkpoint` schema or the reducer.
- Surfacing the recovered goal in any user-visible notification (TUI
  status line, terminal notification). The `originalGoal()` seam
  is in place; the surface work is a follow-up.

## Plan-sufficiency note

The phase is dispatchable as a single, M-sized implementation
session for a mid-level implementer. Tests come first (TDD).
Phases 1 and 2 are independent and can be worked in parallel if
multiple agents are available.
