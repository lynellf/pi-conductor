# Asynchronous delegation implementation decisions

Implements the approved September specification #77 after #75 merged in PR #82.
This is an implementation plan under the acknowledged specification, not a new
product specification. Luna implements; independent review owns adversarial gates.

## Durable authority

One `delegation_submission_accepted` record atomically accepts the whole validated
batch and consumes its admission allowance. Identity is the canonical tuple of
run ID, logical parent invocation ID, and actual SDK tool-call ID. The existing
loop-owned execution visit identifies a logical invocation across model fallback;
explicit resume starts a new execution visit. A canonical input fingerprint makes
repeated tool-call delivery idempotent before reading the moving checkout again.
Different inputs under the same identity reject.

The batch retains stable child handles, task/profile/context/prompt fingerprints,
base commit, projection authority, and worktree metadata. It contains no usage.
Accepted task buffers pin the actual prompt, profile and context until execution;
restart never replays them. Validation and prompt loading precede atomic acceptance.
An ambiguous acceptance append starts no children and closes admission.

Existing `subagent_started`, `subagent_completed` and `subagent_failed` remain the
physical lifecycle and sole terminal/usage records. New accepted children receive
strict ordered identity and duplicate-terminal validation in both log adapters.
A queued cancellation or restart interruption produces one failed/cancelled
terminal with no session and unknown usage. Legacy records retain their behavior.

## Scheduler and tools

Each logical parent has one scheduler and one shared `max_parallel` limit across
all submissions. Queued tasks consume admission (`max_children_per_session`), not
an active worker slot. A released slot immediately admits the next queued task.
Each selected task can be cancelled and awaited without affecting unrelated work.
A task remains outstanding until its terminal append has completed.

Keep one `delegate` tool. Submission arguments gain optional
`mode: blocking | nonblocking`, defaulting to blocking. A discriminated control
branch accepts `operation: status | result | wait | cancel` and nonempty
`child_ids`. Controls consume no admission. Blocking submission uses the same
scheduler and formats the existing ordered results. Nonblocking submission returns
stable child handles after durable acceptance, before child completion.

Task results are derived from the durable log and remain retrievable by their
parent role after fallback, resume and handoff. Reads do not delete results or
add usage. Transport forwards the actual SDK tool-call ID; bridge request IDs are
transport correlation only. Lost responses cannot create new child submissions.
Notifications are advisory and enqueue through public SDK safe-turn delivery;
child callbacks never issue a concurrent parent prompt.

## Settlement

Queued/active children prevent role handoff/end, with a correction naming handles.
Forced cost closure and abort close admission and settle children before parent
settlement. Failure/fallback/replacement cancels and awaits owned children before
parent disposal; the replacement retains spent allowance and completed results.
Unknown cleanup or ambiguous persistence stops replacement rather than claiming
settlement. Restart first checks executable ownership and interrupts accepted
unfinished children without resubmitting or guessing process identities.

## Bounded implementation slices

1. Strict batch ledger, derived state and append/reopen regressions.
2. Split existing admission/context preparation from single-child execution;
   pin profile prompts before acceptance, preserving confinement and results.
3. Shared scheduler with deterministic A/B/C gates, idempotency and cancellation.
4. Tool union, shared/RPC host wiring, lifecycle barrier and SDK notifications.
5. Durable restart, real boundary regressions, documentation, full gates and merge.

No new dependencies, service, automatic integration or extra reducer owner.
