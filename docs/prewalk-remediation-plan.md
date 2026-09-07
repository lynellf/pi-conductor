# Prewalk MVP remediation

Scope: finish the acknowledged experimental MVP on `prewalk-projection`, not issue #70 (already merged), and open a PR. No Slice 8, live provider trials, dependency upgrades, or claim to fix issue #63. Authority: `pi-conductor-prewalk-projection-spec.md` R6–R8/R12; FSM and handoff contracts unchanged.

## Ordered tasks

- [x] R12: persist seed delivery intent with physical conversation and branch boundary; reconcile exact durable seed on resume, including both crash windows in native/projection. Do not equate `prompt()` invocation or an intent with delivery. Verify focused resume/role-session tests, typecheck, build and lint.
- [x] R6/R8: wire guide turn events to transformed executor-budget measurement, one warning, forced projection, cost/turn abort and recoverable Git checkpoint. Verify production/composite integration tests and focused budget/session suites.
- [ ] R7: collect paired read/search results from guide history, retain whole results deterministically, exclude modified paths; verify production projection and focused collector tests.
- [ ] Remove reported documentation whitespace; document SDK evidence, recovery compatibility and gate results.
- [ ] Full P2: lint, typecheck, build, test, format check, audit, diff/protected-contract checks. Review fixes against failure windows and production wiring; commit, push and open PR with honest limitations.

Dependencies: R12 before guide enforcement; retained-results collection uses the same phase adapter but is otherwise independent. Each fix gets regression evidence before implementation and its own verified commit.

## Risks / evidence

- Installed repository SDK is Pi 0.80.6; global Pi documentation describes a newer API. Runtime decisions use the repository-installed source and declarations.
- Pi 0.80.6 `core/session-manager.js::_persist` defers the first file write until an assistant message; `agent-session.js::_handleAgentEvent` notifies subscribers before appending message-end records. Neither an event callback nor a pending prompt proves durability.
- Inherited audit findings will be reported separately, not silently treated as passing.
- Guide exhaustion without a valid checkpoint cannot invent model-authored TODOs; preserve workspace/checkpoint and fail explicitly if no validated checkpoint is available.
- R12 verification: native/projection missing-marker regressions first failed (duplicate seed); focused real-SDK crash-window cases pass for accepted-before-marker and intent-before-acceptance. Full suite passed 131 files/1,754 tests before two additional real crash-window cases; the expanded four-case production suite and typecheck pass. Lint/build passed. Intent records are additive; old markers are reconciled against actual history, not trusted as proof. Missing fresh projection files are recreated only for an empty intended conversation; missing nonempty boundaries fail closed.
- R6/R8 verification: four production-composed regressions first failed (no steer, no budget abort, no cost/turn failures). Five composition cases and a real-SDK guide cap regression pass; guide failure records include usage and a Git-readable exemplar SHA. Controller clears pending guide steering before switching and measures transformed executor context; guide usage is only the cost source. Full lint/typecheck/build/test gate passed (132 files/1,762 tests). Driver contracts extracted to keep the implementation below the source-size ceiling.
- Tests are stub-provider/local-only; they establish host mechanics, not provider fidelity or economic value (Slice 8 remains deferred).
