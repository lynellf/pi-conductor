# Issue #20: Validate `ask_user` prompt semantics

## Decision

Add a small, deterministic validator immediately after the existing structural
argument checks. It rejects unmistakable bundled prompts for every control and
open-ended prompts for `confirm`; it does not try to classify arbitrary natural
language or alter the existing flat JSON Schema shape.

## Tasks

- [x] Add failing unit tests for bundled prompts, incompatible confirmations,
  accepted input/select/confirm calls, and the no-UI-call guarantee.
- [x] Implement semantic validation before the UI availability check and mutex.
- [x] Strengthen schema and tool descriptions to require one decision per call
  and separate sequential calls for several questions.
- [x] Run the focused tests, full lint/typecheck/build/test/audit gates, and
  review the change for schema and serialization regressions.
