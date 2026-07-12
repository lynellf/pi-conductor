# Phase 3 — Lifecycle, Accounting, Cancellation, and Recovery

**Request class:** remediation / targeted follow-up to the Phase 3 plan
**Controlling senior spec:** [`./spec.md`](./spec.md), especially §§8.5–12 and §15
**Remediation baseline:** [`../issue-17-delegation-remediation/spec.md`](../issue-17-delegation-remediation/spec.md) and its Phase 1 package
**Prior implementation baseline:** commit `6c3063f` (the original Phase 3 implementation)

This revision is the actionable implementation package. It preserves the accepted
manifest, command, model, cleanup, additive-record, host/core-boundary, and
no-FSM-change decisions. It replaces the original Tasks 3.1–3.6 lifecycle
requirements where they were too weak or contradictory. The original documentation
and version bump remain accepted, but must be amended only after the corrected
behavior is implemented and verified.

## Goal

A delegated run must remain within the pinned child and parent policies and the
current dynamic run cap, including provider usage from the active parent session.
Every started child **attempt** must have one durable terminal, including retries,
abort, provider failure, and recovery. Parent/run cancellation must reach the real
active manager without allowing a terminal append failure to strand live sessions.
Resume must serialize main-session crash reconciliation, child recovery, cleanup
retry, and budget reconstruction using the configured run-state/worktree roots.

## Constraints and non-goals

- Do not change `src/core`, `src/manifest`, `src/seam`, `src/cost`,
  `MachineDefinition`, reducer signatures, or FSM topology.
- Child activity never calls `reduce`/`reduceLifecycle` and never mutates a
  checkpoint; the main loop remains the sole owner of main lifecycle persistence.
- Preserve additive `subagent_started`, `subagent_completed`, and
  `subagent_failed` records and the existing `perRole`/`perSubagent` split.
- Preserve the accepted decisions in `docs/issue-17-delegation/spec.md` §5 and
  `ADR-002`: delegation is opt-in, children inherit the pinned parent model
  chain, worktree `bash` is not added, clean worktree directories may be removed
  only after durable success, and generated branches are retained.
- Do not add dependencies, nested conductor runs, recursive delegation,
  automatic merge/cherry-pick, a new UI command, or OS/network isolation.
- The planner does not commit or push. The orchestrator owns commit/push after
  implementation and review.

## Adversarial re-review findings — reproduced verbatim

The following is plan-reviewer-b v2's structured blocker list. Each item has an
explicit closure below; none is closed by assertion alone.

### B1 — Resume lock does not cover main crash reconciliation

**Severity:** blocker
**Evidence:** Remediation plan Task 6 lines 319-325 locks only child recovery/cleanup/sync, while its required API order at line 333 and current `src/host/api.ts` call `reconcileCrash` before host construction/prepareResume.
**Risk:** Two concurrent resumes can both observe an active main session with no terminal and append duplicate `session_failed` records/checkpoints before either acquires the child-recovery lock.
**Required change:** Acquire the atomic per-run lock before reconcileCrash (or define an equivalent lock covering all resume writes), hold it through main reconciliation, child recovery, cleanup retry, and budget sync, and test concurrent resumes with an active main snapshot.

### B2 — Child retry/fallback behavior and shared child budget are not implementable from the plan

**Severity:** blocker
**Evidence:** The controlling spec requires bounded parent-model retries/fallbacks with all attempts sharing `max_child_cost_usd` (§8.5, §15.8). Tasks 1/3 define AttemptKey and synthetic same-ID retry accounting (lines 97-99, 182-186) but never specify the production retry loop, pinned model chain, retry exhaustion, per-task aggregation, or whether reservations/actual settlements are one budget across attempts.
**Risk:** A provider failure can either stop without the required fallback or re-reserve per attempt and exceed the per-child budget/max-child cap; resume cannot reconstruct the correct residual reservation.
**Required change:** Add explicit child-runner/manager requirements and tests: retry only retryable provider errors, reuse child_id with incremented attempt, persist each attempt start/terminal with real metadata, enforce parent retries/fallbacks and one max_child_cost_usd envelope across attempts, aggregate the task result, and reconstruct that envelope on resume.

### B3 — Terminal/cleanup ownership and durable-start sequencing conflict

