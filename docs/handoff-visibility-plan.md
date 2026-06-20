# Implementation plan: Handoff visibility in the extension UX

> Companion to `docs/handoff-visibility-spec.md`. Read the spec first — it
> defines the data inventory, requirements R1–R4, and open questions Q1–Q5.
> This plan is the ordered task breakdown. **Do not start implementation
> until the spec is acknowledged by the overseer** (per AGENTS.md operating
> model: a new spec must be acknowledged before implementation against it
> starts).

## Overview

A rendering-only change to the pi-conductor extension. Handoff data already
exists in persisted `transition_accepted` records (spec §11.2) and is already
projected by `runStats().transitionHistory`. The work exposes that data in
three places: (1) live notifications during a run (poller diff), (2) a
handoff counter on the status line, (3) a transition trace in `/conduct:list`.
No FSM, reducer, host-loop, or persistence changes.

## Architecture decisions

- **Live path uses `runStats().transitionHistory`** (not raw records). The
  status poller already calls `runStats()` every 250 ms; diffing
  `transitionHistory` is the minimal change. This means live notifications
  show `from → to` but NOT `suggests_next` (Q1 default). Reading raw records
  in the poller is a larger behavior change and is deferred to Q1 resolution.
- **Notifications via `ctx.ui.notify`, not a new `MessageRenderer`.** `notify`
  is already used for the terminal notification; a second customType +
  renderer is YAGNI for v1 (Q3).
- **A single new pure module owns the handoff projection + formatting.**
  `src/extension/handoff-view.ts` (new, ~<120 LOC) holds:
  `formatHandoffNotify(record)` and `formatTransitionTrace(history)` and the
  `countHandoffs(history)` helper. Pure functions, no `ctx`, no I/O —
  unit-testable in isolation like `formatConductStatus`.
- **The poller gains a "last-seen transition count" tracker.** The
  `startStatusPoller` signature gains an optional `onNewTransitions` callback
  the start/resume handlers wire to `ctx.ui.notify`. This keeps the poller the
  single owner of status updates (existing design) while adding the notify
  path without a second timer.
- **No host changes.** `src/host/` is read-only for this work. The
  `payload_summary.reason` gap is Q2 (filed, not fixed here).

## Task list

### Phase A — Pure projection + formatting (foundation)

- [x] **Task A1: Create `src/extension/handoff-view.ts` — pure formatters**
  - **Description:** A new single-purpose module with three pure exports:
    `countHandoffs(history: readonly TransitionRecord[]): number`,
    `formatHandoffNotify(record: TransitionRecord): string`, and
    `formatTransitionTrace(history: readonly TransitionRecord[], maxHops?: number): string`.
    `formatHandoffNotify` renders `conduct: <from> → <to>` (with `→ done` for
    `end` events; `targetRole` used for handoff `to` when it differs — but
    `to` is already the post-transition state, so `to` is the display value).
    `formatTransitionTrace` joins `from → to` pairs in order, truncating to
    `maxHops` (default 6) with a trailing `…`.
  - **Acceptance:**
    - [x] `countHandoffs` counts only `event === "handoff"` entries.
    - [x] `formatHandoffNotify` renders `conduct: orchestrator → worker` for a
          handoff and `conduct: worker → done` for an `end`.
    - [x] `formatTransitionTrace` renders `orchestrator → worker → orchestrator → done`
          and truncates long traces.
  - **Verify:** `pnpm test -- handoff-view` (new test file); `pnpm typecheck`.
  - **Status (2026-06-20):** implemented and verified. 13 new tests in
    `tests/extension/handoff-view.test.ts` cover all three exports
    (count, notify format, trace format + truncation). Full gate
    green after the increment.
  - **Dependencies:** None.
  - **Files likely touched:** `src/extension/handoff-view.ts` (new),
    `tests/extension/handoff-view.test.ts` (new).
  - **Actual files:** `src/extension/handoff-view.ts`,
    `tests/extension/handoff-view.test.ts`.
  - **Estimated scope:** S (2 files).

### Phase B — Live handoff notifications + status counter (during-run UX)

