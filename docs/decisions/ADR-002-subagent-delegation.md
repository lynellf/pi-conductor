# ADR-002: Bounded sub-agent delegation with isolated worktrees

## Status

Accepted (2026-07-12). The senior spec's recommendations stand; the overseer has acknowledged at end-of-loop.

## Date

2026-07-12

## Context

Issue #17 requested bounded sub-agent delegation with isolated worktrees. The senior spec (`docs/issue-17-delegation/spec.md`) enumerated four open decisions (§17) that had to be resolved before implementation:

1. **Manifest policy:** whether delegation requires both `delegation:` block and `delegate` in `tools`.
2. **Command policy:** whether child `bash` is replaced with path-confined file tools + restricted argv `run`.
3. **Model policy:** whether children inherit the parent's model chain or get a separate child model list.
4. **Cleanup policy:** whether generated branches are retained while clean worktrees are removed.

The FSM-purity invariant (`src/core` must not see delegation tasks, child payloads, or child sessions as machine state) and the single-owner rule (only the loop calls `reduce`, `reduceLifecycle`, and `host.persistRecord`) were non-negotiable design constraints.

## Decision

The following decisions were accepted based on the senior spec's analysis:

### 1. Manifest policy

Delegation requires **both** a `delegation:` block in the role config **and** `delegate` in the role's declared `tools`. Neither is force-injected. This prevents accidental delegation when only one half is configured.

Additionally, `max_child_cost_usd` is mandatory for delegation enablement. A role with a `delegation:` block but no `delegate` in tools surfaces a semantic validation error; a role with `delegate` but no `delegation:` block does not receive the tool.

### 2. Command policy

Children do **not** receive unrestricted SDK `bash`. Read-only children receive path-confined read/search/list tools plus `report_result`. Worktree children additionally receive path-confined edit/write tools and a host-owned argv-based `run` tool with no shell interpolation. The command policy is documented and tested; it is not an OS sandbox.

### 3. Model policy

A child starts with the active parent's resolved model and effort. If that model errors, the child follows the parent's already-pinned, finite retry/fallback entries in order; all attempts share the one `max_child_cost_usd` budget. There is no implicit model or uncapped fallback. Children do not get a separately configured model list.

### 4. Cleanup policy

After a successful or no-change result is durably recorded, the clean worktree directory may be removed while its branch is retained for the parent to inspect or cherry-pick. Failed, cancelled, dirty, or cleanup-error worktrees are preserved.

### 5. Budget reservation (Phase 3 addition)

Delegated usage is charged to the parent invocation's session budget for admission/cap purposes, while child usage remains in child terminal records so roll-ups do not double-count it. The parent session's own lifecycle usage field remains its provider usage only.

A host-owned `ChildBudgetLedger` tracks reserved `max_child_cost_usd` for each admitted child and settles on terminal. The ledger is consulted before each child is spawned and at every parent terminal evaluation of the run cap. The ledger is not persisted in the FSM reducer; it is reconstructed from `subagent_started` records on resume.

### 6. Cancellation propagation (Phase 3 addition)

`RunHandle.abort()` first aborts all active children (each gets a `subagent_failed` with `status: "cancelled"`), then aborts the parent session. Cancellation is idempotent: a second `abort()` call is a no-op.

### 7. Resume reconciliation (Phase 3 addition)

On `resumeRun`, records are scanned for `subagent_started` attempts without a matching terminal record. The host records them as crashed/cancelled (`failure_reason: "recovered"` or `"recovered_dirty"`), safely cleans only clean conductor-owned worktrees, and preserves dirty ones. Missing session files are surfaced as explicit recovery metadata. Reconciliation is idempotent: a second `resumeRun` does not duplicate terminal records or remove non-conductor paths.

## Consequences

### Positive

- **Bounded delegation:** finite `max_parallel`, `max_children`, `max_depth: 1`, and `max_child_cost_usd` provide hard limits on child resource usage.
- **Durable child records:** `subagent_started`, `subagent_completed`, and `subagent_failed` are persisted for observability and recovery.
- **No FSM bloat:** children are auxiliary sessions; the reducer never sees them. The FSM topology and transition rules are unchanged.
- **Worktree isolation:** children write to unique Git worktrees; the primary checkout is never modified.
- **Budget safety:** the ledger prevents a delegated batch from breaching the orchestrator's run cap.
- **Recovery:** orphan children are reconciled on resume; dirty worktrees are preserved.

### Negative

- **Host complexity:** children add a non-trivial host-side component (delegation manager, budget ledger, worktree manager, recovery logic). The host is now larger than the pure core.
- **No recursive delegation:** `max_depth > 1` is explicitly deferred.
- **No `bash` for children:** worktree children use the restricted `run` tool instead. This may limit what children can do.
- **No automatic merge/cherry-pick:** children write to branches; the parent decides integration.

## Alternatives considered

### Nested conductor runs

Rejected: the FSM would need to model child states, which violates the reducer-purity invariant and adds reducer complexity. The senior spec explicitly forbids this.

### Unrestricted child `bash`

Rejected: spec §5 decision 2 is explicit — not a sandbox. Children receive path-confined tools and a restricted `run` tool. Unrestricted shell would bypass the worktree isolation guarantee.

### Per-child model lists

Rejected: spec §5 decision 3. Children inherit the parent's model chain. This is simpler than a separate child model configuration, and the child budget (`max_child_cost_usd`) already provides the cost bound for model selection.

### Automatic merge / cherry-pick / conflict resolution

Rejected: spec §4 non-goal. The parent receives branch/commit metadata and decides integration. Automatic conflict resolution is out of scope.

### Unbounded budget (no ledger)

Rejected: without the ledger, there is no mechanism to prevent a delegated batch from exhausting the run cap mid-execution. The ledger provides the admission gate before each spawn and the settlement on terminal.