**Severity:** blocker
**Evidence:** Task 2 assigns normal cleanup to results.ts (lines 140-149), but Task 3 says results.ts only projects state and never persists terminals (line 185). Task 3 also says reserve→append start→register (line 183) without stating how the required real child session file is obtained; Phase 2's contract creates the session before appending the start.
**Risk:** Implementation can leave two terminal/cleanup paths, duplicate settlement, or persist a placeholder start that violates the durable real-session-file acceptance; a closure race can also leak a spawned handle.
**Required change:** Name one terminal writer/cleanup owner (with guarded inspect/remove) and make results a pure projection or revise that claim. Explicitly specify create/worktree/session metadata acquisition→durable start append→post-append registration→prompt, start-append failure rollback, and deferred-spawn disposal, with tests for each.

### B4 — The one-budget/runStateDir contract is not propagated through first-party factories

**Severity:** blocker
**Evidence:** Task 4 mentions HostFactoryContext/runStateDir/budget (line 233) but its file list omits src/extension/commands/start.ts, src/extension/commands/resume.ts, src/bin/conduct.ts, and the factory adapters that currently construct ProductionHost without these fields.
**Risk:** If fields are optional, production silently constructs a fresh/default budget and uses cwd-derived worktrees instead of the custom baseDir; if required, the plan does not identify the required adapter changes. This defeats shared budget and configured recovery roots.
**Required change:** List and update every production/stub hostFactory adapter and production factory to forward exactly one budget, runStateDir, cap reader, log, and resume seam; add a custom-baseDir production integration assertion and require the same budget object reaches all role turns and runWithCompletion.

### B5 — Parent-cap reason can be lost to the existing per-session cap path

**Severity:** blocker
**Evidence:** Task 4 line 235 asks the event handler to check the shared parent projection, but current `src/host/session-event-handler.ts` checks `SessionState.isSessionCapExceeded()` and sets session_cost_cap_exceeded before any new parent callback. The plan does not state the required precedence or reader teardown when a role terminal is reached.
**Risk:** Provider growth while children are live can persist session_cost_cap_exceeded instead of typed parent_cap_would_breach; retaining the live provider reader after session terminal also double-counts provider cost on the next role.
**Required change:** Specify and test shared-parent-projection precedence over legacy provider-only cap handling, one-shot callback ordering/re-entry, and clearing the live-provider reader exactly when the active parent session/manager is cleared.

### B6 — Abort is not fail-safe when child terminal append fails

**Severity:** high
**Evidence:** Task 3 promises pending terminal retry (line 185), while Task 5 requires cancellation before/with parent abort (lines 274-283), but no try/finally/error policy connects them.
**Risk:** A child terminal append failure can make cancelAll reject before the parent SDK session is aborted, and abort's idempotence can then prevent a retry, leaving a live parent/child or partially terminalized batch.
**Required change:** Define cancelAll to attempt every started attempt and retain pending immutable records, and define the abort bridge to always continue parent abort in finally while preserving retry state; test append failure during abort, repeated abort, and no leaked handles/reservations.

The reviewer also recorded these acceptance gaps verbatim:

- Concurrent-resume test must include main-session crash reconciliation, not only child recovery.
- Spec §8.5 child retry/fallback and shared per-task budget need explicit implementation acceptance.
- Normal cleanup must expose the promised structured warning seam without conflicting with pure results projection.

## Preserved v3 correction baseline

The following corrections from the prior remediation pass remain controlling and
must not regress:

1. Task 0 audit preflight is before lifecycle implementation and compares a
   normalized, checked-in baseline; an audit change or dependency/lockfile diff is
   a supply-chain stop.
2. `max_children` is a role-lifetime count of distinct durable `child_id` values,
   reconstructed across visits and resumes. A same-child retry attempt counts once;
   queued/unstarted work does not count.
3. Run/parent admission uses persisted terminal spend, pending settled child
   spend, the one live provider-cost reader, reservations, and the requested
   amount. Admission rejects `projected > cap`; actual hard closure uses `>=`.
4. `parent_cap_would_breach` is a typed session reason. Provider growth and child
   settlement use one host-owned, one-shot callback controller with append-before-
   callback ordering; the manager is not referenced until host wiring exists.
5. Reservations are registered only after a durable start append with an exact
   `child:${child_id}:${attempt}` key. Sync is keyed and does not raw-add the same
   log roll-up repeatedly. Missing/ambiguous policy amounts fail closed.
6. Terminal settlement is actual-cost and idempotent. Settlement-before-append
   retains an immutable `settled_pending_append` record for retry; cleanup is
   terminal-derived and retryable.
7. Resume uses an atomic per-run lock, exact attempt keys, filesystem-aware
   recovery metadata, configured state/worktree roots, and safe cleanup retry.
8. Worktree inspection/removal uses realpath/lstat, symlink/containment checks,
   ownership, exact expected branch, and cleanliness immediately before a
   destructive operation. Normal and recovery cleanup use the same seam.
