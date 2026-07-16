# Phase 1 — Remediate Phase 3 Lifecycle, Accounting, Cancellation, and Recovery

**Request class:** `remediation`  
**Controlling spec:** [`spec.md`](./spec.md)  
**Senior decisions preserved:** [`../issue-17-delegation/spec.md`](../issue-17-delegation/spec.md) §§9–12  
**Supersedes:** the lifecycle/recovery behavior and examples in [`../issue-17-delegation/phase-3-lifecycle-recovery.md`](../issue-17-delegation/phase-3-lifecycle-recovery.md) Tasks 3.1–3.6 only.

This is one actionable package. Do not begin implementation against the original Phase 3 checklist until Task 0 is complete and the package is approved. Tasks 1–6 are sequential because they share keyed budget, attempt, host, and recovery seams; Task 0 is the required preflight and Task 7 is the final artifact/gate task.

## Exit contract

The phase is complete only when:

- the checked-in audit baseline predates implementation and the deterministic after comparison is unchanged;
- one run-scoped budget enforces actual run and parent spend, dynamic caps, and role-lifetime child admission;
- child cost appears once in every run-cost reader without entering parent/provider-only lifecycle usage or `perRole`;
- the manager's attempt registry makes start/terminal/cancellation/append retry idempotent and closes queued work;
- parent-cap provider growth and child settlement reach a live manager and persist the typed `parent_cap_would_breach` reason;
- `RunHandle.abort()` cancels a real active delegation manager before/with the parent abort;
- resume uses the configured worktree manager and state directory, exact attempt keys, an atomic recovery lock, filesystem-aware metadata, policy fail-closed amount resolution, and safe retryable cleanup; and
- the original Phase 3 artifact, ADR-002, and version/changelog artifacts reflect only verified behavior.

No task may modify `src/core`, `src/manifest`, `src/seam`, `src/cost`, `MachineDefinition`, reducer signatures, or extension session-tree behavior.

---

## Task 0 — Audit and repository preflight (must precede all implementation)

**Purpose:** Establish a reproducible supply-chain baseline before any lifecycle code changes. This closes the review finding that the audit baseline was scheduled after implementation.

**Files likely touched:**

- `scripts/normalize-pnpm-audit.mjs` (new)
- `docs/issue-17-delegation-remediation/audit-baseline.json` (new, checked in)
- `docs/issue-17-delegation-remediation/spec.md` (only to record a verified baseline delta)

**Work:**

1. Implement a deterministic normalizer using only Node built-ins. It accepts the raw `pnpm audit --json` path and an explicit exit status. It must support the installed pnpm advisory shape and sort records by stable advisory/package identity. Emit only `audit_exit_status`, `advisory_count`, and sorted advisory entries containing advisory ID, package/module, severity, vulnerable/affected range, patched range when present, and affected installed versions/paths. Do not include timestamps, prose, or network-order fields.
2. Run the baseline before touching Task 1 files:

   ```text
   set +e
   pnpm audit --json > /tmp/pi-conductor-audit-before.json
   audit_status=$?
   node scripts/normalize-pnpm-audit.mjs --status "$audit_status" /tmp/pi-conductor-audit-before.json > docs/issue-17-delegation-remediation/audit-baseline.json
   test -s docs/issue-17-delegation-remediation/audit-baseline.json
   ```

3. Verify the baseline is the expected current no-dependency-change state (observed on 2026-07-12: 8 advisories, exit status 1). If the live set/status differs, stop and route a separate supply-chain decision; do not normalize the difference away.
4. Verify `package.json`, `pnpm-lock.yaml`, and existing tracked source are unchanged before Task 1. The baseline file and normalizer are the only new preflight artifacts.

**Acceptance:**

- [ ] The baseline is checked in before any Task 1 implementation diff.
- [ ] Normalization is deterministic on repeated runs and excludes timestamps/prose.
- [ ] Baseline contains the exact advisory/package IDs, severities, affected ranges, and non-zero status observed before implementation.
- [ ] No dependency or lockfile change exists at the preflight checkpoint.

**Verification:**

```text
node scripts/normalize-pnpm-audit.mjs --status 1 /tmp/pi-conductor-audit-before.json > /tmp/audit-repeat.json
cmp docs/issue-17-delegation-remediation/audit-baseline.json /tmp/audit-repeat.json
git diff -- package.json pnpm-lock.yaml
git diff --check
```

