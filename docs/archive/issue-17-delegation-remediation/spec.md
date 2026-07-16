# Remediation Spec: Issue #17 Phase 3 Lifecycle, Accounting, Cancellation, and Recovery

**Status:** Tactical remediation package; pending plan review  
**Request class:** `remediation`  
**Controlling senior spec:** [`../issue-17-delegation/spec.md`](../issue-17-delegation/spec.md), acknowledged 2026-07-12  
**Supersedes for implementation:** the lifecycle/recovery behavior in [`../issue-17-delegation/phase-3-lifecycle-recovery.md`](../issue-17-delegation/phase-3-lifecycle-recovery.md) Tasks 3.1–3.6 only. The accepted documentation/version decisions remain in force.

## Trigger and exact delta

Review of commit `6c3063f` found eight implementation-blocking gaps in the Phase 3 artifact:

1. The audit baseline was scheduled after implementation rather than as a deterministic preflight.
2. `max_children` accounting is role-lifetime policy, but host maps reset on resume and do not reconstruct admitted starts.
3. Live parent provider usage is absent from the delegated run-cap/parent-cap contract and host cost readers.
4. The original task order requires live-manager cancellation before the manager is exposed by later tasks.
5. `parent_cap_would_breach` is not a typed host/session terminal reason, and provider-growth/child-settlement callback order is unspecified.
6. Budget registration/keying and missing manifest-policy amount resolution are underspecified and can fail open as zero.
7. Terminal settlement/append failure, cleanup retry, and concurrent resume behavior are unspecified.
8. Worktree checks are lexical only; they do not reject symlinks, verify the expected branch, or revalidate the destructive remove seam. Normal result cleanup does not share recovery's safety contract.

This package changes only those lifecycle, accounting, cancellation, and recovery contracts. The senior spec's accepted manifest, tool, model, worktree, host/core-boundary, additive-record, and no-FSM-change decisions remain authoritative.

## Authoritative behavior

### 1. Shared budget, accounting, and cap semantics

Create exactly one host-owned `RunDelegationBudget` per run before `hostFactory`. It is passed by reference through the host-factory context, production/stub hosts, every role-turn manager, and `RunHandle`'s dynamic run-cap reader. A manager must never construct a replacement ledger.

The budget contains a `ChildBudgetLedger` plus keyed synchronization and lifetime admission state:

- `persistedRunTerminalSpend` is the actual cost of every already-appended main or child terminal, keyed so each terminal contributes once.
- `pendingSettledChildSpend` is actual child cost settled before its terminal append; it is included until the keyed terminal appears in the log, then sync transfers it without adding it again.
- `reservedRunSpend` is the sum of admitted, nonterminal `max_child_cost_usd` reservations.
- `liveProviderCost` is read from the one currently active parent `SessionState` and is not in persisted `runCostSoFar` yet. The flat FSM has one active parent invocation, so the run admission formula includes this reader exactly once.
- Per-parent settled/reserved child spend is tracked by immutable parent-session identity.
- `reserve` evaluates `persistedRunTerminalSpend + pendingSettledChildSpend + liveProviderCost + reservedRunSpend + amount` against the current run cap, and evaluates `providerCost + parentSettledChildSpend + parentPendingSettledChildSpend + parentReservedChildSpend + amount` against the current parent invocation cap. Invalid, negative, non-finite, or ambiguous amounts reject fail-closed.
- Admission equality is allowed (`projected > cap` rejects); equality leaves no further admission headroom. Actual cap closure is hard-stop equality (`actual >= cap`) for provider usage, settled child usage, and the main loop's persisted run-cost check. This preserves the existing `SessionState`/loop `>=` rule while avoiding rejection of a reservation whose actual cost may be lower.
- `settle` removes the reservation and adds the non-negative actual terminal cost exactly once. `release` removes an unstarted reservation and adds no spend. Unknown IDs/keys are idempotent no-ops.
- The parent lifecycle `UsageRecord` and `SessionState.usage()` remain provider-only. Child usage is charged through the budget projection and appears in child terminal records, never copied into `perRole` or a parent lifecycle record.

