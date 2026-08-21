# Issue #46 — Local-model failure recovery

## Scope

Repair the invalid fallback-exhaustion transition, preserve the upstream provider
error that Pi exposes, and make any future synthesized-handoff rejection
self-diagnosing. Authority: archived FSM spec §8.2, §9.4, §11.4, and §12.

## Findings and assumptions

- A worker fallback exhaustion has one legal target — the orchestrator — so it
  cannot produce the reported reducer rejection under a valid checkpoint and
  definition.
- An exhausted orchestrator cannot hand off to itself. The current loop tries
  this invalid transition, then hides the reducer result behind a generic
  error. An orchestrator failure must instead finish as the already-persisted
  `session_failed` terminal state.
- Pi provides the provider error through `AssistantMessage.errorMessage` on a
  `stopReason: "error"` message. Conductor currently records only
  `failure_reason: "model_error"`, losing the diagnostic.
- This change does not attempt to alter Pi/llama.cpp request cancellation or
  timeout policy. That needs a reproducible upstream trace; Pi documents
  `retry.provider.timeoutMs` and `httpIdleTimeoutMs` as relevant settings.

## Tasks

### 1. Add the persisted failure-detail contract

- [x] Add optional `failure_detail` to terminal lifecycle metadata and records.
- [x] Capture Pi's `AssistantMessage.errorMessage` when classifying
      `model_error`.
- [x] Preserve `failure_reason: "model_error"` as the stable recovery
      discriminator.
- [x] Verify with core lifecycle and host event-handler tests.

### 2. Make fallback exhaustion topology-safe and diagnosable

- [x] Write a failing integration test for an exhausted orchestrator model
      list; assert a clean `session_failed` result rather than an illegal
      self-handoff.
- [x] End an exhausted orchestrator run at its existing terminal failure.
- [x] On an otherwise impossible synthesized-worker-handoff rejection, throw
      an error with reducer reason, current/target roles, legal targets, and
      visit counts.
- [x] Verify the focused fallback suite.

### 3. Document and ship

- [x] Add an Unreleased changelog entry explaining the recovery and telemetry
      behavior.
- [x] Run formatting, typecheck, build, test, and lint (all passed).
- [x] Run the production audit; it reports pre-existing high advisories beneath
      unchanged pi peer dependencies and is documented for the PR.
- [x] Review the diff across correctness, architecture, security, performance,
      and readability.
- [ ] Create a focused PR for #46.

## Acceptance criteria

- Worker fallback exhaustion still returns control to the orchestrator.
- Orchestrator fallback exhaustion persists its `session_failed` terminal and
  returns `exitReason: "session_failed"`; it never attempts a self-handoff.
- `session_failed(model_error)` carries the upstream error text in optional
  `failure_detail` without changing the stable `failure_reason` discriminator.
- Any unexpected synthesized handoff rejection reports enough reducer state to
  diagnose it from the command error.

## Risks and mitigation

| Risk | Mitigation |
| --- | --- |
| Breaking persisted-record consumers | Add only optional `failure_detail`; retain `failure_reason`. |
| Mistaking a Pi/llama.cpp failure for conductor logic | Do not change SDK/provider settings; capture Pi's actual error text. |
| Violating hub-and-spoke topology | Test worker and orchestrator exhaustion separately. |