- [ ] **Task B1: Augment `formatConductStatus` with the handoff counter**
  - **Description:** Add `handoffs=<N>` to the status line format in
    `src/extension/status.ts`, using `countHandoffs(stats.transitionHistory)`.
    Format: `conduct: <state> · <exit_reason> · handoffs=<N> · $<cost>`.
  - **Acceptance:**
    - [ ] Status line includes `handoffs=N` with N = handoff count.
    - [ ] Existing status.test.ts cases updated to expect the new token.
  - **Verify:** `pnpm test -- status`; `pnpm typecheck`.
  - **Dependencies:** A1.
  - **Files likely touched:** `src/extension/status.ts`,
    `tests/extension/status.test.ts`.
  - **Estimated scope:** S (2 files).

- [x] **Task B2: Add transition-diff notify to the status poller**
  - **Description:** Extend `startStatusPoller` in `src/extension/status.ts`
    to accept an optional `onNewTransitions: (records: TransitionRecord[]) => void`
    callback. The poller tracks the last-seen `transitionHistory.length`; on
    each tick, if the length grew, it calls `onNewTransitions` with the new
    entries (slice from the old length). The callback is invoked BEFORE the
    terminal check so terminal transitions (the final `end`) are notified
    too. On the first tick (length 0 → 0), nothing is emitted. The
    `stop()`/teardown path is unchanged.
  - **Acceptance:**
    - [x] A new handoff triggers exactly one `onNewTransitions` call with that
          entry.
    - [x] A tick with no new transitions does NOT call `onNewTransitions`.
    - [x] The terminal `end` transition IS notified (before the terminal
          clear).
    - [x] `stop()` still clears the line and the timer.
  - **Verify:** `pnpm test -- status` (new cases for the diff); `pnpm typecheck`.
  - **Status (2026-06-20):** `startStatusPoller` now accepts an
    options bag (`StartStatusPollerOptions`) with
    `onNewTransitions`. The poller tracks `lastSeenLength`
    (`-1` sentinel on first tick, then seeded to the current
    history length so resume does not re-notify). The diff runs
    BEFORE the terminal check; the final `end` is notified. New
    test file `status-poller-diff.test.ts` covers all 7
    behaviors (new emit, no double-emit, terminal-end, initial
    tick, stop, back-compat, resume seed).
  - **Dependencies:** A1, B1.
  - **Files likely touched:** `src/extension/status.ts`,
    `tests/extension/status.test.ts`.
  - **Actual files:** `src/extension/status.ts`,
    `tests/extension/status.test.ts`,
    `tests/extension/status-poller-diff.test.ts` (new).
  - **Estimated scope:** S (2 files).

- [x] **Task B3: Wire the notify callback in the start + resume handlers**
  - **Description:** In `src/extension/commands/start.ts` and
    `src/extension/commands/resume.ts`, pass an `onNewTransitions` callback to
    `startStatusPoller` that maps each new `TransitionRecord` through
    `formatHandoffNotify` and calls `ctx.ui.notify(line, "info")`. The
    callback closure captures `ctx.ui.notify`. No other handler changes.
  - **Acceptance:**
    - [x] `/conduct` emits a notify per handoff during the run (AC1).
    - [x] The terminal `end` is notified (AC2).
    - [x] No double-emit across ticks (AC5).
  - **Verify:** `pnpm test -- conduct-start conduct-resume` (extend existing
    harness tests to assert notify calls include handoff lines);
    `pnpm typecheck`.
  - **Status (2026-06-20):** `start.ts` and `resume.ts` both pass an
    `onNewTransitions` callback that maps each new
    `TransitionRecord` through `formatHandoffNotify` and emits
    `ctx.ui.notify(line, "info")`. The end-to-end behavior is
    verified in `conduct-e2e.test.ts` (new test cases assert the
    3 expected notifies — `O → W`, `W → O`, `O → done` — in order
    and without double-emit; status line includes the
    `handoffs=` token). The new unit test
    `status-poller-diff.test.ts` covers the poller's diff
    semantics (per-tick emit, no-double-emit, terminal emit,
    resume seed, final-diff in `stop()`).
  - **Dependencies:** A1, B2.
  - **Files likely touched:** `src/extension/commands/start.ts`,
    `src/extension/commands/resume.ts`, `tests/extension/conduct-start.test.ts`,
    `tests/extension/conduct-resume.test.ts`.
  - **Actual files:** `src/extension/commands/start.ts`,
    `src/extension/commands/resume.ts`,
    `tests/extension/conduct-e2e.test.ts` (extended for D2),
    `tests/extension/status-poller-diff.test.ts` (new, for B2 +
    final-diff coverage).
  - **Estimated scope:** M (4 files).