9. Run-cap breach is fail-closed: active started siblings are cancelled and
   queued tasks cannot spawn. There is no “first two succeed, third cancelled”
   acceptance example.

## Ordered implementation tasks

### Task 0 — Audit and repository preflight

**Purpose:** Establish the reproducible baseline before changing lifecycle code.

**Files:**

- `scripts/normalize-pnpm-audit.mjs` (new)
- `docs/issue-17-delegation-remediation/audit-baseline.json` (new)
- `docs/issue-17-delegation-remediation/spec.md` only if the observed baseline
  must be recorded

**Work and acceptance:**

- [ ] Normalize `pnpm audit --json` using Node built-ins, explicit exit status,
      stable advisory/package sorting, and no timestamps/prose.
- [ ] Run the baseline before Task 1. The observed 2026-07-12 baseline is eight
      advisories with non-zero status; a different set/status stops this package.
- [ ] Confirm `package.json`, `pnpm-lock.yaml`, and tracked implementation files
      are unchanged at the preflight checkpoint.

**Verification:**

```text
set +e
pnpm audit --json > /tmp/pi-conductor-audit-before.json
status=$?
set -e
node scripts/normalize-pnpm-audit.mjs --status "$status" /tmp/pi-conductor-audit-before.json > docs/issue-17-delegation-remediation/audit-baseline.json
node scripts/normalize-pnpm-audit.mjs --status "$status" /tmp/pi-conductor-audit-before.json > /tmp/audit-repeat.json
cmp docs/issue-17-delegation-remediation/audit-baseline.json /tmp/audit-repeat.json
git diff -- package.json pnpm-lock.yaml
git diff --check
```

**Stop/rollback:** Stop before Task 1 for a changed advisory set/status,
non-deterministic normalization, or dependency/lockfile change. Preserve raw
output for a separate supply-chain decision.

**Dependencies:** None.

### Task 1 — One run budget, keyed accounting, and lifetime admission

**Purpose:** Replace the current reservation-only ledger with the single budget
object shared by the whole run. The current `ChildBudgetLedger.settle()` ignores
actual cost and the current cap is construction-time; those behaviors are not
sufficient for this task.

**Files:**

- `src/host/delegation/child-budget.ts`
- `src/host/delegation/run-budget.ts` (new)
- `src/host/delegation/budget-policy.ts` (new if needed)
- `src/host/host.ts`
- `src/host/run-handle.ts`
- `src/host/production-host.ts`
- `src/host/stub-host.ts`
- `src/host/stats.ts`
- `src/host/cost.ts` and `src/cost/rollup.ts` only where existing host/cost
  readers require additive child-terminal coverage; never change pure reducer
  semantics
- focused budget, stats, and parity tests

**Implementation requirements:**

1. Construct exactly one `RunDelegationBudget` before `hostFactory`. It owns the
   ledger, keyed terminal synchronization, pending pre-append child settlement,
   dynamic run-cap reader, parent-session projection, and role-lifetime distinct
   child admission. No manager or host turn may construct a replacement.
2. Count `session_ended`, `session_failed`, `subagent_completed`, and
   `subagent_failed` terminal usage once using `main:${session_file}` for main
   terminals and `child:${child_id}:${attempt}` for child attempts. Keep parent
   lifecycle usage provider-only; child cost enters `perRun`, `perModel`, and
   `perSubagent`, not `perRole`.
3. `reserve` evaluates persisted spend + pending actual child spend + the one
   live provider-cost reader + reserved spend + request against the current run
   cap and the analogous parent projection. Invalid, negative, non-finite, or
   unresolved policy amounts reject with a typed fail-closed error. Admission is
   `>`; actual closure is `>=`.
4. Reserve one `max_child_cost_usd` envelope per distinct child task, not once per
   retry attempt. Track each attempt's non-negative actual cost by terminal key
   and add it once to settled/pending spend; an intermediate retry terminal does
   not release the task envelope. Release/settle the envelope only when the task
   reaches its final terminal, and reject/close further attempts when cumulative
   actual child spend reaches the envelope. A pending settlement remains
   represented until its immutable terminal append is observed; sync never adds
   it twice.
5. Register the child reservation and lifetime slot only after the durable start
   append. Resolve unmatched starts from exactly one pinned parent-role policy;
   missing, duplicate, malformed, or non-positive policy is a typed error, never
   zero. Reconstruct exact attempt reservations and distinct child IDs on resume.
6. Expose typed `run_cap_would_breach`, `parent_cap_would_breach`, and
   `max_children_exceeded` results. A max-child rejection creates no start or
   terminal. A run-cap breach closes admission and is fail-closed.

**Acceptance:**

