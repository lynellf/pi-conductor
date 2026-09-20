# Delegated verification implementation plan

Status: Implementation complete; required gates pass. Full audit reports existing dev-only advisories; real Bubblewrap evidence remains environment-gated, and an independent fresh-context review is unavailable in this session.
Contract: [spec.md](spec.md). Architectural authority: `docs/archive/orchestrator-fsm-spec.md`.

## Constraints and decisions

- Preserve omitted `tools`, `verification_recipes`, and `verify` behavior exactly.
- Resolve all new authority before worktree, sandbox, session, or command creation.
- Treat the parsed/pinned manifest and accepted task metadata as the only authority after admission; never reread current YAML for queued or resumed work.
- Reuse the existing Bubblewrap materialization, operation gate, execution controller, output spool, ownership checks, and cleanup/reconciliation contracts.
- Keep recipe execution direct-argv; never construct a shell command string from recipe fields.
- Keep child verification advisory: parent inspection, integration, and repository gates remain authoritative.

## Phase 1 — manifest and seam contract

- [x] Parse and validate top-level fixed recipes with closed shapes, bounds, safe paths, and canonical byte caps.
- [x] Parse and validate profile tool ceilings/defaults and recipe authorization.
- [x] Add closed delegate task `tools` and `verification_recipe` fields.
- [x] Add the parameterless `verify()` TypeBox schema.
- [x] Preserve legacy manifests/tasks and fail closed on malformed configured policy.

Checkpoint: focused manifest/seam suites, typecheck, build, and lint pass.

## Phase 2 — admission, durability, and exact child surface

- [x] RED tests for effective tool resolution, recipe/path binding, fingerprints, record metadata, queue/resume pinning, and exact SDK tool names.
- [x] Implement pure effective-tool and recipe-binding resolution with stable sorted authority.
- [x] Include effective tools and recipe identity/content/digest in task/accepted/start metadata and fingerprints; validate legacy omission.
- [x] Thread pinned authority through prepared children, scheduler replay, fallback, and resume.
- [x] Generate prompts from the pinned effective tool set only.
- [x] Build exact file/Bubblewrap/verify tool surfaces; preserve legacy file-only and Bubblewrap defaults.

Checkpoint: focused admission/persistence/child-session suites, typecheck, build, and lint pass.

## Phase 3 — sandboxed verify execution

- [x] RED tests for parameterless verify, direct argv, sequential fail-fast execution, evaluation policies, bounded evidence, call limits, timeout/cancellation/capture failure, and restart/reconciliation.
- [x] Implement host-owned per-child recipe-call accounting and durable execution-start boundary.
- [x] Implement fixed-argv recipe execution in the existing private Bubblewrap project materialization.
- [x] Implement bounded structured verify evidence and `read_execution_output` ownership integration.
- [x] Preserve fail-closed cleanup and never replay ambiguous executions.

Checkpoint: command-tool and sandbox integration suites, typecheck, build, and lint pass; real Bubblewrap evidence is reported separately.

## Phase 4 — integrated compatibility and documentation

- [x] Credential-free stub-provider integration coverage for edit → verify fail → repair → verify pass, retained output, and validated child patch.
- [x] Keep parent patch/integration/repository verification authority explicit.
- [x] Confirm legacy file-only, legacy Bubblewrap, snapshot, source-workspace, async, and completion-protocol regressions through the final full suite.
- [x] Document configuration, security boundaries, migration, examples, and prerequisite limitations.
- [x] Run full canonical gates and `pnpm audit --prod`.
- [ ] Perform five-axis code review and an independent fresh-context adversarial review; resolve blocking findings. Self-review is complete; no independent reviewer is available in this session.

## Verification commands

Focused suites will be run incrementally:

```bash
pnpm exec vitest run tests/manifest/verification-recipes.test.ts tests/manifest/subagent-tool-policy.test.ts tests/seam/delegated-verification-delegate-task.test.ts tests/persistence/delegation-task.test.ts --maxWorkers=1 --no-file-parallelism
pnpm exec vitest run tests/host/delegated-verification-authority.test.ts tests/host/delegated-verification-durability.test.ts tests/host/delegated-verification-tool.test.ts tests/host/sandbox-child-session-integration.test.ts --maxWorkers=1 --no-file-parallelism
pnpm exec vitest run tests/host/bubblewrap-sandbox-child-context.test.ts tests/host/delegation-admission.test.ts tests/host/delegation-child-session-review.test.ts --maxWorkers=1 --no-file-parallelism
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm format:check
pnpm audit --prod
```

Real Bubblewrap tests are only claimed when the approved host prerequisites are available; mocked/unit coverage remains distinct.

Observed final gates:

- `pnpm test -- --maxWorkers=1 --no-file-parallelism`: 375 files and 4,027 tests passed.
- `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm build`, and `pnpm audit --prod`: passed.
- `pnpm audit` (full): reports two moderate Vitest/@vitest-mocker advisories and one low esbuild advisory on development-only dependency paths; no high/critical advisories. No dependency upgrade was made outside this task's scope.
- `pnpm test:sandbox -- --maxWorkers=1 --no-file-parallelism`: blocked as expected because `PI_CONDUCTOR_BWRAP`, `PI_CONDUCTOR_BWRAP_RUNTIME`, and `PI_CONDUCTOR_BWRAP_SHA256` are unset; `/usr/bin/bwrap` exists, but no approved runtime/attestation was supplied.
