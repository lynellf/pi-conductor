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

## Review gates

- [x] Ledger: atomic batch, duplicate delivery before recapture, mismatched input,
  duplicate/malformed terminal, append/reopen and interrupted queued recovery.
- [x] Admission: changing checkout, prompt or context after acceptance cannot
  change the queued task; projection confinement remains enforced.
- [x] Scheduler: gated A/B, parent action, B result/review, C starts while A is
  active; shared capacity, unrelated failure and targeted cancellation.
- [x] Lifecycle: parent model failure settles active/queued tasks before terminal
  persistence/disposal/fallback; fallback retains spent slots and completed results.
- [x] Budget: terminal child usage can close admission before another queued
  child starts; parent/run cancellation awaits executable cleanup.
- [x] Transport: shared and real RPC tools carry the actual SDK call identity;
  response loss and redelivery return original handles without resubmission.
- [x] Host: pending handles block normal handoff/end; forced closure settles
  children first; public SDK notifications queue without a concurrent prompt.
- [x] Restart: unknown executable ownership fails before reconciliation; accepted
  queued and started work is interrupted exactly once, never relaunched.
- [x] Full checks, independent review and documentation.
- [ ] Merged-tree comparison.

Admission gate: 36 focused tests across preparation, existing delegation, context
artifacts, prompts and the tool schema passed. The real Git regression verifies
that preparation creates no worktree and execution retains original file content
after the parent commits a newer checkout. Subsequent scheduler and host gates passed as recorded below.

Ledger foundation: strict batch acceptance and accepted-child lifecycle schemas
passed 61 persistence tests, including corrupt JSONL reopening, duplicate terminal
rejection, queued failures and real-session cancellation. Main verification of
the ledger, admission, seam and bridge foundations passed 107 tests across nine
files and full strict typecheck. Restart reconciliation is recorded below.

Restart reconciliation gate: 46 tests across API, delegation and persistence
passed with full strict typecheck. Accepted queued and started children receive
one durable interruption terminal, while unfinished executable ownership rejects
before reconciliation writes. Legacy child reconciliation remains covered.


Cross-layer review: independent scheduler tests reproduced append ambiguity,
first-failure replacement, cleanup and admission bugs before fixes. The real loop
regressions gate child cleanup before model-failure persistence, parent disposal,
and model replacement; failed cleanup rejects without a replacement. Orchestrator
and worker budget closure settle children before machine completion. ProductionHost
boundary tests exercise actual fatal-to-parent abort routing, live usage admission,
steering rejection/seal handling, late-notice suppression, repeated settlement and
competing parent/child abort errors. The existing production RPC suite exposed and
now guards remaining-admission reporting and late bridge responses on parent abort.
The public blocking result shape and child confinement tests remain unchanged.

The host stops parent delivery immediately during operator abort, then awaits both
parent protocol abort and child settlement. A parent abort error cannot become an
unhandled rejection while child cleanup runs, and cannot hide a child ownership
failure. This distinguishes stopping delivery from persisting parent settlement.


Final frozen implementation gate: **179 test files / 2,082 tests passed**,
including the grep guards. Strict typecheck, build, repository lint, formatting,
local documentation link targets and production dependency audit passed.
Independent review approved the final source after the RPC abort and worker
budget regressions passed. The full dependency graph retains one low esbuild
advisory with no moderate/high/critical findings. No paid provider or deployment
trial was performed.