- [ ] Actual settlement, pending settlement, dynamic cap changes, and keyed sync
      pass equality/admission and hard-closure cases without double counting.
- [ ] A live parent provider cost is included exactly once before its main
      terminal and is removed when the active parent session/manager is cleared.
- [ ] Two role visits share the exact budget object; a completed prior child plus
      a new child reaches `max_children_exceeded`, while a same-ID retry does not.
- [ ] Child usage appears once in all run readers and additive roll-up views,
      never in parent lifecycle usage or `perRole`.
- [ ] Missing/ambiguous orphan policy amount fails closed.

**Verification:**

```text
pnpm test tests/host/delegation/child-budget.test.ts tests/host/delegation/run-budget.test.ts tests/host/delegation/max-children.test.ts tests/host/production-host-parity.test.ts tests/host/stats.test.ts
pnpm typecheck
```

**Stop/rollback:** Stop on a second ledger, attempt-counted max children,
zero-policy fallback, duplicate keyed spend, or any reducer/core change.

**Dependencies:** Task 0.

### Task 2 — Shared guarded worktree inspection and cleanup

**Purpose:** Make normal result cleanup and recovery use one destructive safety
contract rather than separate lexical checks.

**Files:**

- `src/host/delegation/worktree.ts`
- `src/host/delegation/results.ts`
- `tests/host/delegation/worktree.test.ts`
- `tests/host/delegation/results.test.ts` (new or extension)

**Implementation requirements:**

1. Add typed `inspect({ path, expectedBranch })` metadata for existence,
   placeholder/session-independent path status, symlink/lstat/realpath,
   containment, ownership, exact branch match, cleanliness, and inspection error.
   Resolve the configured `stateDir/worktrees` root and reject symlinked or
   outside realpaths.
2. Change destructive removal to `remove({ path, expectedBranch })` (or an
   equivalent identity-bearing seam). Repeat realpath, ownership, and exact
   branch checks immediately before `git worktree remove`.
3. Make the terminal writer/cleanup owner call `inspect` then guarded `remove`
   after durable successful/no-change terminal append. Preserve failed,
   cancelled, dirty, missing, outside, symlinked, unowned, branch-mismatched,
   and cleanup-error worktrees. Return structured warning metadata for cleanup
   errors without changing the child result schema.

**Acceptance:**

- [ ] Real temporary Git tests reject symlink, outside-state-dir, and exact
      branch-mismatch paths before any destructive Git call.
- [ ] Clean, dirty, missing, inspection-error, and cleanup-error outcomes are
      distinguishable and cleanup retry is safe.
- [ ] Normal and recovery cleanup use the same inspect/remove implementation.

**Verification:**

```text
pnpm test tests/host/delegation/worktree.test.ts tests/host/delegation/results.test.ts
pnpm typecheck
pnpm lint -- src/host/delegation tests/host/delegation
```

**Stop/rollback:** Stop if any removal relies only on `startsWith`, stale pool
metadata, or a lexical path check, or if normal cleanup bypasses the guarded
seam.

**Dependencies:** Task 1.

### Task 3 — Attempt registry, child retry loop, terminal writer, and projection

**Purpose:** Make each `(child_id, attempt)` durable and idempotent while
implementing the senior spec's bounded parent-model retry/fallback behavior.

**Files:**

- `src/host/delegation/attempt-registry.ts` (new)
- `src/host/delegation/child-runner.ts`
- `src/host/delegation/manager.ts`
- `src/host/delegation/results.ts`
- `src/host/delegation/pool.ts` if queue closure needs extraction
- `tests/host/delegation/attempt-registry.test.ts` (new)
- `tests/host/delegation/child-retry.test.ts` (new)
- `tests/host/delegation/manager.test.ts`
- `tests/host/delegation/manager-budget.test.ts`

**Single owner and exact sequencing:**

1. The manager/attempt registry's `writeTerminal` is the sole terminal writer,
   settlement coordinator, and post-terminal cleanup owner. `results.ts` becomes
   a pure projection from registry state to ordered `ChildResult[]`; it persists
   no records and removes no worktrees.
2. For each task, reserve one envelope, create the worktree if required, create
   the child SDK session, and obtain its real `sessionFile`, session ID, model,
   worktree path, branch, and base commit. Only then append `subagent_started`.
   Register the reservation and lifetime slot after that append succeeds, then
   prompt. Never append a placeholder start.
3. If worktree/session creation fails before a durable start, release the
   envelope, dispose any handle, and guarded-clean a newly-created clean owned
   worktree; no child start or terminal is fabricated. If the start append
   fails, abort/dispose the handle, release the unregistered reservation, and
   perform the same warning-producing cleanup. A deferred spawn that resolves
   after queue closure is disposed without prompt or start record.
