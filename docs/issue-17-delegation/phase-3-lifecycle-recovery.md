# Phase 3 — Lifecycle, Recovery, ADR, CHANGELOG, Version Bump

**Source:** [`../plan.md`](../plan.md); senior spec
[`./spec.md`](./spec.md). Phase 3 closes the lifecycle and recovery
contracts the senior spec §11 enumerates: budget reservation against
the run cap, parent/run cancellation propagation, resume
reconciliation of orphan children, and the ADR-002 / CHANGELOG /
version bump. Phases 1 and 2 are prerequisites.

## Goal

A delegated batch is bounded not just by the manifest policy but
also by the current run cap (spec §11, §5 decision 4). A parent or
run abort aborts all active children and persists cancelled
terminals (spec §11). On `resumeRun`, the host reconciles any
orphan child attempts (those with a `subagent_started` but no
terminal record) and safely cleans only conductor-owned worktrees
(spec §11). The feature is documented in `ADR-002`, the version is
bumped to `0.9.0`, and the CHANGELOG captures the new feature.

## Spec pointers (senior spec)

- §5 (assumptions — model policy, cleanup policy)
- §9 (persistence and accounting — reservation, settlement, double-
  count prevention)
- §11 (cancellation, recovery, and failure containment — orphan
  reconciliation, idempotent cleanup)
- §12 (invariants and failure matrix)
- §13 (compatibility, migration, rollback — additive; no breaking
  change)
- §15 (testing and acceptance criteria — 8, 9, 10, 11)

## What this phase does NOT do

- Recursive delegation (`max_depth > 1`).
- A new UI command. Existing record-emitter consumers stay
  compatible; child records are observability/recovery data, not
  user-facing.
- A new package dependency.

## Tasks

### Task 3.1 — Child budget reservation ledger

**Description:** Add a host-owned budget ledger that tracks the
reserved `max_child_cost_usd` for each admitted child and settles
on terminal. The ledger is consulted before each child is spawned
and at every parent terminal evaluation of the run cap.

**Files:**

- `src/host/delegation/child-budget.ts` (new)

**Acceptance criteria:**

- [ ] Exports `class ChildBudgetLedger` (or equivalent) with
      methods:
        - `reserve(args: { childId: string; amount: number }):
          ReservationResult` — returns `{ ok: true, reservationId }
          or { ok: false, reason: "run_cap_would_breach" }`.
        - `settle(reservationId: string, actualCost: number):
          void` — releases the reservation; the run cap
          accounting uses `actualCost` (not the reserved amount)
          going forward.
        - `release(reservationId: string): void` — releases
          without settling (used on child errors that never
          produced a terminal).
        - `reservedTotal(): number` — sum of currently-reserved
          amounts (used by the run-cap evaluator).
- [ ] `reserve` is rejected when `reservedTotal() + amount >
      runCap` (the run cap is the orchestrator's
      `max_run_cost_usd`, passed in at construction; `null` =
      uncapped, in which case `reserve` always returns
      `{ ok: true }`).
- [ ] The ledger is **not** persisted in the FSM reducer; it is
      host-owned and reconstructed at run-start (the host
      reads `subagent_started` records and treats the sum of
      unmatched reservations as the initial reserved total).
- [ ] Defensive: `settle`/`release` on an unknown `reservationId`
      are no-ops (idempotent).