**Stop/rollback:** Stop before Task 1 if the audit set/status is not the expected baseline, the normalizer is non-deterministic, or a dependency/lockfile changed. Preserve the raw output for the separate supply-chain route.

**Dependencies:** None.

---

## Task 1 — Shared budget, keyed accounting, lifetime admission, and typed cap contracts

**Purpose:** Build the run-scoped accounting foundation without requiring a live manager. Parent-cap cancellation is deliberately deferred to Task 4, after the manager and host exposure exist.

**Files likely touched (bounded):**

- `src/host/delegation/child-budget.ts`
- `src/host/delegation/run-budget.ts` (new)
- `src/host/delegation/budget-policy.ts` (new, if policy resolution does not fit in `run-budget.ts`)
- `src/host/host.ts`
- `src/host/run-handle.ts`
- `src/host/production-host.ts`
- `src/host/stub-host.ts`
- `tests/host/delegation/child-budget.test.ts`
- `tests/host/delegation/run-budget.test.ts` (new)
- `tests/host/delegation/max-children.test.ts` (new)
- `tests/host/production-host-parity.test.ts`
- `tests/host/stats.test.ts`

**Implementation requirements:**

1. Extend `ChildBudgetLedger` with settled actual spend, run reservations, per-parent settled/reserved spend, a dynamic run-cap reader, and distinct `run_cap_would_breach` / `parent_cap_would_breach` results. Track persisted terminal spend, pending pre-append child settlement, and the one live provider-cost reader separately so a current parent invocation participates in global run-cap admission exactly once. Reject invalid amounts; `settle` uses non-negative actual cost rather than the reserved maximum. Preserve admission `>` versus actual-cap `>=` semantics from `spec.md`.
2. Add `RunDelegationBudget` as the single run construction seam. Expose keyed `syncFromRecords`, `registerReservationAfterStart`, `settle({ reservationId, terminalKey, actualCost })`, `release`, parent projection, and role-lifetime admission methods. Use `child:${child_id}:${attempt}` for child terminal keys and `main:${session_file}` for main lifecycle terminal accounting. Sync must skip registered keys and never raw-add the same log roll-up on every call.
3. Resolve unmatched-start reservation amounts from exactly one pinned parent-role policy. Missing, duplicate, malformed, or non-positive `max_child_cost_usd` is a typed fail-closed error, never zero. Seed settled spend from the authoritative terminal records and residual reservations from exact unmatched attempt keys.
4. Track `max_children` as distinct durable `child_id` values per `parent_role`, across role visits and resumes. Provide a register-after-start-append operation and a remaining-cap reader. A same-child retry attempt counts once; queued/unstarted work does not count.
5. Extend `SessionTerminalReason` with `parent_cap_would_breach` and define typed child failure reason values for `run_cap_would_breach`, `parent_cap_would_breach`, and `max_children_exceeded`. This task defines the host seam only; it must not call a manager or SDK abort.
6. Update `ProductionHost.runCostSoFar`, `StubHost.runCostSoFar`, and `RunHandle.computeRunCostSoFar` to include all four terminal families exactly once. Keep parent lifecycle usage provider-only and preserve the pure roll-up's `perRole`/`perSubagent` split.

**Acceptance:**

- [ ] Reserve 5, settle at actual 1, then on a cap of 10 admit 9 and reject 10; unknown settlement/release is idempotent.
- [ ] A live parent provider cost is included once in global admission: persisted terminal 4 + live provider 2 + reserved child 3 leaves equality-admission behavior explicit, and a later sync after the parent terminal does not count the provider twice.
- [ ] Parent projection with provider cost 2 and cap 3 admits a request of 1, rejects a second request, and settlement uses actual usage while the lifecycle usage remains provider-only.
- [ ] A child terminal contributes to `runCostSoFar`, `perRun`, `perModel`, and `perSubagent`, but not `perRole`; `RunHandle` uses the same terminal set.
- [ ] A completed prior child plus a new admission reaches `max_children_exceeded` after resume; two attempts sharing one child ID consume one slot.
- [ ] A live sync containing an unmatched-but-registered start does not duplicate its reservation or terminal spend.
- [ ] No manager, reducer, or SDK cancellation is required for this task's acceptance; live callback behavior is explicitly a Task 4 acceptance.

**Focused verification:**

```text
pnpm test tests/host/delegation/child-budget.test.ts tests/host/delegation/run-budget.test.ts tests/host/delegation/max-children.test.ts tests/host/production-host-parity.test.ts tests/host/stats.test.ts
pnpm typecheck
```