4. Retry only retryable provider/model errors. Pin the parent's resolved finite
   model chain and effort when the manager is created; do not invent an implicit
   model or fallback. Reuse the same `child_id`, increment `attempt`, create a
   fresh child session file, and persist a new real-metadata start and terminal
   for every attempt. Extend the typed child failure-reason union with
   `retryable_model_error` (or an equally explicit discriminant) so an
   intermediate retryable provider failure is durable and distinguishable from
   final exhaustion. Reuse the task's one cost envelope across attempts: record
   each attempt's actual cost against that envelope, keep the reservation until
   the final task terminal, and do not reserve a fresh `max_child_cost_usd`
   amount for a fallback. Exhaustion produces one failed task projection after
   all attempt terminals are durable.
5. The task result aggregates its attempts in input order and exposes the final
   outcome plus normalized total usage and host metadata. `max_children` counts
   the one child ID, not attempts. Resume reconstructs the envelope from exact
   attempt keys and all attempt terminal spend.
6. Normal completion, provider failure, cancellation, run/parent budget breach,
   queued closure, spawn failure, and late completion all call `writeTerminal`.
   It records the attempt's actual usage before append, retains an immutable
   `settled_pending_append` record if append fails, and retries that exact record
   without adding spend twice. Final-task settlement releases the envelope only
   after the final terminal is durable; a terminal key already closed is a no-op.
7. `writeTerminal` invokes typed parent/run-cap callbacks only after the current
   terminal append succeeds. Callback re-entry is one-shot and safe. On a
   run-cap breach it closes admission, cancels active started siblings, and
   prevents queued spawn; it does not mutate the FSM.

**Acceptance:**

- [ ] A retryable provider failure follows the pinned parent model chain, uses
      attempts 1..N with one child ID and one cost envelope, persists real start
      and terminal metadata per attempt, and aggregates the task result.
- [ ] Two attempts with costs 0.4 and 0.5 on a 1.0 envelope settle once each,
      while a third attempt is rejected at the envelope cap; the run reader
      counts 0.9 exactly once.
- [ ] Non-retryable failure and retry exhaustion produce a failed task while
      successful siblings continue.
- [ ] Normal, spawn-error, cancellation, queue-close, budget-breach, append-
      failure/retry, and late-completion races produce one terminal per started
      exact key and no leaked reservation/handle.
- [ ] A deferred spawn never prompts or fabricates a start after admission closes.
- [ ] Results projection contains no persistence or cleanup side effect.
- [ ] Parent-cap callback is observed only after current terminal append.

**Verification:**

```text
pnpm test tests/host/delegation/attempt-registry.test.ts tests/host/delegation/child-retry.test.ts tests/host/delegation/manager.test.ts tests/host/delegation/manager-budget.test.ts
pnpm typecheck
```

**Stop/rollback:** Stop on duplicate terminal keys, per-attempt re-reservation,
placeholder session files, post-close prompts, a second terminal writer, or any
old “first two succeed, third cancelled” expectation.

**Dependencies:** Tasks 1–2.

### Task 4 — Propagate one budget/runStateDir and wire live parent-cap callbacks

**Purpose:** Expose the real manager and shared accounting through every
first-party production/stub construction path. This is the first task allowed to
claim live child cancellation from parent provider-cap growth.

**Files:**

- `src/host/api.ts`
- `src/host/host.ts`
- `src/host/production-host-factory.ts`
- `src/host/production-host.ts`
- `src/host/production-host-delegation.ts`
- `src/host/stub-host.ts`
- `src/host/stub-host-delegation.ts`
- `src/extension/commands/start.ts`
- `src/extension/commands/resume.ts`
- `src/bin/conduct.ts`
- `src/host/session-event-handler.ts`
- production/stub factory, parity, baseDir, and parent-cap tests

First run this bounded discovery and include every first-party construction
result in the implementation diff:

```text
grep -RIn --include='*.ts' 'createProductionHost\|hostFactory' src/extension src/bin src/host tests
```

**Implementation requirements:**

1. Extend `HostFactoryContext` and the production factory run context with
   required `runStateDir`, the one `RunDelegationBudget`, the dynamic cap reader,
   the run log, and the typed resume seam. Do not use optional fields to create
   a default replacement. `runStateDir` is exactly `join(baseDir, runId)`;
   session, child, worktree, and recovery roots derive from it while the JSONL
   run log remains under `baseDir`.