Terminal keys are immutable and explicit:

- Child attempts: `child:${child_id}:${attempt}`.
- Main role-session terminals: `main:${session_file}`; `session_ended` and `session_failed` are mutually exclusive for that identity.

A child reservation is registered **after** its durable `subagent_started` append with the exact child key. `registeredReservationKeys` prevents a later log sync from creating a second reservation. `syncFromRecords` counts settled terminal keys and unmatched starts by exact attempt key; it never repeatedly adds a raw roll-up total. Since starts do not persist `max_child_cost_usd`, the sync/recovery path resolves the amount from exactly one pinned parent-role delegation policy. Missing, duplicated, malformed, or otherwise ambiguous policy is a typed fail-closed error; it must never become zero.

The persistent cost readers (`ProductionHost.runCostSoFar`, `StubHost.runCostSoFar`, `RunHandle.computeRunCostSoFar`) include `usage.cost` from `session_ended`, `session_failed`, `subagent_completed`, and `subagent_failed`, each persisted terminal key once. They intentionally remain persisted-only readers; the shared budget adds the live provider reader once for admission. The existing pure roll-up remains additive: children contribute to `perRun`, `perModel`, and `perSubagent`, but never `perRole`.

Parent-cap callbacks have one order. On provider usage growth, the event handler updates provider-only session usage, then asks the shared budget whether the parent projection has reached the hard cap. If so, it closes manager admission, cancels live children, sets the typed parent reason, and aborts the parent SDK session; the loop then persists the ordinary `session_failed` record with `failure_reason: "parent_cap_would_breach"`. On child settlement, the manager settles actual usage before writing the child's terminal; the pending actual cost participates in both the run and parent projections. If that settlement reaches the parent cap, it writes the current terminal through the single terminal writer, then invokes the same one-shot parent-cap callback to cancel siblings and abort the parent. If a prior persisted main/child terminal plus this actual cost reaches the run cap, the run-cap callback cancels active siblings even when the reservation maximum did not predict the overshoot. Callback re-entry is guarded. Run-cap settlement closes child admission/cancels active siblings with `run_cap_would_breach`; the main loop remains the only owner of any eventual machine `end` event.

`SessionTerminalReason` therefore explicitly includes `"parent_cap_would_breach"`; it is not an untyped string or a child-only failure label. Child failure reasons separately distinguish `run_cap_would_breach`, `parent_cap_would_breach`, and `max_children_exceeded`.

### 2. `max_children` is a role-lifetime task count

`max_children` limits the total number of distinct child tasks admitted by a parent role over the entire run, across role visits and resumes. Count distinct host-generated `child_id` values from durable `subagent_started` records whose `parent_role` is that role. A model retry/fallback attempt with the same child ID does **not** consume another child slot. A reservation, queued task that never started, or failed spawn before the start append does not consume a slot.

The shared admission state registers a child only after the `subagent_started` append succeeds. It reconstructs per-role distinct-child counts from all persisted starts on resume. A completed prior child followed by a new admission must reject when the lifetime count reaches the policy; a prior attempt plus a later attempt for the same child ID must count once. Batch rejection uses `max_children_exceeded`, never a run-cap reason, and creates no child start or terminal records.

### 3. Attempt lifecycle and append failures

An `AttemptRegistry` keyed by `(child_id, attempt)` is the sole authority for started/terminal state, handle, session metadata, worktree identity, usage-so-far, reservation, and immutable terminal record. Normal completion, provider failure, cancellation, queue closure, and late completion all use one idempotent terminal writer.

For a started attempt, terminal settlement happens before the terminal append as required by the senior spec. The writer records a `settled_pending_append` state and retains the immutable terminal record if `onRecord` throws. A retry appends that exact record without settling again. A process crash before the append leaves the durable start unmatched; resume conservatively reconciles it once using recoverable/zero usage, never silently releases an unknown amount or counts a terminal twice. No reservation is leaked in the live process, and no append retry creates a duplicate terminal.