**Stop/rollback:** Stop if this task requires a core/reducer change, counts attempts instead of distinct child IDs, uses policy fallback zero, double-counts a keyed terminal, or claims parent cancellation without a live manager. Revert only Task 1 files; retain the checked-in audit baseline.

**Dependencies:** Task 0.

---

## Task 2 — Harden worktree inspection and destructive cleanup seams

**Purpose:** Make path/branch safety a reusable contract before manager and recovery code call it. Normal result cleanup and resume cleanup must share this contract.

**Files likely touched:**

- `src/host/delegation/worktree.ts`
- `src/host/delegation/results.ts`
- `tests/host/delegation/worktree.test.ts`
- `tests/host/delegation/results.test.ts` (new or extend the existing result tests)

**Implementation requirements:**

1. Add typed `WorktreeManager.inspect({ path, expectedBranch })` metadata covering `exists`, symlink/realpath status, ownership (`conductor-owned`, `outside-state-dir`, `unowned`, `unknown`), exact branch match, and cleanliness/error state. Resolve/lstat the configured `stateDir/worktrees` root and reject symlinked candidates or realpaths outside the root.
2. Change the destructive seam to `remove({ path, expectedBranch })` (or an equivalent typed identity argument). Re-run realpath/ownership and exact branch validation immediately before `git worktree remove`; a prior lexical check or stale `PoolItem` is insufficient.
3. Use exact generated path and branch identity from the host-created attempt metadata. Preserve branches; never remove the primary checkout or a mismatched/unowned branch.
4. Update normal successful/no-change result cleanup to call `inspect` and guarded `remove`, not only `isWorktreeClean`. Recovery will reuse the same methods.

**Acceptance:**

- [ ] Real temporary Git tests reject a symlinked worktree path, an outside-state-dir path, and an exact branch mismatch before any destructive Git call.
- [ ] Missing, clean, dirty, inspection-error, and cleanup-error states are distinguishable.
- [ ] A cleanup interruption preserves the worktree and exposes structured warning metadata through the worktree/recovery diagnostic seam without silently changing the existing child-result contract; a retry can safely remove only a later clean, owned, branch-matching path.
- [ ] Normal result cleanup and the future recovery path use the same inspection/remove contract.

**Focused verification:**

```text
pnpm test tests/host/delegation/worktree.test.ts tests/host/delegation/results.test.ts
pnpm typecheck
pnpm lint -- src/host/delegation tests/host/delegation
```

**Stop/rollback:** Stop if any test relies on `startsWith`, if a symlink/outside path reaches `git worktree remove`, or if branch validation is omitted from the destructive seam. Revert only Task 2 files.

**Dependencies:** Task 1.

---

## Task 3 — Attempt registry and manager terminal state machine

**Purpose:** Replace parallel active maps and duplicate-terminal paths with exact attempt ownership, queue closure, and append retry semantics. This task supplies the manager callbacks that Task 4 wires to live host sessions; it does not itself construct a host-wide manager.

**Files likely touched:**

- `src/host/delegation/attempt-registry.ts` (new)
- `src/host/delegation/manager.ts`
- `src/host/delegation/child-runner.ts`
- `src/host/delegation/results.ts`
- `src/host/delegation/pool.ts`
- `tests/host/delegation/attempt-registry.test.ts` (new)
- `tests/host/delegation/manager.test.ts`
- `tests/host/delegation/manager-budget.test.ts`

**Implementation requirements:**

1. Define immutable `AttemptKey = { childId, attempt }` and a registry entry containing started-persisted state, handle, real session ID/file/model, worktree identity, usage-so-far, reservation, terminal state, and pending terminal record. The registry is the only terminal authority.
2. Reserve before admission, append `subagent_started`, then register the reservation and lifetime child slot. If the start append fails, release the reservation and do not count the child. A `max_children_exceeded` rejection never creates a start or terminal.
3. Close admission on `run_cap_would_breach`, `parent_cap_would_breach`, `cancelAll`, or run abort. Queued/unstarted tasks release reservations and return ordered cancelled results without fabricated starts; a worker racing the gate disposes an unprompted handle through the same path.
4. Route normal completion, provider failure, spawn failure, budget breach, cancellation, and late completion through one terminal writer. It captures latest usage/metadata, settles before append, and stores `settled_pending_append` plus the immutable record if append throws. A retry appends the same key without settling twice. `results.ts` only projects state and never persists terminals.
5. On child settlement, invoke a typed `onParentCapReached` callback only after the current terminal is appended; on run-cap settlement, invoke a typed `onRunCapReached` callback after the current terminal is appended. Both callbacks are one-shot and re-entry-safe. The manager does not call `reduce`.
6. Preserve the senior §9 fail-closed rule: if a run-cap breach occurs, active started siblings are cancelled and queued tasks cannot spawn. Remove the old “first two succeed, third cancelled” expectation. `run_cap_would_breach`, `parent_cap_would_breach`, and `max_children_exceeded` remain distinct.