- [ ] File-level JSDoc explains the budget is separate from
      parent session-cap admission (spec §5 decision 4:
      "Parent budget: delegated usage is charged to the parent
      invocation's session budget for admission/cap purposes,
      while child usage remains in child terminal records so
      roll-ups do not double count it").

**Verification:**

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test tests/host/delegation/child-budget.test.ts` (new)
      green; ~8 cases:
        - Reserve within cap → `{ ok: true }`; subsequent reserve
          sees the reserved total.
        - Reserve that would breach cap → `{ ok: false }`; no
          ledger mutation.
        - `settle` releases the reservation; subsequent reserve
          sees the settled amount as spent.
        - `release` releases without settlement; subsequent
          reserve sees no usage.
        - Uncapped run cap → `reserve` always returns
          `{ ok: true }`.
        - Idempotent `settle`/`release` on unknown id is a no-op.
        - Reconstructed-from-records initial reserved total
          matches a hand-rolled sum.
        - Concurrent reserves do not exceed the cap (sequential
          test using a counter).

### Task 3.2 — Wire the budget ledger into `DelegationManager`

**Description:** Extend `DelegationManager` (Phase 2) to:
  1. Construct or accept a `ChildBudgetLedger` at run start (the
     ledger is reconstructed from `subagent_started` records on
     resume; see Task 3.5).
  2. Reserve before each child spawn; on `reserve` failure
     (`run_cap_would_breach`), abort the active children,
     persist cancelled terminals, and return the partial
     results with a host-generated `failure_reason` indicating
     the run cap was breached.
  3. Settle on terminal with the actual `usage.cost` from the
     terminal record.

**Files:**

- `src/host/delegation/manager.ts` (extend)

**Acceptance criteria:**

- [ ] `DelegationManager` constructor (or factory) accepts a
      `ChildBudgetLedger` and the current `runCap` (read from
      `getRunCostCap()` on the `RunHandle`; `null` = uncapped).
- [ ] Each `subagent_started` is preceded by a `reserve` call;
      the `childId` is recorded in the reservation.
- [ ] Each terminal record is preceded by a `settle` call with
      the actual `usage.cost` from the child's terminal
      `UsageRecord`.
- [ ] A reservation that would breach the cap aborts the
      children admitted so far in the batch (each gets a
      `subagent_failed` with `status: "cancelled"` and
      `failure_reason: "run_cap_would_breach"`), and the
      remaining tasks in the batch are NOT spawned (the result
      set has the cancelled entries in their original input
      order, marked failed).
- [ ] Defensive: a manager error (e.g., worktree gate failure
      on a different task) does not leak a reservation; the
      reservation is released.

**Verification:**

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test tests/host/delegation/manager-budget.test.ts`
      (new) green; ~5 cases:
        - Reserve within cap; all children admitted and
          settled.
        - Reserve that would breach cap on the 3rd of 3 tasks:
          first 2 admitted, 3rd rejected; result set has 3
          entries; 2 succeeded, 1 failed with
          `"run_cap_would_breach"`.
        - Settle with the actual cost; ledger reflects the
          actual spend.
        - Uncapped run cap: all reserves succeed; all children
          admitted.
        - Reconstructed ledger: a resumed run picks up the
          reserved total from prior `subagent_started` records.

### Task 3.3 — Cancellation propagation: `RunHandle.abort()` aborts children

**Description:** Extend `RunHandle.abort(reason)` (and the
`RunAbortControl` bridge in the loop) so that:
  1. The parent session is aborted (existing behavior).
  2. The `DelegationManager` is given a chance to abort every
     active child (`AgentSession.abort()` on each child).
  3. Each child gets a `subagent_failed` terminal with
     `status: "cancelled"` and a captured `usage` if available.
  4. Cancellation is **idempotent**: a second `abort()` call is
     a no-op (per spec §11: "Recovery and cleanup are
     idempotent").

**Files:**

- `src/host/run-handle.ts` (extend)
- `src/host/loop.ts` (extend — wire the abort bridge to the
  delegation manager)
- `src/host/delegation/manager.ts` (extend — `cancelAll(reason)`
  method)

**Acceptance criteria:**

- [ ] `DelegationManager.cancelAll(reason: string): Promise<void>`
      aborts every active child session, persists a
      `subagent_failed` record per child with
      `status: "cancelled"` and `usage` from the session's
      current `SessionState.usage()` (if any), and clears the
      pool.
- [ ] `RunHandle.abort(reason)` calls `manager.cancelAll(reason)`
      BEFORE the loop's `requestAbort` (or in parallel — the
      manager must be in scope of the `RunHandle`'s abort
      closure).
- [ ] A second `abort()` call is a no-op (idempotent).
- [ ] The aborted children persist exactly one `subagent_failed`
      per attempt (no double-terminal).
- [ ] After cancellation, the parent's session ends with a
      `session_failed` whose `failure_reason` reflects the
      abort reason (existing behavior).

**Verification:**

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test tests/host/run-handle-abort-children.test.ts`
      (new) green; ~4 cases:
        - A running batch is cancelled; all children receive
          `subagent_failed` with `status: "cancelled"`.
        - `RunHandle.abort()` does not throw when no children
          are active.
        - A second `abort()` is a no-op (idempotent).
        - The parent's `session_failed` reason is propagated to
          the run log.

### Task 3.4 — Child-aware `RequestActiveSession` (loop integration)

**Description:** The loop's `RunAbortControl` interface
(`setActiveSession`, `requestAbort` in `src/host/loop.ts`) is
extended with a `setActiveDelegation(manager: DelegationManager |
null)` so the manager is in scope of the abort bridge. The loop
also needs to set this from `api.ts`'s `runWithCompletion` (which
constructs the `RunHandle`).

**Files:**

- `src/host/loop.ts` (extend)
- `src/host/api.ts` (extend)

**Acceptance criteria:**

- [ ] `RunAbortControl.setActiveDelegation(manager: DelegationManager
      | null): Promise<void>` is added (additive; the existing
      `setActiveSession` and `requestAbort` are unchanged).
- [ ] `runWithCompletion` constructs the `DelegationManager`,
      passes it to the loop via `abortControl.setActiveDelegation`,
      and exposes it to `RunHandle.abort` (via the abort closure
      chain).
- [ ] No new imports of the SDK in `src/host/loop.ts`'s public
      surface (the `DelegationManager` is a `src/host/delegation/`
      type, not an SDK type).
- [ ] The loop's existing `abort()` path is unchanged for runs
      with no active delegation manager (idempotent /
      no-op for `setActiveDelegation(null)`).

**Verification:**

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test tests/host/loop-delegation-abort.test.ts` (new)
      green; ~3 cases:
        - The loop's `requestAbort` reaches the manager.
        - `setActiveDelegation(null)` is a no-op.
        - A run with no delegation enabled continues to abort
          via the existing path (regression check).

### Task 3.5 — Resume reconciliation of orphan children

**Description:** Extend `resumeRun` in `src/host/api.ts` to:
  1. Scan the run's records for `subagent_started` attempts
     without a matching terminal record.
  2. For each orphan, persist a `subagent_failed` with
     `status: "cancelled"` and a `failure_reason` of
     `"recovered"` (or `"recovered_dirty"` for worktree
     attempts whose worktree exists and is dirty).
  3. Reconstruct the `ChildBudgetLedger` from the surviving
     terminals' reserved amounts (the sum of
     `subagent_started` minus the sum of settled terminals is
     the residual reserved total).
  4. For worktree orphans with a conductor-owned path AND a
     clean tree, remove the worktree after the
     reconciliation record is appended. For dirty orphans,
     preserve the worktree.
  5. Idempotent: a second `resumeRun` does not duplicate
     terminal records or remove a non-conductor path.