A durable terminal is authoritative for cleanup. Clean successful/no-change worktrees may be removed after the append. If cleanup fails or the process stops between append and removal, a resume cleanup sweep derives pending cleanup from terminal records, re-inspects the path, and retries only clean, owned, branch-matching worktrees. Failed, cancelled, dirty, missing, unowned, or cleanup-error paths remain preserved. No extra record type is required for cleanup state because the terminal plus path/branch metadata is durable and the cleanup operation is idempotent.

Concurrent resume scans are serialized by an atomic per-run recovery lock under the explicit `runStateDir`. A second resume that cannot acquire the lock returns a typed `resume_in_progress` error; it must not append a duplicate recovery terminal or race destructive cleanup. The lock is held through child reconciliation, cleanup retry, and post-recovery budget sync, then released in `finally`.

### 4. Worktree safety contract

`WorktreeManager.inspect({ path, expectedBranch })` is the shared inspection seam for normal results and recovery. It must:

- resolve the configured `stateDir/worktrees` root with `realpath`/`lstat` and reject symlinked paths or paths whose realpath escapes the root;
- distinguish missing, outside-state-dir, unowned, inspection-error, clean, and dirty paths;
- verify the exact expected conductor branch for that child/path using Git metadata before accepting a result or cleanup; and
- return structured ownership, branch, existence, symlink, and cleanliness metadata.

The destructive `remove({ path, expectedBranch })` seam repeats the realpath, ownership, and exact-branch checks immediately before `git worktree remove`. A lexical prefix check alone is insufficient. Normal result cleanup in `results.ts` must use `inspect` and this guarded `remove`, not a recovery-only shortcut. Tests cover symlink, outside-boundary, branch-mismatch, missing, dirty, and cleanup-interruption cases.

### 5. Resume construction and ordering

Resolve `runStateDir = join(baseDir, runId)` once. Create the shared cap reader and budget before `hostFactory`; pass `runStateDir`, budget, and the log to the factory. On resume, the configured host constructs its `WorktreeManager` from that same `runStateDir` before `prepareResume`. The API then performs:

1. existing main-session crash reconciliation through `reduceLifecycle`;
2. `host.prepareResume()` using the configured worktree manager and host-owned append callback;
3. post-recovery `budget.syncFromRecords(log.records(runId))`; and
4. entry into `runWithCompletion`/the loop with that same budget.

The API never passes `undefined` as a worktree manager. Legacy fake hosts may implement an inert `prepareResume`, but production and stub integration tests must exercise the typed seam. Exact child-attempt recovery is independent of the main FSM and never calls `reduce`.

## Constraints and non-goals

- Do not change `src/core`, `src/manifest`, `src/seam`, `src/cost`, `MachineDefinition`, reducer signatures, or FSM topology.
- Do not add a dependency or change the accepted Phase 3 feature scope.
- Do not introduce nested conductor runs, recursive delegation, automatic merge/cherry-pick, or unrestricted child `bash`.
- Keep `extensions/` free of role-session spawning APIs.
- Preserve additive `subagent_*` records and the existing per-subagent observability shape.
- Preserve ADR-002's accepted manifest, command, model, and cleanup decisions; amend it only with these clarified lifecycle/accounting invariants.
- Do not tick original Phase 3 boxes until their corrected behavior and verification have actually passed.

## Assumptions

1. The senior spec §9 fail-closed run-cap behavior controls the old contradictory example: a breach cancels active started siblings and blocks queued admissions; it does not allow the first two tasks to succeed merely because they were admitted earlier.
2. `max_children` means distinct child tasks, not retry attempts, and is lifetime-scoped to the parent role because the manifest policy is role-scoped.
3. A live provider-cap callback can be made host-owned without changing the pure core: `SessionState` remains provider-only and the manager is exposed only through the typed host seam.
4. The current pre-change audit baseline is expected to be eight advisories with a non-zero exit; the deterministic preflight records the exact observed set/status before implementation. Any change is a supply-chain stop, not silently accepted here.

## Risks and stop conditions