**Acceptance:**

- [ ] Normal, spawn-error, cancellation, queued-close, budget-breach, and late-completion races produce one terminal per started exact key and no leaked reservation.
- [ ] `cancelAll` aborts only started/nonterminal handles, retains real session/worktree/usage metadata, does not duplicate completed attempts, and does not write zero-usage replacements over captured usage.
- [ ] A deferred spawn resolving after closure is disposed without prompt and does not append a start.
- [ ] Queued tasks return input-ordered cancelled results without fabricated child records; admitted child counting occurs only after durable start append.
- [ ] Terminal append failure can be retried with the same record; the budget does not settle twice.
- [ ] A persisted prior terminal plus a pending child settlement reaching the cap cancels active siblings, and a child actual-cost overshoot closes the run-cap admission path even when its reservation maximum was lower.
- [ ] Manager remains below the repository's ~400-LOC signal after extraction; split further rather than weakening state ownership.

**Focused verification:**

```text
pnpm test tests/host/delegation/attempt-registry.test.ts tests/host/delegation/manager.test.ts tests/host/delegation/manager-budget.test.ts
pnpm typecheck
```

**Stop/rollback:** Stop on any duplicate terminal, post-close prompt, fabricated start, stale metadata, leaked reservation, or old run-cap example retained as acceptance. Revert Task 3 files only.

**Dependencies:** Tasks 1–2.

---

## Task 4 — Wire one run budget and live parent-cap callbacks into hosts

**Purpose:** Expose the manager and shared budget through real ProductionHost/StubHost role sessions. This is the first task allowed to claim live parent-cap cancellation.

**Files likely touched:**

- `src/host/api.ts`
- `src/host/host.ts`
- `src/host/production-host-factory.ts` (if present in the implementation surface)
- `src/host/production-host.ts`
- `src/host/production-host-delegation.ts`
- `src/host/stub-host.ts`
- `src/host/stub-host-delegation.ts`
- `src/host/session-event-handler.ts`
- `tests/host/production-host-factory.test.ts`
- `tests/host/production-host-parity.test.ts`
- `tests/host/stub-host-delegation.test.ts`

**Implementation requirements:**

1. Extend `RoleSession` with an optional typed handle containing only `cancelAll(reason): Promise<void>`. Production and stub hosts expose it only for a role with both delegation policy and `delegate`; dispose clears it. Do not expose SDK internals to the loop.
2. Construct the config-override container, dynamic cap reader, and one `RunDelegationBudget` before `hostFactory`. Extend `HostFactoryContext` with explicit `runStateDir`, budget, and cap-reader/reference as needed. `runStateDir` is `join(baseDir, runId)` and is used for child sessions/worktrees; the JSONL log remains under `baseDir`.
3. Pass one budget reference and a parent provider-only reader (`SessionState.usage().cost`) into every role-turn manager. Sync before admission. Per-role maps may be retained as projections only; they cannot be the lifetime source of truth.
4. Wire provider growth in the shared event handler: update provider usage first, check the parent projection, then close manager admission/cancel children, set `SessionTerminalReason` to `parent_cap_would_breach`, and abort the parent session. Wire child settlement's callback in the opposite direction through the same one-shot host-owned controller: current child terminal append first, callback second, siblings next, parent abort last. The parent lifecycle usage remains provider-only.
5. Make no-delegation hosts inert and preserve old fake-host compatibility without constructing an implicit replacement ledger. Add a two-role-turn same-run test proving the exact budget object is shared and dynamic run-cap overrides are observed.

**Acceptance:**