2. Forward those exact references through `start.ts`, `resume.ts`,
   `src/bin/conduct.ts`, `createProductionHost`, `ProductionHost`,
   `ProductionHostDelegation`, `StubHost`, `StubHostDelegation`, and
   `runWithCompletion`. `RunHandle`'s dynamic cap closure and every role-turn
   manager receive the same budget object and cap reader; no per-role map is the
   lifetime source of truth. A custom-baseDir production integration test must
   assert the configured roots and object identity across two role turns.
3. Extend the role-session host seam with only a narrow typed child cancellation
   handle. Register the active manager before the parent prompt and clear its
   manager and live provider reader in the same `finally` that clears the active
   parent session. The manager is not referenced by the loop until this wiring
   exists.
4. On provider usage, update provider-only session usage first, then evaluate
   the shared parent projection. Parent projection has precedence over the
   existing `isSessionCapExceeded()` path. On breach, close manager admission,
   cancel children, set typed `parent_cap_would_breach`, and abort the parent;
   the loop persists that exact reason. Only when the shared projection is not
   breached may legacy `session_cost_cap_exceeded` win.
5. The child-settlement callback path is current child terminal append, then
   one-shot parent/run callback, then sibling cancellation, then parent abort.
   Preserve provider-only parent lifecycle usage and guard callback re-entry.
6. No-delegation hosts remain inert and existing fake-host compatibility is
   preserved without constructing an implicit ledger.

**Acceptance:**

- [ ] Every first-party factory forwards one budget, `runStateDir`, cap reader,
      log, and resume seam; no cwd-derived fallback remains in production.
- [ ] A custom-baseDir production run creates sessions/worktrees/recovery state
      below the configured run state root and both role turns share object identity.
- [ ] Provider growth while a real child is live reaches the manager before the
      legacy cap path, cancels children, aborts the parent, and persists exact
      `parent_cap_would_breach`; child cost is absent from parent lifecycle usage.
- [ ] Child settlement reaching a parent cap calls the callback after append and
      does not duplicate cancellation. Reader teardown is asserted after terminal.
- [ ] A no-delegation run follows the pre-Phase-3 path and creates no manager.

**Verification:**

```text
pnpm test tests/host/production-host-factory.test.ts tests/host/production-host-parity.test.ts tests/host/stub-host-delegation.test.ts tests/host/parent-cap.test.ts tests/host/base-dir-delegation.test.ts
pnpm typecheck
pnpm lint -- src/host src/extension src/bin tests/host
```

**Stop/rollback:** Stop if any adapter omits the fields, creates a second
budget, uses cwd-derived worktrees, loses the typed reason, checks legacy cap
first, or keeps the live provider reader after the active parent is cleared.

**Dependencies:** Task 3.

### Task 5 — Fail-safe real `RunHandle.abort()` integration

**Purpose:** Prove explicit abort reaches the active production/stub manager and
cannot strand the parent when child terminal persistence fails.

**Files:**

- `src/host/loop.ts`
- `src/host/api.ts`
- `src/host/run-handle.ts` only if the shared abort controller requires it
- `src/host/delegation/manager.ts` / `attempt-registry.ts` for retry state
- `tests/host/api-delegation-abort.test.ts` (new)
- `tests/host/run-handle-abort-children.test.ts`
- `tests/host/loop-delegation-abort.test.ts`

**Implementation requirements:**

1. `cancelAll(reason)` attempts every started/nonterminal exact attempt, captures
   latest available usage/metadata, aborts and disposes every handle using
   `allSettled`, and routes each through the single terminal writer. It retains
   immutable pending terminal records and pending budget state when an append
   throws; one append failure must not stop other children or parent abort.
2. The abort bridge marks the request once, calls child cancellation, and always
   continues to `host.abortSession(parent, reason)` in `finally`. A repeated
   abort is idempotent in its external effects but retries pending terminal
   appends and awaits the same cancellation completion; it cannot suppress the
   only retry opportunity. Pending reservations/handles are cleared only after
   successful terminal append or an explicit retained pending state.
3. Register/clear the real manager around the parent prompt, handle abort-before-
   registration, and block queued work after closure. Parent user abort retains
   the existing `session_failed` behavior; parent-cap abort retains its typed
   reason and is not rewritten to `user_aborted`.
4. Child cancellation must not call `reduce`, alter `active_role_session`, or
   persist more than one terminal per started attempt.

**Acceptance:**

- [ ] A real deferred API run aborts active children, records exact cancelled
      terminals with captured usage, blocks queued spawn, and leaves no live child.
- [ ] If one child terminal append fails, all other children are attempted and
      parent abort still occurs; a repeated abort retries the immutable pending
      record without duplicate settlement/terminal.
- [ ] Abort-before-registration, no active children, second abort, and completed-
      run abort are no-ops or safe according to the existing contract.