| Risk | Mitigation / stop |
|---|---|
| Budget and log terminal are double-counted | Exact terminal keys, post-start registration, settle-before-append pending state, and sync tests across child terminal → parent terminal → next admission. Stop on any duplicate-key spend. |
| Parent provider usage or child settlement bypasses a cap | Provider-only reader plus shared parent projection; callback order tests for growth and settlement. Stop if a live manager is not reached. |
| Resume exceeds lifetime `max_children` | Count distinct durable child IDs by parent role and test completed prior child + new admission and retry same ID. Stop on any post-resume slot increase. |
| Recovery removes an unsafe path | Realpath/lstat, exact branch inspection, and destructive revalidation; normal and recovery cleanup share the same seam. Stop on any symlink/outside/branch mismatch removal. |
| Append or cleanup interruption leaves inconsistent state | Pending terminal retry, durable terminal-derived cleanup sweep, and atomic per-run recovery lock. Stop if retry can duplicate a terminal or remove a failed/dirty worktree. |
| Audit baseline hides a dependency change | Task 0 captures normalized IDs/severity/ranges/status before Task 1; final comparison requires identical set/status and no package/lockfile diff. |

## Acceptance criteria

1. A shared budget rejects `persisted terminal spend + pending actual child spend + live provider cost + reserved + requested > run cap` and the analogous parent projection, while actual settlement—not the reservation maximum—controls later admission. Equality semantics and one-time live-provider inclusion are tested explicitly.
2. Child terminal cost appears exactly once in every host/run cost reader and in `perRun`/`perModel`/`perSubagent`, while `perRole` and parent lifecycle usage remain main/provider-only.
3. A role-lifetime `max_children` count survives resume, counts distinct child IDs rather than attempts, and reports `max_children_exceeded` distinctly from run/parent cap failures.
4. A budget breach closes admission, cancels active attempts once, blocks queued spawn, and preserves the senior fail-closed run-cap behavior.
5. `parent_cap_would_breach` is a typed session reason; provider growth and child settlement both reach the live manager/parent abort path in defined order, and the exact reason is persisted.
6. Normal completion, cancellation, spawn failure, queue cancellation, terminal append failure/retry, and late completion produce no duplicate terminal or leaked reservation, with real metadata and usage where available.
7. Resume uses the configured state/worktree manager, exact `(child_id, attempt)` keys, actual session-file checks, policy fail-closed resolution, lock serialization, structured recovery metadata, safe cleanup retry, and idempotence.
8. Worktree tests reject symlinks, outside paths, branch mismatches, and cleanup interruptions; normal result cleanup uses the same inspection/remove contract.
9. Existing no-delegation behavior, core/reducer boundaries, extension spawning guards, and all repository gates remain green.
10. The original Phase 3 plan and ADR-002 record the corrected behavior; boxes are ticked only for verified work.

## Verification gates

Before Task 1, Task 0 must create and check in `audit-baseline.json` using the repository normalizer. After implementation:

```text
pnpm typecheck
pnpm build
pnpm test
pnpm lint
pnpm format:check
pnpm audit --json > /tmp/pi-conductor-audit-after.json || audit_status=$?
node scripts/normalize-pnpm-audit.mjs --status "${audit_status:-0}" /tmp/pi-conductor-audit-after.json > /tmp/pi-conductor-audit-after.normalized.json
cmp docs/issue-17-delegation-remediation/audit-baseline.json /tmp/pi-conductor-audit-after.normalized.json
```

The non-zero audit status is acceptable only when the normalized advisory/package IDs, severity, affected ranges, and status exactly match the checked-in baseline and neither `package.json` nor `pnpm-lock.yaml` changed. Also run `git diff --check`, inspect `git diff -- src/core src/manifest src/seam src/cost`, and run the extension session-tree grep guard. A changed audit set, dependency/lockfile change, unsafe cleanup, duplicate terminal, leaked reservation, or dirty artifact checklist is a stop condition.

## User questions

None. The senior spec resolves the only product contradiction; the remaining deltas are implementation correctness and wiring.