- [ ] Two delegation-enabled role turns share one budget and cannot collectively exceed a lowered then raised dynamic run cap.
- [ ] Provider usage growth while a child is live reaches the manager, cancels children, aborts the parent, and persists exact `parent_cap_would_breach`; no child cost enters parent lifecycle usage.
- [ ] Child settlement reaching the parent cap invokes the same callback after the current terminal append and does not duplicate cancellation.
- [ ] Production and stub hosts expose the same typed manager/parent-reader contract; no extension session-tree APIs are added.
- [ ] A no-delegation run creates no manager and follows the existing path.

**Focused verification:**

```text
pnpm test tests/host/production-host-factory.test.ts tests/host/production-host-parity.test.ts tests/host/stub-host-delegation.test.ts tests/host/stats.test.ts
pnpm typecheck
```

**Stop/rollback:** Stop if a role turn constructs a new ledger, provider usage is not read before the cap callback, `parent_cap_would_breach` is string-only, or a test reaches cancellation only through a mock manager. Revert Task 4 files.

**Dependencies:** Task 3.

---

## Task 5 — Integrate real `RunHandle.abort()` and loop manager registration

**Purpose:** Prove explicit abort reaches the live manager in a real run, with correct ordering and no post-abort child spawn.

**Files likely touched:**

- `src/host/loop.ts`
- `src/host/api.ts`
- `src/host/run-handle.ts` (only if the abort closure needs the shared controller)
- `tests/host/loop-delegation-abort.test.ts`
- `tests/host/run-handle-abort-children.test.ts`
- `tests/host/api-delegation-abort.test.ts` (new)

**Implementation requirements:**

1. Register `session.delegationManager` before the parent prompt and clear it in the same `finally` that clears the active parent session. Type `RunAbortControl.setActiveDelegation` against the narrow host handle, not `unknown`.
2. `RunHandle.abort` remains idempotent and handles abort-before-registration. The bridge closes/cancels children before or atomically with parent abort, then preserves the existing user-abort `session_failed` behavior. Parent-cap callback uses its typed reason instead of being rewritten as `user_aborted`.
3. Replace direct mock-only cancellation evidence with a real API run using a deferred live parent/child session. Call `RunHandle.abort` while delegation is active and assert child aborts, exactly one cancelled terminal per started attempt, parent `session_failed`, no queued spawn after closure, and no reducer/checkpoint mutation from child activity.
4. Keep narrow unit regressions for `setActiveDelegation(null)`, no active children, second abort, and completed-run abort. If deferred timers are used, apply the repository fake-timer cleanup rule.

**Acceptance:**

- [ ] The real integration reaches the manager returned by the active `RoleSession`, not a separately mocked manager.
- [ ] Child cancellation precedes/joins parent abort, has the same reason, and leaves no live child attempt.
- [ ] Repeated abort and abort-after-completion are no-ops; no duplicate child terminal is appended.
- [ ] Child cancellation never calls `reduce` or changes `Checkpoint.active_role_session` except through the normal parent lifecycle path.

**Focused verification:**

```text
pnpm test tests/host/api-delegation-abort.test.ts tests/host/run-handle-abort-children.test.ts tests/host/loop-delegation-abort.test.ts
pnpm typecheck
```

**Stop/rollback:** Stop if evidence is only direct manager invocation, if parent-cap reason is lost, if a child prompts after abort, or if child cancellation writes a main-FSM record. Revert Task 5 files.

**Dependencies:** Task 4.

---

## Task 6 — Exact-key recovery, configured worktrees, lock, and cleanup retry

**Purpose:** Make resume reconciliation safe, reachable, idempotent, and budget-consistent.

**Files likely touched:**

- `src/host/delegation/recovery.ts`
- `src/host/delegation/worktree.ts` (only for recovery inspection helpers)
- `src/host/delegation/recovery-lock.ts` (new, if not kept in `api.ts`)
- `src/host/api.ts`
- `src/host/host.ts`
- `src/host/production-host-delegation.ts`
- `src/host/production-host.ts`
- `tests/host/delegation/recovery.test.ts`
- `tests/host/delegation/recovery-lock.test.ts` (new)
- `tests/host/delegation/worktree.test.ts`
- `tests/host/resume.test.ts`

**Implementation requirements:**

