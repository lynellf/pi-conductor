# Issue #112 — Parent retry and terminal work admission

This repairs the existing host contract in FSM specification §§8.2, 11.4,
11.7 and 12.1 using the issue's acceptance criteria. It adds no provider retry
policy, model campaign, replay of effects, or reducer state.

## Cause and repair

An assistant error message set the parent invocation's `model_error`. The SDK
could then commit to retry and continue successfully, but the parent still
rejected its handoff against the earlier error. Delegated children already
handled the SDK retry acknowledgement; ordinary parents did not.

The installed Pi SDK 0.80.6 emits `message_end` before
`agent_end.willRetry`, computes retry eligibility in `_willRetryAfterAgentEnd`,
and drives continuation from `_handlePostAgentRun`. See the
[upstream session implementation](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/src/core/agent-session.ts).
We clear only `model_error` on the explicit retry acknowledgement. Successful
messages alone cannot clear it. Usage from the failed attempt remains charged;
an exhausted or non-retrying final error remains terminal. Later provider errors
cannot overwrite cost, abort, timeout, cleanup or delegation terminal causes.
When a different cause replaces a model error, stale model diagnostics are removed.

Ordinary shared-SDK tools consult the current invocation's terminal state before
dispatch. Delegation submissions check before waiting for their execution turn,
after acquiring it, and synchronously at the scheduler's admission boundary on
both sides of asynchronous preparation. The legacy path also checks the current
terminal state before creating a child. Retrieval/cancellation controls remain
available for accepted children. Existing loop-owned settlement still closes
delegation and awaits cleanup before recording parent lifecycle transitions.

The legacy path rechecks immediately after preparation and preserves the concrete
terminal rejection, rather than returning an ordinary batch of cancelled children.
Its regression waits until preparation has started before injecting the failure.
Removing this post-preparation check reproduces a nonterminal result; restoring
it prevents entry into the child pool and returns the specific host cause.

Handoff/end and blocked work return structured `reason: host_terminated` with a
specific `cause`, such as `model_error`, `session_cost_cap_exceeded`, or
`tool_cleanup_unconfirmed`. Optional diagnostics strip control characters and
are capped at 4096 UTF-8 bytes. A specific host cause takes priority over a bare
aborted signal. Boolean rejection callbacks remain compatible. Host rejection
never writes a capture or misclassifies valid arguments as `schema_invalid`.

## Verification plan

- [x] Reproduce intermediate error followed by SDK retry, preserve failed usage,
  and verify valid handoff eligibility, non-retry/exhaustion and terminal precedence.
- [x] Verify structured diagnostics, aborted-signal precedence and empty captures.
- [x] Verify real SDK file access and handoff after retry; one internal retry stays
  inside one retained invocation, followed by a distinct later invocation.
- [x] Verify real SDK ordinary effects remain blocked after a non-retrying failure.
- [x] Verify immediate, queued and asynchronous-preparation delegation rejection.
- [x] Complete independent review, full suite, typecheck, build, lint, format and audit.
- [x] Commit the repair and verify the rebuilt linked CLI.

Existing `delegation-loop` and `delegation-loop-review` regressions cover child
settlement before fallback disposal or cost-cap lifecycle acceptance, including
unsafe cleanup. The production delegation test also awaits child cleanup when
the parent's own abort rejects early.

Final verification (2026-09-15): 2,830 tests across 265 files passed, along with
strict typecheck, build, lint, formatting and production dependency audit (no
known vulnerabilities). The first full run exposed a changed tool registration
order; the original order was restored and the complete final run passed.
Luna implemented diagnostics, Terra implemented retry/precedence handling, and
Sol implemented admission guards; independent review findings were resolved.
The linked `conduct` resolves to this checkout's rebuilt output, whose rejection
and retry handling also passed a direct smoke check.

The deterministic provider fixtures require no credentials or paid calls. They
verify the supported retry event sequence, not the underlying network cause of
the reported timeout. The original application's run logs are not changed,
resumed or reconciled by this repair.