**Files:**

- `src/host/delegation/recovery.ts` (new)
- `src/host/api.ts` (extend)

**Acceptance criteria:**

- [ ] `src/host/delegation/recovery.ts` exports
      `reconcileOrphans(args: { runId: string; records:
      readonly PersistedRecord[]; worktreeManager: WorktreeManager;
      stateDir: string; onRecord: (record: PersistedRecord) => void }):
      Promise<{ orphanCount: number; cleanedWorktrees: number;
      preservedWorktrees: number }>`.
- [ ] Orphan detection: for each `subagent_started` with a
      given `(childId, attempt)`, look for any terminal record
      with the same `(childId, attempt)`. If none, it's an
      orphan.
- [ ] Worktree cleanup: a worktree at
      `<stateDir>/worktrees/<childId>` that is clean is removed
      (after the reconciliation record is appended). A worktree
      that is not clean OR not under `stateDir` is preserved.
- [ ] Idempotent: a second `reconcileOrphans` on the same run
      appends zero records and removes zero worktrees.
- [ ] Missing session files (the `session_file` does not exist
      on disk) are surfaced as explicit recovery metadata in
      the reconciliation result; they are NOT silently treated
      as success.
- [ ] `resumeRun` calls `reconcileOrphans` BEFORE entering the
      orchestration loop; the loop resumes with the
      reconstructed `ChildBudgetLedger` in scope.

**Verification:**

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test tests/host/delegation/recovery.test.ts` (new)
      green; ~6 cases:
        - One orphan child with no terminal → reconciliation
          record appended; clean worktree removed.
        - One orphan child with a dirty worktree → reconciliation
          record appended; worktree preserved.
        - Zero orphans → no records appended, no worktrees
          removed.
        - All children have terminals → no orphans, no
          reconciliation.
        - Idempotent: a second reconciliation produces zero
          records and removes zero worktrees.
        - Missing session file is surfaced in the result
          metadata (not silently treated as success).

### Task 3.6 — Wire reconciliation into `resumeRun`

**Description:** Extend `api.ts`'s `resumeRun` to call
`reconcileOrphans` after loading the manifest and BEFORE the loop
is entered. The reconstructed `ChildBudgetLedger` is passed to
the `DelegationManager` constructed in `runWithCompletion`.

**Files:**

- `src/host/api.ts` (extend)

**Acceptance criteria:**

- [ ] `resumeRun` calls `reconcileOrphans` with the loaded
      `RecordLog`, the worktree manager (constructed from the
      `stateDir` and the `runGit` adapter), and the
      `hostFactory`'s `onRecord` callback.
- [ ] The reconstructed `ChildBudgetLedger` is passed through
      to `runWithCompletion` and to the loop's
      `abortControl.setActiveDelegation`.
- [ ] A resumed run with no orphans continues to enter the
      loop identically to the pre-Phase-3 path (regression
      check).
- [ ] `pnpm test tests/host/resume.test.ts` extended with a
      new describe block covering the reconciliation flow.

**Verification:**

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test tests/host/resume.test.ts` green (existing +
      new).