1. Add typed `Host.prepareResume()` (or an equivalent context-bearing seam). Production constructs its WorktreeManager once from explicit `runStateDir`; `prepareResume` passes that manager, records, and durable append callback to recovery. Stub returns an empty result only for legacy fixtures; production/stub integration tests use a configured manager. The API never passes `undefined`.
2. Match starts and terminals by exact `(child_id, attempt)` keys. A terminal for attempt 1 must not suppress an unmatched attempt 2 for the same child. Recovery records themselves participate in the key set, so a second scan appends zero records.
3. Resolve each orphan's reserved amount from the pinned parent-role policy. If the policy is missing/ambiguous/invalid, fail closed before synthesizing recovery or entering the loop; never use zero as a policy amount. After recovery, sync the shared budget from the post-recovery log and reconstruct role-lifetime distinct-child counts.
4. Return stable structured details for each orphan: exact key; session path status (`present`, `missing`, `placeholder`); worktree existence/ownership/symlink/branch/cleanliness; action (`removed`, `preserved`, or `not-applicable`); and any inspection/cleanup error. Check non-placeholder session paths with filesystem access; do not report placeholders as missing.
5. Append a recovery terminal before cleanup. Remove only `exists + conductor-owned + exact expected branch + clean` worktrees. Preserve dirty, missing, symlinked, outside, unowned, branch-mismatched, and cleanup-error paths. Also run the terminal-derived cleanup retry for prior successful/no-change terminals whose clean owned worktree survived an interruption; never retry cleanup for failed/cancelled terminals.
6. Acquire an atomic per-run recovery lock before scanning and hold it through recovery append, cleanup retry, and post-recovery budget sync. A concurrent resume receives typed `resume_in_progress` and performs no append/removal. Release in `finally`; do not guess through stale lock ambiguity.
7. Preserve the existing main-session crash reconciliation and `reduceLifecycle` ownership. Child recovery never calls `reduce`, changes a checkpoint, or replays child output.

**Acceptance:**

- [ ] A log with child-1 attempt-1 terminal plus child-1 attempt-2 start appends exactly one recovery terminal for attempt 2; a second scan appends/removes nothing.
- [ ] Completed prior child + new start reconstructs lifetime admission and cannot exceed `max_children`; same-child retry does not consume another slot.
- [ ] Real session files, missing paths, and placeholders produce the correct statuses and only genuine missing non-placeholder paths appear in missing metadata.
- [ ] Recovery distinguishes clean owned, dirty owned, missing, symlinked, outside/unowned, branch mismatch, and inspection/cleanup-error worktrees; `onRecord` is observed before removal.
- [ ] A custom `baseDir` proves log, session, worktree, recovery, and lock roots agree; the API order is host factory → configured prepareResume → post-recovery budget sync → loop.
- [ ] Concurrent resume is serialized and a second successful resume is idempotent.

**Focused verification:**

```text
pnpm test tests/host/delegation/recovery.test.ts tests/host/delegation/recovery-lock.test.ts tests/host/delegation/worktree.test.ts tests/host/resume.test.ts
pnpm typecheck
pnpm test tests/grep-guard.test.ts tests/extension/no-role-spawn-via-session-tree.test.ts
```

**Stop/rollback:** Stop if recovery can remove outside/symlinked/branch-mismatched paths, an earlier attempt suppresses a later attempt, policy resolution becomes zero, concurrent scans can append duplicate keys, or the loop starts before post-recovery sync. Revert Task 6 files and preserve orphan records/worktrees.

**Dependencies:** Tasks 1–5.

---

## Task 7 — Amend artifacts and run the complete gate

**Purpose:** Make the corrected contract durable and prove the repository remains green without claiming a clean audit when the baseline is non-zero.

**Files likely touched:**

- `docs/issue-17-delegation/phase-3-lifecycle-recovery.md`
- `docs/decisions/ADR-002-subagent-delegation.md`
- `docs/issue-17-delegation-remediation/spec.md` (only for verified contract deltas)
- `docs/issue-17-delegation-remediation/phase-1-lifecycle-accounting-cancellation-recovery.md` (tick performed steps only)
- `CHANGELOG.md` / `package.json` only if the prior Phase 3 commit did not already contain the accepted 0.9.0 changes; do not duplicate the bump

**Implementation requirements:**

1. Remove the contradictory “first two succeed, third cancelled” example from the original Phase 3 artifact and state senior §9 fail-closed behavior. Tick only boxes whose implementation and verification passed.
2. Amend ADR-002 with actual-spend settlement, keyed sync/registration, role-lifetime distinct-child admission, typed parent-cap callback order, pending terminal append retry, exact-attempt recovery, recovery lock, and guarded realpath/branch cleanup. Preserve accepted status and prior product decisions.
3. Run the final audit command through the same normalizer and compare the exact checked-in baseline. An unchanged eight-advisory/non-zero result is accepted only with no dependency or lockfile diff. A changed result is a stop and separate supply-chain route.
4. Inspect module sizes and diff scope. Do not tick a clean-tree/commit box merely because commands passed; the orchestrator owns commit/push. Leave no generated child worktrees/session files in the repository.

