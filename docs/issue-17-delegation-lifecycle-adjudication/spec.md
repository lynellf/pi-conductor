# Lifecycle adjudication for Issue #17 Phase 3

**Status:** Accepted senior addendum (2026-07-12)  
**Request class:** remediation follow-up  
**Controls:** This addendum supersedes `docs/issue-17-delegation/spec.md` §11 and ADR-002 §§6–7 where they conflict. It is binding on Phase 3 planning and implementation.

## Verified context and boundaries

The current implementation confirms the review findings: `RunHandle.abort()` returns on a repeated call; `api.ts` invokes child cancellation before parent abort and awaits it; `resumeRun()` accepts a trimmed but otherwise unvalidated extension argument, uses `join(baseDir, runId)` only in the plan, reconciles before any lock, and releases the proposed recovery lock before the loop. Current child recovery pairs attempts by `child_id`, not `(child_id, attempt)`. All of this is host-layer work: the reducer, `MachineDefinition`, checkpoint, and core/persistence purity boundaries remain unchanged.

## Goals and non-goals

Resolve cancellation ordering, run-state confinement, execution ownership, retry recovery, and cancellation registration without changing the FSM or adding child transitions. This does not add a UI command, automatic worktree cleanup of unsafe paths, nested delegation, or a sandbox.

## Binding decisions

### 1. Cancellation ordering and append failures

**Ordering:** cancellation closes delegation admission first. It then *initiates* SDK abort/dispose for every started child, and immediately initiates the active parent-session abort **without awaiting child terminal persistence or child abort completion**. Thus child signals are issued before the parent signal, but the operations run concurrently. Parent abort is never gated on a child abort, dispose, cleanup, or record append.

`cancelAll(reason)` must use `Promise.allSettled` for every started/nonterminal attempt. It captures available usage, attempts handles independently, and gives every attempt exactly one immutable cancellation terminal candidate through the sole terminal writer. A failed terminal append leaves that candidate and its keyed settlement/reservation in durable-in-process pending state; it does not release or fabricate a replacement record. Later cancellation calls retry the identical candidate. Terminal persistence and cleanup may continue after the parent abort has been requested.

The common cancellation controller is used by explicit user abort, parent-cap callback, and run-cap callback. Its first terminal reason wins; a later user abort must not rewrite `parent_cap_would_breach`. Parent-cap and run-cap paths have the same guarantee as explicit abort: close admission, initiate child cancellation, then initiate parent abort without waiting for terminal persistence.

### 2. Repeated abort and registration contract

`RunHandle.abort()` is request-idempotent, not call-suppressing. It records the first request/reason, then every call while the run is live delegates to the shared abort controller and awaits its current/retried cancellation work. It must not return early merely because a previous call marked the run aborted. Terminal runs remain safe no-ops.

The abort controller stores cancellation before manager or parent registration. `setActiveSession(session)` immediately requests that session's abort when cancellation is already requested. `setActiveDelegation(manager)` immediately closes it and starts/retries `cancelAll` when cancellation is already requested. Clearing a manager/session cannot erase pending terminal candidates. Registration occurs before the parent prompt; manager and live-provider reader are cleared together in the parent-session `finally`.

### 3. Run ID and state-root security boundary

`run_id` is a host identifier, not a path fragment. `startRun` must assert its minted identifier and every `resumeRun` must validate its supplied identifier before log, state, lock, session, or worktree path access. The accepted grammar is the lowercase RFC 4122 UUID v4 emitted by current `crypto.randomUUID()`:

```text
^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$
```

Reject invalid IDs (including separators, whitespace, percent encodings, and noncanonical case) with a typed invalid-run-id error. The extension may trim its command argument for UX, but that is not validation and no host API may rely on it.

Validation is necessary but insufficient. The host must canonicalize an existing configured `baseDir` using `lstat` + `realpath`; create it under a caller-selected parent only through normal directory creation. For each run, create or resolve `runStateDir` as the direct `baseDir/<validated-run-id>` child, then `lstat` and `realpath` it. It and every state subroot (`sessions`, `worktrees`, and the lock root) must be real directories, direct children of the canonical run root, and not symlinks. The lock must be created with exclusive create in that verified root and verified as the owner-created regular file. Revalidate containment before destructive worktree operations as already required.

On a validation, symlink, canonical-containment, or lock-root rejection: perform no reconciliation, append, session spawn, lock removal, or cleanup. Do not delete the suspect user-controlled path; return a typed security error for operator investigation. Only a lock file proven to be owned by the current lease token may be removed in that lease's `finally`.

### 4. Per-run execution lease