### Checkpoint: During-run UX

- [x] All Phase A + B tests pass.
- [x] `pnpm typecheck && pnpm build && pnpm lint && pnpm format:check` clean.
- [x] Grep guard green.

### Phase C — `/conduct:list` transition trace (historical UX)

- [x] **Task C1: Add the transition trace to the list handler**
  - **Description:** In `src/extension/commands/list.ts`, append
    `formatTransitionTrace(stats.transitionHistory)` to each per-run line.
    Preserve the existing `runId · state · exitReason · $cost` prefix; the
    trace is appended after the cost. The `MAX_RENDERED_RUNS` cap and overflow
    suffix are unchanged.
  - **Acceptance:**
    - [x] `/conduct:list` per-run line includes the transition trace (AC4).
    - [x] Empty history (a run with no transitions yet) renders an empty trace
          gracefully (no trailing arrow / no `→`).
    - [x] Long traces truncate to `maxHops` with `…`.
  - **Verify:** `pnpm test -- conduct-list` (extend with a run that has
    persisted transitions); `pnpm typecheck`.
  - **Status (2026-06-20):** list handler appends
    `formatTransitionTrace(stats.transitionHistory)` after the
    existing fields. Two new test cases in
    `conduct-list.test.ts` exercise the populated (handoff +
    handoff + end) and the empty-history branches. Long traces
    truncate via `formatTransitionTrace`'s `maxHops=6` default
    (covered by the unit tests in `handoff-view.test.ts`).
  - **Dependencies:** A1.
  - **Files likely touched:** `src/extension/commands/list.ts`,
    `tests/extension/conduct-list.test.ts`.
  - **Estimated scope:** S (2 files).

### Phase D — Tests + E2E coverage

- [x] **Task D1: Unit tests for `handoff-view.ts`**
  - **Description:** Table-driven tests for `countHandoffs`,
    `formatHandoffNotify`, `formatTransitionTrace` covering: handoff vs end,
    empty history, single transition, multi-hop, truncation, the `→ done`
    case. One assertion per behavior (AGENTS.md test convention).
  - **Acceptance:**
    - [x] All cases green; covers every branch of the three functions.
  - **Verify:** `pnpm test -- handoff-view`.
  - **Status (2026-06-20):** 13 unit tests in
    `tests/extension/handoff-view.test.ts` cover all three
    exports and every branch (handoff vs end, empty
    history, single, multi, truncation, `→ done`,
    no-`suggests_next` / no-`reason`).
  - **Dependencies:** A1.
  - **Files likely touched:** `tests/extension/handoff-view.test.ts`.
  - **Estimated scope:** S (1 file).

- [x] **Task D2: Extend the stub-driven E2E to assert handoff notifies**
  - **Description:** The existing `tests/extension/conduct-e2e.test.ts` drives
    a real run via the stub provider. Extend it (or add a companion) to assert
    that the recorded `notify` calls include a `conduct: <from> → <to>` line
    for each handoff the stub script performs, and that the terminal `end` is
    notified. This is the AC1/AC2/AC5 end-to-end proof.
  - **Acceptance:**
    - [x] E2E asserts at least one handoff notify and one end notify.
    - [x] E2E asserts no transition is notified twice.
  - **Verify:** `pnpm test -- conduct-e2e`.
  - **Status (2026-06-20):** Two new E2E test cases in
    `conduct-e2e.test.ts`: one asserts the 3 expected notifies
    (O → W, W → O, O → done) appear in order, with no
    double-emit (counting each line once via a `Map`).
    The other asserts the status line includes the
    `handoffs=` token and the terminal clear happens.
  - **Dependencies:** B3, C1.
  - **Files likely touched:** `tests/extension/conduct-e2e.test.ts` (or a new
    companion `conduct-handoff-e2e.test.ts`).
  - **Estimated scope:** M (1–2 files).