**Acceptance:**

- [ ] Original Phase 3 no longer contains the contradictory manager-budget acceptance.
- [ ] ADR-002 records the corrected accounting, lifecycle, cleanup, and recovery contracts without re-litigating senior decisions.
- [ ] Changelog/version are changed only if missing from the prior Phase 3 commit.
- [ ] Remediation boxes and original Phase 3 boxes are ticked only for verified work.

**Required final gate:**

```text
pnpm typecheck
pnpm build
pnpm test
pnpm lint
pnpm format:check
set +e
pnpm audit --json > /tmp/pi-conductor-audit-after.json
status=$?
set -e
node scripts/normalize-pnpm-audit.mjs --status "$status" /tmp/pi-conductor-audit-after.json > /tmp/pi-conductor-audit-after.normalized.json
cmp docs/issue-17-delegation-remediation/audit-baseline.json /tmp/pi-conductor-audit-after.normalized.json
git diff --check
git diff -- src/core src/manifest src/seam src/cost
git status --short
```

The final handoff reports measurable telemetry: focused and full test counts, typecheck/build/lint/format results, grep-guard result, audit baseline versus after count/status and exact delta, keyed-sync/double-count cases, recovery metadata cases, concurrent-resume lock case, and tracked-file status. A changed audit set/status, dependency/lockfile diff, failed gate, unsafe cleanup, duplicate terminal, leaked reservation, or unticked completed artifact is a stop.

**Stop/rollback:** Revert only remediation files and preserve the pushed Phase 1/2/3 baseline. Do not rewrite the senior spec or roll back the feature without an explicit release decision.

**Dependencies:** Tasks 0–6.

---

## Checkpoints

### Checkpoint A — after Tasks 1–3

- [ ] Audit baseline predates implementation and is reproducibly normalized.
- [ ] Actual-spend/keyed budget, dynamic caps, parent projections, and lifetime child admission pass focused tests.
- [ ] Worktree inspection/remove rejects symlink, outside, and branch-mismatch cases.
- [ ] Attempt registry passes normal, failed, cancelled, queued, fail-closed, append-failure, and late-completion cases with no duplicate terminal/reservation.

### Checkpoint B — after Tasks 4–6

- [ ] Production/stub role turns share one budget and use provider-only parent readers.
- [ ] Provider growth and child settlement invoke the live parent-cap callback with exact typed reason/order.
- [ ] Real `RunHandle.abort()` integration cancels active children and blocks queued spawn.
- [ ] Resume uses configured state/worktree roots, exact keys, policy fail-closed resolver, atomic lock, filesystem metadata, and idempotent safe cleanup.
- [ ] Main FSM/reducer and extension spawning guards are unchanged.

### Final checkpoint

- [ ] Tasks 0–7 acceptance criteria and verification are complete.
- [ ] Original Phase 3 artifact and ADR-002 reflect corrected behavior.
- [ ] Full repository gate and exact audit-baseline comparison are complete.
- [ ] Package is ready for plan re-review; this planner does not route directly to implementation/archive.

## Knowledge candidates (optional OKF follow-on)

1. **Delegated budget accounting is keyed and shared:** registrations occur after durable starts; child terminal settlement is actual-cost and idempotent before append; main lifecycle terminals use an immutable session key; sync never raw-adds the same record twice.
2. **`max_children` is a role-lifetime distinct-task bound:** durable child IDs, not retry attempts, reconstruct admission across resumes.
3. **Worktree cleanup is a destructive realpath/branch contract:** normal and recovery cleanup both inspect symlink/containment/ownership/expected branch immediately before removal.
4. **Resume recovery is serialized and terminal-derived:** an atomic run lock prevents concurrent scans; terminal records are authoritative and safe cleanup retry is derived from their status/path metadata.

## Out of scope (deferred)

- Recursive delegation or `max_depth > 1`.
- Unrestricted child `bash`, automatic merge/cherry-pick, UI commands, OS/network isolation, and per-child model lists.
- Any reducer/core/manifest/seam/cost change.
