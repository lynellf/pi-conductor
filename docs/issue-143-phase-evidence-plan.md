# Issue #143 — host-observed phase evidence

Authority: issue #143; existing packet contract: docs/issue-139-host-phase-work-packets/plan.md.

Assumptions: Only a dispatch from an accepted handoff has an unambiguous predecessor role session. For initial_run or review_route without an accepted handoff, mark predecessor evidence unavailable. Tool execution `completed` means execution terminated, **not** a passing verification. Never infer a test result from model narrative or a tool terminal alone. Artifact collection runs after acceptance; matching collected-artifact records can be included at materialization time and their keys are pinned in the saved packet.

## Tasks (sequential)

- [x] Add red projection/materializer tests for accepted-handoff predecessor correlation, cutoff isolation, unavailable evidence, untrusted claims, and bounded packet rendering. Verify with focused Vitest.
- [x] Project compact source-keyed tool terminal, artifact SHA/path, and mutation path references from durable records only; render with a fixed budget and omission counts. Preserve old packet replay schema. Verify focused Vitest, typecheck, lint.
- [x] Review provenance and limits; run build, full tests, typecheck, lint, format check and audit; tick completed steps.

## Boundaries

No new verifier or command execution, no reducer changes, no transcript or raw tool output in packets. Only predecessor session facts before the accepted handoff, plus session-correlated artifacts collected after acceptance but before packet materialization. Existing persisted packets are reused byte-for-byte on resume; historical packets need no migration.