- [ ] The parent receives the same abort reason and child activity never reaches
      the reducer/checkpoint.

**Verification:**

```text
pnpm test tests/host/api-delegation-abort.test.ts tests/host/run-handle-abort-children.test.ts tests/host/loop-delegation-abort.test.ts
pnpm typecheck
```

**Stop/rollback:** Stop on a direct mock-only proof, a parent abort skipped after
append failure, zero-usage replacement over captured usage, a duplicate terminal,
or a live handle/reservation after repeated abort.

**Dependencies:** Task 4.

### Task 6 — Serialized resume, configured recovery, and cleanup retry

**Purpose:** Close B1 and the recovery acceptance gaps. The lock covers main
crash reconciliation as well as child writes and cleanup.

**Files:**

- `src/host/delegation/recovery-lock.ts` (new)
- `src/host/delegation/recovery.ts`
- `src/host/delegation/worktree.ts` only for shared inspect/remove helpers
- `src/host/api.ts`
- `src/host/host.ts`
- `src/host/production-host.ts`
- `src/host/production-host-delegation.ts`
- `src/host/stub-host.ts`
- `src/extension/commands/resume.ts`
- `src/bin/conduct.ts` if its resume adapter exists
- recovery-lock, recovery, worktree, and resume integration tests

**Required API order and lock scope:**

1. Resolve `baseDir`, then `runStateDir = join(baseDir, runId)`, load the
   checkpoint/manifest, and construct the shared cap reader and one
   `RunDelegationBudget` before invoking `hostFactory`.
2. Acquire an atomic per-run lock under `runStateDir` **before calling
   `reconcileCrash`**. Use exclusive creation (`open(..., "wx")` or equivalent)
   and a typed `resume_in_progress` error; do not guess through stale-lock
   ambiguity.
3. In one `try/finally` while holding the lock: run existing main-session crash
   reconciliation through `reduceLifecycle`; construct the configured host with
   `runStateDir`, budget, and log; call typed `host.prepareResume()` using that
   host's already-constructed `WorktreeManager`; append child recovery records;
   retry cleanup derived from prior successful/no-change terminals; synchronize
   budget from the post-recovery records; then release the lock.
4. Only after post-recovery sync and lock release enter `runWithCompletion`/the
   loop with that exact budget. The API never passes `undefined` as a production
   worktree manager. Legacy fake hosts may use an inert typed seam only where a
   test explicitly documents that compatibility path.

**Recovery requirements:**

- [ ] Match each start and terminal by exact `(child_id, attempt)`; attempt 1
      cannot suppress an unmatched attempt 2 for the same child.
- [ ] Resolve orphan envelope amount from the pinned parent-role policy and fail
      closed before synthesizing recovery if it is missing/ambiguous/invalid.
- [ ] Check real non-placeholder session files and report `present`, `missing`,
      or `placeholder` explicitly. Missing files are recovery metadata, never
      success.
- [ ] Append the orphan `subagent_failed` terminal before any cleanup. Use
      shared guarded inspect/remove and preserve dirty, missing, symlinked,
      outside, unowned, branch-mismatched, and cleanup-error paths.
- [ ] Retry cleanup only for terminal-derived successful/no-change records whose
      clean owned branch-matching worktree survived interruption; never retry
      failed/cancelled paths. A second recovery scan appends/removes nothing.
- [ ] Reconstruct role-lifetime distinct children and all attempt-envelope spend
      from the post-recovery log.

**Acceptance:**

- [ ] Two concurrent resumes with an active main snapshot cannot both append
      `session_failed` or a duplicate checkpoint; the second receives typed
      `resume_in_progress` and performs no removal.
- [ ] A log with attempt 1 terminal and attempt 2 start appends exactly one
      attempt-2 recovery terminal; a second resume has zero effects.
- [ ] A custom `baseDir` proves log, session, worktree, recovery, and lock roots
      agree, and the order is lock → main reconciliation → configured child
      recovery/cleanup → budget sync → loop.
- [ ] Real filesystem metadata and cleanup warnings are returned for all missing,
      dirty, symlink, outside, branch-mismatch, and interruption cases.

**Verification:**

```text
pnpm test tests/host/delegation/recovery.test.ts tests/host/delegation/recovery-lock.test.ts tests/host/delegation/worktree.test.ts tests/host/resume.test.ts tests/host/concurrent-resume.test.ts
pnpm typecheck
pnpm test tests/grep-guard.test.ts tests/extension/no-role-spawn-via-session-tree.test.ts
```

