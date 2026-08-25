---
title: Fallback Failure Terminal Record Invariant
type: concept
status: active
source_files:
  - src/host/loop.ts
  - tests/host/fallback.test.ts
  - tests/host/resume.test.ts
tags:
  - host
  - loop
  - fallback
  - terminal
  - invariant
  - lifecycle
updated_at: 2026-08-09
---

# Summary

Any host-orchestrated session spawn that fails before `session_started` is
reduced must produce a synthetic terminal lifecycle record. Without this
invariant, run projections (status pollers, record consumers, UI bindings)
would remain in a `running` state indefinitely after the error.

# Durable knowledge

- **The invariant:** `runLoop` in `src/host/loop.ts` handles spawn errors in
  a two-tier structure:
  - **Primary spawn failure** (`modelIndex === 0`): propagates up as an
    unhandled error, aborting the run. The primary has no prior lifecycle
    record to clean up.
  - **Fallback spawn failure** (`modelIndex > 0`): the primary already emitted
    `session_failed`, but the fallback failed before `session_started` could
    be reduced. The loop synthesizes a `session_failed` record with a sentinel
    session file (`<synthesized:session-failed:fallback-start>`) and
    `ZERO_USAGE`, then sets `roleOutcome = { kind: "failed" }` so the loop
    proceeds to the next model in the fallback list.
- **Sentinel session file:** The synthetic record uses
  `SYNTHESIZED_FALLBACK_FAILURE_SESSION_FILE` as its `session_file` field.
  This distinguishes it from real session failures and from the separate
  `SYNTHESIZED_UNAVAILABLE_SESSION_FILE` sentinel used for exhausted fallback
  lists. Log consumers can tell the two synthesized-event paths apart.
- **Record shape:** The synthesized `session_failed` record includes the
  attempted model (`host.getNextModel(role, modelIndex - 1)`), the
  `visit_index`, the `failure_reason` prefixed with `fallback_start_failed:`,
  and the parent session ID when available.
- **Why not just propagate:** A fallback failure is recoverable (the next model
  in the list may succeed). Propagating would abort the entire run on a
  transient startup error. Synthesizing a terminal record keeps the FSM
  correct while allowing the loop to continue.
- **UI context binding failure:** `ProductionHost.spawnRole` wraps
  `session.bindExtensions` in a try/catch that disposes the partially-created
  SDK session and rethrows. This ensures the loop receives the error and can
  synthesize the terminal record (see
  `.okf/pitfalls/session-context-staleness-guard.md`).

# Evidence

- `src/host/loop.ts` lines ~337–370 — the two-tier error handling block with
  `SYNTHESIZED_FALLBACK_FAILURE_SESSION_FILE` constant and synthesized record
  emission.
- `tests/host/fallback.test.ts` — covers: primary failure falls through to
  fallback; fallback exhaustion hands back to orchestrator; re-dispatch after
  exhaustion escalates.
- `tests/host/resume.test.ts` — covers fallback startup failure with terminal
  record verification.
- `src/host/production-host.ts` lines ~387–407 — the `spawnRole` binding
  guard that disposes on failure.

# Related

- `.okf/pitfalls/session-context-staleness-guard.md` — the staleness guard
  pattern that detects when the UI context is stale before binding.
- `src/host/loop.ts` — the orchestration loop where the invariant is enforced.
- `src/host/production-host.ts` — the host implementation that surfaces the
  binding error to the loop.