- [ ] `pnpm test` (full suite) green.

### Task 3.7 — `ADR-002-subagent-delegation.md`

**Description:** Add `docs/decisions/ADR-002-subagent-delegation.md`
documenting the load-bearing decisions the senior spec made and
this plan implemented. The ADR is a stable record for future
planners; it does not re-litigate the senior spec's decisions but
records why they are the way they are.

**Files:**

- `docs/decisions/ADR-002-subagent-delegation.md` (new)

**Acceptance criteria:**

- [ ] The ADR follows the structure of the existing
      `docs/decisions/ADR-001-handoff-context.md` (status,
      context, decision, consequences, alternatives).
- [ ] Status: `accepted` (the senior spec's recommendations
      stand; the overseer has acknowledged at end-of-loop).
- [ ] Context: the §17 open decisions, the FSM-purity
      invariant, the single-owner rule.
- [ ] Decision: the senior spec's recommended decisions (manifest
      policy, command policy, model policy, cleanup policy) are
      recorded as the accepted decisions, with a one-paragraph
      rationale each.
- [ ] Consequences: positive (bounded delegation, durable child
      records, no FSM bloat) and negative (children add a
      non-trivial host-side component; future work on
      `max_depth > 1` and `bash`-equivalent for worktree
      children is explicitly deferred).
- [ ] Alternatives considered and rejected:
        - Nested conductor (rejected: FSM bloat + reducer
          changes).
        - Unrestricted child `bash` (rejected: spec §5
          decision 2; not a sandbox).
        - Per-child model list (rejected: spec §5 decision 3;
          child budget reservation is the simpler model).
        - Automatic merge / cherry-pick (rejected: spec §4
          non-goal).

**Verification:**

- [ ] `cat docs/decisions/ADR-002-subagent-delegation.md` shows
      the structure above.

### Task 3.8 — CHANGELOG and version bump

**Description:** Add the `0.9.0` entry to `CHANGELOG.md` and
bump `package.json` `"version"` from `0.8.2` to `0.9.0`.

**Files:**

- `CHANGELOG.md` (extend)
- `package.json` (extend)

**Acceptance criteria:**

- [ ] `CHANGELOG.md` has a new section above the `0.8.2` block
      with the heading `## [0.9.0] - YYYY-MM-DD`.
- [ ] The section documents:
        - **Feature:** bounded sub-agent delegation via the
          `delegate` host tool, with `read_only` and `worktree`
          workspace modes, manifest policy, concurrent execution
          up to `max_parallel`, durable child records, worktree
          isolation, budget reservation against the run cap,
          parent/run cancellation propagation, and resume
          reconciliation.
        - **New host tool:** `delegate` (manifest-gated; opt-in).
        - **New child tool:** `report_result` (host-bound;
          required for child terminal reporting).
        - **New worktree tool:** `run` (argv-based; restricted
          allowlist; path-confined; replaces unrestricted
          `bash` for worktree children).
        - **New records (host-agnostic, additive):**
          `subagent_started`, `subagent_completed`,
          `subagent_failed`.
        - **New manifest field:** `roles[].delegation` (opt-in
          block; see spec §6 for the shape).
        - **New cost view:** `rollup.perSubagent` (additive;
          children do not appear in `perRole`).
        - **Notes:** no new package dependencies; no reducer
          change; no FSM contract change; no breaking change to
          existing public API; the `delegate` and
          `report_result` TypeBox schemas are the single
          source of truth for the tool-arg shape.
        - **ADR:** `ADR-002-subagent-delegation.md`.
- [ ] `package.json` `"version"` is `"0.9.0"`.

**Verification:**

- [ ] `git diff CHANGELOG.md package.json` shows the expected
      changes.

### Task 3.9 — Repository gate

**Description:** Per AGENTS.md "Verification" — confirm the
phase gate is green before declaring Phase 3 done (and the
feature ready for end-of-loop review).