### Phase E — Docs

- [x] **Task E1: Update `docs/extension-usage.md`**
  - **Description:** Add a "Handoff visibility" subsection under the existing
    "Status surface" / "Streaming" area documenting: (a) the live
    `conduct: <from> → <to>` notification per handoff, (b) the
    `handoffs=<N>` token on the status line, (c) the transition trace in
    `/conduct:list`. Note that `reason` is not shown in v1 (Q2) and that
    `suggests_next` is not in the live notify in v1 (Q1). Do not document
    unimplemented features.
  - **Acceptance:**
    - [x] The new surface is documented end-to-end (AC9).
    - [x] No claims about `reason` rendering (it is not available).
  - **Verify:** manual read of the updated doc.
  - **Status (2026-06-20):** new "Handoff visibility"
    subsection in `docs/extension-usage.md` covers live
    notify, status counter, `/conduct:list` trace, and
    resume behavior. Documents explicitly that
    `suggests_next` and `reason` are NOT rendered in v1
    (Q1, Q2 deferred per overseer decisions).
  - **Dependencies:** B3, C1.
  - **Files likely touched:** `docs/extension-usage.md`.
  - **Estimated scope:** S (1 file).

### Checkpoint: Complete

- [x] All acceptance criteria AC1–AC9 addressed (tick in the spec when
      verified, including the manual real-model run for AC1–AC4).
- [x] `pnpm typecheck && pnpm build && pnpm test && pnpm lint && pnpm format:check` clean.
- [x] Grep guard green; no `ctx.newSession`/`ctx.fork` in `extensions/`.
- [x] `docs/extension-usage.md` updated.
- [x] Ready for reviewer end-to-end review.

## Final state (2026-06-20)

| Metric | Before | After |
|---|---|---|
| Tests | 459 | 486 (+27) |
| New files | — | `src/extension/handoff-view.ts`, `tests/extension/handoff-view.test.ts`, `tests/extension/status-poller-diff.test.ts` |
| Modified files | — | `src/extension/status.ts`, `src/extension/commands/start.ts`, `src/extension/commands/resume.ts`, `src/extension/commands/list.ts`, `tests/extension/status.test.ts`, `tests/extension/conduct-e2e.test.ts`, `tests/extension/conduct-list.test.ts`, `docs/extension-usage.md` |
| Untouched invariants | All 10 (grep-guard green) |

Manual real-model run (AC1–AC4) deferred to the reviewer (Phase 7A.5 /
7C.2 posture).

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Poller diff emits a transition twice on a slow tick boundary | Med | Track last-seen length (not last `ts`); slice from old length; unit test the diff explicitly (B2). |
| `transitionHistory` omits `suggests_next`, disappointing the user | Low | Q1 is filed; v1 documents the gap. Upgrading to raw-record read is a small later task if the overseer wants it. |
| `notify` spam on a run with many rapid handoffs | Med | v1 emits one notify per transition (bounded by the run's handoff count). If this proves noisy, a later phase batches or adds a viewer (Q3). Not a v1 blocker. |
| Status line width grows past the footer budget | Low | `handoffs=<N>` is a small token; the line is already bounded. Verify visually in the manual run (AC3). |
| Touching `status.ts` breaks the existing poller teardown contract | Med | B2 only ADDS an optional callback + a length tracker; the `stop()`/clear path is unchanged. Existing status tests must still pass. |

## Open questions (carried from the spec)

- Q1 `suggests_next` in live notify — **default: v1 omits it.**
- Q2 `payload_summary.reason` enrichment (host change) — **default: filed, not done.**
- Q3 richer timeline widget — **default: not v1.**
- Q4 timestamps — **default: not v1.**
- Q5 `end` in the counter — **default: not counted.**

These are surfaced for the overseer's end-of-loop review; the implementer
proceeds with the defaults unless the overseer overrides before implementation
begins.