A single execution lease is required for **both `startRun` and `resumeRun`**, not merely recovery. Acquire it after the run-state root is securely resolved and before the initial snapshot/seed writes (start) or any checkpoint/log read that can lead to reconciliation (resume). Hold it through main crash reconciliation, delegation recovery/finalization, cleanup retry, budget synchronization, host construction, and the entire `runWithCompletion`/loop lifetime. Release it only when the loop settles or construction fails. A second start/resume for that run returns typed `run_execution_in_progress` and performs no state-changing operation.

The exclusive lock record includes a random lease token, PID, acquisition timestamp, and process-start identity where the platform can prove one. A contender never breaks a lock based on age. It may reclaim only a well-formed lease whose owner is conclusively absent (`kill(pid, 0)` returns `ESRCH`, with any permission/unknown result treated as live); malformed, inaccessible, or ambiguous locks fail closed as in-progress. Reclamation rechecks the lock inode/token before unlinking. The lease owner removes only its own token-matching lock in `finally`. Tests must cover same-process/multi-call contention, a live foreign owner, conclusively stale recovery, and release after completion/error.

### 5. Durable retries and task finalization

A `child_id` identifies one task and its one cost envelope; every retry gets a fresh session/worktree identity and incremented `attempt`. A writable retry creates a **new** generated worktree and branch for that attempt; no retry reuses a prior worktree or branch. This avoids accepting a later attempt against uncertain prior writes and preserves exact attempt provenance.

Add two host-owned, additive records outside the reducer:

- `subagent_retry_intent`: durable next-attempt intent after a retryable attempt terminal, with task/child identity, completed attempt, next attempt, pinned next model/effort, and envelope identity.
- `subagent_task_finalized`: exactly one durable task-envelope outcome, with child/task identity, final attempt (or last completed attempt), final status/reason, aggregate normalized usage, and timestamp.

Normal retry sequence is: append exact attempt terminal marked retryable; append retry intent; create the next attempt's isolated resources/session; append its real-metadata start; register/prompt it. Failure before a next start leaves no phantom start. A retryable terminal lacking a retry intent (crash between appends), an intent lacking its next start, or a final attempt lacking task finalization is an interrupted task, not a completed task.

Resume never starts unowned child work after the parent process crashed. It atomically finalizes each interrupted task as `cancelled`/`recovered`, appending any unmatched attempt terminal first when required, then `subagent_task_finalized`, and releases its envelope only after finalization is durable. Explicit abort follows the same finalization rule after pending attempt terminals are persisted. The retry chain continues only in the live owning manager; recovery finalizes rather than spending more on a parent invocation that no longer exists. Projection returns only finalized task results; interrupted tasks are represented as recovered cancellation. Recovery matches exact `(child_id, attempt)` and must process task-level retry/finalization state, not merely unmatched starts.

### 6. Cleanup diagnostics

`AttemptRegistry.writeTerminal` remains the only terminal/settlement/normal-cleanup
owner; `results.ts` remains a pure projection. Its host-facing outcome includes an
optional typed `cleanup_warning` diagnostic (attempt identity, inspect/remove stage,
non-sensitive error code/message, and preserved path status). The manager forwards
this to the existing host diagnostic/logging callback; it is not a new persisted
cleanup record and it does not mutate `ChildResult`. Recovery returns the same
structured diagnostic through its reconciliation result. This resolves observability
without creating a second terminal writer or an unbounded record family.

## Invariants, failure containment, and rollback

- One exact attempt start has one exact attempt terminal; one child task has one finalization record and one cost envelope across attempts.
- A failed append retains immutable retryable work; repeated abort and subsequent lease owner recovery may retry/finalize it without double settlement.
- Unsafe state roots and worktrees are preserved, never cleaned as a fallback.
- The execution lease prevents a second live loop from spawning sessions or reconciling the same run.
- Rollback is configuration/code rollback only. Preserve logs, branches, worktrees, and rejected paths for investigation; do not remove a lock or worktree unless ownership is proven.

## Acceptance criteria for tactical plan v5

1. Both controlling documents use the concurrent child-signal-first ordering and state that parent abort is not append-gated.
2. Tests prove repeated abort retries an immutable pending terminal, abort-before-manager/session registration cancels when registered, and parent-cap invokes the same cancellation bridge.
3. Invalid IDs and symlinked/outside state or lock roots make no writes or deletes; valid custom base roots remain usable.
4. A second resume/start while the first loop runs cannot reach reconciliation or spawn; a conclusively stale lease is reclaimed safely.
5. Retry attempts have distinct worktree/branch/session identities, task finalization releases the one envelope once, and every crash gap is finalized rather than orphaned or silently retried.
6. No change crosses into reducer/core state or changes the existing core invariants.

## User decisions

None. These are safety and ownership choices required to make the acknowledged delegation feature implementable.
