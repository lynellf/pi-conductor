# PR #167 review follow-up

The overseer supplied the requested recovery change; this amends the earlier
conservative §5 decision without a new approval stop. Merge/release remain out of
scope. Report once after pushing the PR branch.

## Assumptions and boundaries

- Direct-child `close` observation (or proven not-started) permits bounded recovery;
  it does **not** establish descendant cleanup. All baseline cleanup remains
  `not-guaranteed`, including nominal success and recovery.
- Observed-close timeout/per-call abort returns recoverable `tool_timeout` within
  the pinned `max_recoverable_timeouts` budget. The budget is logical-invocation
  scoped and survives physical replacement/model fallback. Checkpoint resume
  that starts a new logical invocation has a new budget, as in enhanced mode.
  Exhaustion stops the
  invocation, not permanent recovery of settled historical calls.
- Explicit host/session close still closes admission and aborts its active work;
  it does not become an automatic retry. Admission is temporarily blocked during
  cancellation settlement, then can reopen only after known foreground settlement.
- Missing close or ambiguous persistence seals admission and blocks resume. A
  fulfilled arbitrary cancellation promise is not proof of a subprocess close.
- Old timeout/abort records without foreground evidence remain unresolved; never
  infer close from historical outcome, PID disappearance, or cleanup metadata.
- End guards use the same foreground observation distinction, but retain their
  own existing attempt budget. Enhanced supervision/reconciliation stays unchanged.
- Named platform gates for Linux-only full-suite files are a **separate follow-up**;
  do not skip them here merely to obtain a green macOS suite.
- Protected worktree workspaces on macOS are the next portability candidate:
  `git worktree` itself is portable, but descriptor/Git-authority/confinement and
  child lifetime contracts must be preserved. Record only; do not implement here.

## Scoped review and regression evidence

Three fresh-context, read-only static review passes examined the tracked recovery
process/controller, tool/model-error bindings, production replacement history,
record/resume validation and guards. They found concrete foreground-provenance
issues: stale earlier-child close, ordinary task settlement bypassing outstanding
children, and late close overwritten by an earlier error snapshot. Each was
reproduced RED, then corrected with per-child idempotent trackers, all-terminal
settlement checks, and a live observation of the **same** child's late close.
The last case also has an actual runner/controller fake-child integration test;
the fake has no PID and cannot signal real processes. No fourth review loop was
run; these are scoped findings and test-backed corrections, not whole-PR approval.

A separate RED enhanced-controller regression proved portable `not-guaranteed`
errors must remain an enhanced uncertainty barrier; the cleanup predicate now
maps them to `unconfirmed`, as do protected controller/verification consumers.
No enhanced proof or reconciliation predicate was relaxed. Initial recovery RED
had seven meaningful failures; the review corrections added one, three and one
failing cases, plus the enhanced-boundary failure. See final verification for
aggregate native gates and actual Linux CI, not the earlier branch's results.

Node 22.19.0's official [ChildProcess close contract](https://nodejs.org/docs/v22.19.0/api/child_process.html#event-close)
is the source for foreground observation. It is not descendant-settlement proof.

## Ordered acceptance

- [x] RED: observed-close timeout/abort recovery, signal-as-failure, bounded timeout
  budget across replacement, and legacy/unobserved/persistence barriers.
- [x] GREEN: typed foreground observation, baseline controller recovery and durable
  record/resume meaning; file-mutation paths do not remain poisoned on known close.
- [x] GREEN: production SDK tool and guard recovery; explicit close/no-close paths
  remain bounded and closed appropriately.
- [x] Remove CI runtime debug step; document restricted-procfs Linux degradation
  and strict mode; update §5, README and execution/guard guidance.
- [ ] Review changed contracts/tests; typecheck/build/lint/format/audit/diff checks,
  focused native coverage and actual full Linux CI. Preserve native-suite caveat.
- [ ] Commit/push PR branch, refresh PR evidence, and send one end report.