**Acceptance criteria:**

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm build` clean (`dist/` regenerated with new types).
- [ ] `pnpm test` all green (existing + new + extended).
- [ ] `pnpm lint` (`biome check .`) clean.
- [ ] `pnpm format:check` clean.
- [ ] `tests/grep-guard.test.ts` passes.
- [ ] The extension grep guard on `extensions/**/*.ts` (no
      `ctx.newSession` / `ctx.fork`) continues to pass.
- [ ] `pnpm audit` shows no new advisories.
- [ ] `git status` shows no uncommitted changes; all changes
      are committed (per AGENTS.md "Operating model" — work
      lands in atomic commits).

**Final acceptance (spec §15):**

- [ ] All 12 spec §15 acceptance criteria are demonstrably
      covered by tests in Phases 1–3.
- [ ] Manifests without `delegation:` parse and validate
      identically to before; existing tests in
      `tests/manifest/` and `tests/cost/` pass unchanged.
- [ ] The reducer is unchanged (`git diff src/core/reduce.ts
      src/core/reduce-lifecycle.ts src/core/types.ts` is empty).
- [ ] `MachineDefinition` is unchanged (`git diff
      src/manifest/definition.ts src/core/types.ts` is empty).

## Module-size check (new files in this phase)

| File | Expected LOC | Notes |
|------|--------------|-------|
| `src/host/delegation/child-budget.ts` | ~150 | ledger + reservation logic |
| `src/host/delegation/recovery.ts` | ~250 | orphan reconciliation + idempotent cleanup |
| `docs/decisions/ADR-002-subagent-delegation.md` | ~150 | prose |

All well under the AGENTS.md 400-LOC soft ceiling. The Phase 2
`manager.ts` grows with the budget wiring (Task 3.2) but stays
under 400 LOC; if it crosses, split per the Phase 2 note
(`manager.ts` + `results.ts`).

`src/host/loop.ts` and `src/host/api.ts` grow by a small amount
(Tasks 3.4, 3.6) — additive changes; the files are already
large, but the new logic is small.

## Files likely touched

| File | Change |
|------|--------|
| `src/host/delegation/child-budget.ts` | **New** — ledger |
| `src/host/delegation/manager.ts` | Extend — wire ledger (Task 3.2) |
| `src/host/delegation/recovery.ts` | **New** — orphan reconciliation |
| `src/host/run-handle.ts` | Extend — `cancelAll` wiring |
| `src/host/loop.ts` | Extend — `setActiveDelegation` + `setActiveSession` |
| `src/host/api.ts` | Extend — `reconcileOrphans` in `resumeRun`; ledger reconstruction |
| `src/host/index.ts` | Re-export `ChildBudgetLedger`, `reconcileOrphans` |
| `src/index.ts` | Re-export public types (if any) |
| `docs/decisions/ADR-002-subagent-delegation.md` | **New** |
| `CHANGELOG.md` | New `0.9.0` section |
| `package.json` | Bump `0.8.2` → `0.9.0` |
| `tests/host/delegation/child-budget.test.ts` | **New** |
| `tests/host/delegation/manager-budget.test.ts` | **New** |
| `tests/host/delegation/recovery.test.ts` | **New** |
| `tests/host/run-handle-abort-children.test.ts` | **New** |
| `tests/host/loop-delegation-abort.test.ts` | **New** |
| `tests/host/resume.test.ts` | Extend with reconciliation cases |

## Checkpoint: end of Phase 3

- [ ] All Task 3.1–3.9 checkboxes ticked.
- [ ] Budget reservation: a delegated batch can never breach the
      orchestrator's run cap; reservation is settled on terminal
      with the actual cost; ledger is reconstructed on resume.
- [ ] Cancellation: `RunHandle.abort()` aborts all active
      children; each gets a `subagent_failed` with
      `status: "cancelled"`; cancellation is idempotent.
- [ ] Resume: `resumeRun` reconciles orphan children, removes
      clean conductor-owned worktrees, preserves dirty ones;
      reconciliation is idempotent.
- [ ] ADR-002 captures the load-bearing decisions.
- [ ] `CHANGELOG.md` and `package.json` are updated for `0.9.0`.
- [ ] All 12 spec §15 acceptance criteria are demonstrably
      covered by tests.
- [ ] The reducer and `MachineDefinition` are unchanged.
- [ ] The grep guards continue to pass.
- [ ] Full repository verification gate is green.

## Out of scope (deferred)

- Recursive delegation (`max_depth > 1`).
- `bash` tool in child sessions (replaced by `run`).
- Automatic merge / cherry-pick / conflict resolution.
- A new UI command. Existing record-emitter consumers stay
  compatible; child records are observability/recovery data.
- OS / container / network isolation (the `run` tool is a tool
  policy, not a sandbox; the spec §4 non-goal is explicit).
- Per-child model lists (children inherit the parent's model
  chain with shared budget).