**Stop/rollback:** Stop if the lock is acquired after `reconcileCrash`, if a
second resume can append/remove, if `undefined` worktree state reaches
production, if policy resolves to zero, or if any unsafe path can be removed.

**Dependencies:** Tasks 1–5.

### Task 7 — Amend durable artifacts and run the repository gate

**Files:**

- `docs/issue-17-delegation/phase-3-lifecycle-recovery.md`
- `docs/decisions/ADR-002-subagent-delegation.md`
- `CHANGELOG.md` / `package.json` only if the accepted `0.9.0` changes are
  absent; do not duplicate the existing bump
- remediation checklists only for boxes whose implementation was actually verified

**Requirements:**

- [ ] Amend ADR-002 with actual-cost/keyed budget settlement, one shared budget,
      role-lifetime admission, typed parent-cap callback ordering, one terminal
      writer, retryable pending append, exact-attempt recovery, lock scope, and
      guarded normal/recovery cleanup. Do not re-litigate accepted product decisions.
- [ ] Remove the contradictory old manager-budget example from this plan and any
      artifact that still claims admitted siblings may complete after a fail-closed
      run-cap breach.
- [ ] Leave checkboxes unchecked for corrected behavior until its focused tests
      and acceptance have actually passed. Do not claim a clean tree or commit;
      the orchestrator owns that gate.

**Required final verification:**

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
git grep -nE 'ctx\.(newSession|fork)\(' -- 'extensions/**/*.ts' || true
git status --short
```

The final implementation handoff must report focused/full test counts,
typecheck/build/lint/format results, grep-guard result, audit baseline versus
after count/status and exact delta, keyed-sync/double-count cases, retry/envelope
cases, append-failure abort case, recovery metadata/cleanup cases, concurrent
resume lock case, and tracked-file status.

**Stop/rollback:** A changed audit set/status, dependency/lockfile diff, failed
gate, duplicate terminal, leaked reservation, unsafe cleanup, or unticked
completed artifact is a stop. Revert only the implementation task's files and
preserve the accepted senior decisions.

**Dependencies:** Tasks 0–6.

## Checkpoints

### Checkpoint A — after Tasks 1–3

- [ ] Audit baseline predates implementation and compares deterministically.
- [ ] One budget passes actual-spend, keyed-sync, dynamic-cap, parent-projection,
      and role-lifetime admission tests.
- [ ] Worktree inspect/remove rejects symlink, outside, and branch mismatch.
- [ ] Child retry/envelope and attempt registry pass normal, failed, cancelled,
      queued, fail-closed, append-failure, and late-completion cases.

### Checkpoint B — after Tasks 4–6

- [ ] Every first-party factory shares one budget and configured `runStateDir`.
- [ ] Provider growth and child settlement reach the live manager with typed
      reason and specified callback order; provider reader teardown is tested.
- [ ] Real `RunHandle.abort()` survives append failure and repeated abort.
- [ ] Resume lock covers main crash reconciliation through post-recovery sync;
      exact-key recovery and safe cleanup are idempotent.
- [ ] Main FSM/reducer and extension spawning guards are unchanged.

### Final checkpoint

- [ ] Tasks 0–7 acceptance and verification are complete.
- [ ] Phase 3 and ADR-002 describe only verified corrected behavior.
- [ ] Full repository gate and exact audit-baseline comparison are complete.
- [ ] Package is ready for final implementation/review/archive gates.

## Verification-facing file map

The implementation may touch only the bounded surfaces named above plus tests
needed to prove them. Before editing any adapter, enumerate all first-party
`hostFactory`/`createProductionHost` call sites with the discovery command in
Task 4. The expected production wiring includes:

- `src/host/api.ts`, `host.ts`, `run-handle.ts`, `loop.ts`,
  `session-event-handler.ts`;
- `src/host/production-host*.ts`, `stub-host*.ts`, and
  `src/host/delegation/{child-budget,run-budget,budget-policy,attempt-registry,child-runner,manager,results,recovery,recovery-lock,worktree}.ts`;
- `src/extension/commands/start.ts`, `src/extension/commands/resume.ts`, and
  `src/bin/conduct.ts`;
- focused host/delegation/resume tests and the repository gate tests.

No UI design or user product decision is outstanding. The accepted senior
specification supplies the required design; remaining unknowns are implementation
wiring and are covered by bounded discovery, typed seams, and stop conditions.

## Out of scope

- Recursive delegation or `max_depth > 1`.
- Unrestricted child `bash`, automatic merge/cherry-pick, new UI commands, OS or
  network isolation, and per-child model lists.
- Any reducer/core/manifest/seam/cost change.
- Silent policy fallback, fabricated session metadata, or cleanup based only on
  lexical path prefixes.
