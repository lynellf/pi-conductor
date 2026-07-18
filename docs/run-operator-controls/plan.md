# Implementation Plan: Run Operator Controls

Status: Complete
Spec: [`docs/run-operator-controls/spec.md`](./spec.md)

## Overview

Implement the accepted run-level operator controls in risk-first slices: prove the
mailbox and sealing semantics first, thread them through the host loop and public
handle second, then add the extension commands and complete an adversarial review.

## Architecture Decisions

- One `RunControl` owns live abort, steering, mailbox, and latest-response state.
- Native pi `steer` is used only while an unsealed role session is addressable.
- Conductor `followUp` stays in the run mailbox and never uses native same-session
  `AgentSession.followUp()`.
- Sealing synchronously reclaims undelivered SDK steering for the next prompt boundary.
- Clipboard I/O remains in the extension; `RunHandle` exposes response data.
- New logic lives in focused modules. The legacy 980-line loop is edited surgically,
  not broadly refactored; the production role-session wrapper is extracted because it
  is directly changed and its source file is already oversized.

## Phase 0: Contract and Plan

### Task 0.1: Accept the spec and record the phase plan

**Acceptance criteria:**

- [x] Spec status records the overseer's acknowledgement.
- [x] Plan orders work by dependency and risk.
- [x] Every task has explicit verification and likely files.

**Verification:**

- [x] `pnpm format:check`
- [x] `git diff --check`

**Dependencies:** None

**Files:** `docs/run-operator-controls/spec.md`, `docs/run-operator-controls/plan.md`

## Phase 1: Run-Control Foundation

### Task 1.1: Define the run-control contract with failing tests

**Acceptance criteria:**

- [x] Tests define typed errors, mailbox order, terminal closure, abort parity, and
      immutable latest-response snapshots.
- [x] Tests fail because `RunControl` and the new public types do not exist.

**Verification:**

- [x] `pnpm exec vitest run tests/host/run-control.test.ts --maxWorkers=1 --no-file-parallelism`

**Dependencies:** Task 0.1

**Files:** `tests/host/run-control.test.ts`, `src/host/run-control.ts`

### Task 1.2: Implement mailbox, active steering, and response capture

**Acceptance criteria:**

- [x] Active steering delegates once; boundary steering and follow-up queue in order.
- [x] Empty/terminal/unavailable cases throw typed errors.
- [x] Assistant `message_end` updates the latest response using existing text extraction.

**Verification:**

- [x] Focused run-control tests pass.
- [x] `pnpm typecheck`

**Dependencies:** Task 1.1

**Files:** `src/host/run-control.ts`, `tests/host/run-control.test.ts`

### Task 1.3: Add synchronous seal subscriptions and queue reclamation

**Acceptance criteria:**

- [x] `SessionSeam.seal()` notifies subscribers exactly once.
- [x] An active session becomes non-addressable at seal time.
- [x] Only still-queued conductor steering is reclaimed without duplication.

**Verification:**

- [x] `pnpm exec vitest run tests/host/run-control.test.ts tests/host/tools.test.ts --maxWorkers=1 --no-file-parallelism`

**Dependencies:** Task 1.2

**Files:** `src/host/seam.ts`, `src/host/host.ts`, `src/host/run-control.ts`, `tests/host/run-control.test.ts`

### Checkpoint A: Foundation

- [x] Focused tests pass.
- [x] Typecheck passes.
- [x] No pure-core file imports pi.

## Phase 2: Engine and Public API

### Task 2.1: Integrate prompt-boundary guidance and deferred end

**Acceptance criteria:**

- [x] Pending guidance is appended to the next prompt seed exactly once.
- [x] Handoff/session-failure guidance reaches the next active role or recovery prompt.
- [x] A pending message defers an uncommitted `end` and re-prompts the orchestrator.

**Verification:**

- [x] `pnpm exec vitest run tests/host/loop.test.ts --maxWorkers=1 --no-file-parallelism`

**Dependencies:** Checkpoint A

**Files:** `src/host/loop.ts`, `src/host/run-control.ts`, `tests/host/loop.test.ts`

### Task 2.2: Expose RunHandle controls and construct one control per run

**Acceptance criteria:**

- [x] `RunHandle` delegates `steer`, `followUp`, and `latestResponse` to shared state.
- [x] Start and resume construct/close the control without changing abort behavior.
- [x] Host and package barrels export the documented types and error.

**Verification:**

- [x] `pnpm exec vitest run tests/host/run-handle.test.ts tests/host/api.test.ts tests/host/resume.test.ts --maxWorkers=1 --no-file-parallelism`
- [x] `pnpm typecheck`

**Dependencies:** Task 2.1

**Files:** `src/host/api.ts`, `src/host/run-handle.ts`, `src/host/index.ts`, `src/index.ts`, `tests/host/run-handle.test.ts`

### Task 2.3: Wire real and stub role-session steering capabilities

**Acceptance criteria:**

- [x] Shared role-session adapter forwards SDK `steer`, `clearQueue`, seal state, and
      seal subscription without using native follow-up.
- [x] Production and stub hosts use the same adapter and remain below their prior size.
- [x] Existing session cleanup behavior remains intact.

**Verification:**

- [x] `pnpm exec vitest run tests/host/production-host-spawn.test.ts tests/host/e2e.test.ts --maxWorkers=1 --no-file-parallelism`
- [x] `pnpm typecheck`

**Dependencies:** Task 2.2

**Files:** `src/host/role-session.ts`, `src/host/production-host.ts`, `src/host/stub-host.ts`, `tests/host/production-host-spawn.test.ts`

### Checkpoint B: Engine

- [x] Run-control, loop, API, resume, and production-host focused tests pass.
- [x] Build succeeds.
- [x] Abort, sealing, and single-owner invariants remain covered.

## Phase 3: Extension UX

### Task 3.1: Retain the most recent run and implement copy

**Acceptance criteria:**

- [x] Clearing the active slot retains the most recently started handle.
- [x] `/conduct:copy` selects active then most recent and copies exact response text.
- [x] Missing response and clipboard failures produce one clear notification.

**Verification:**

- [x] `pnpm exec vitest run tests/extension/active-run.test.ts tests/extension/conduct-copy.test.ts --maxWorkers=1 --no-file-parallelism`

**Dependencies:** Checkpoint B

**Files:** `src/extension/active-run.ts`, `src/extension/commands/copy.ts`, `tests/extension/active-run.test.ts`, `tests/extension/conduct-copy.test.ts`

### Task 3.2: Implement steer/follow-up commands and registration

**Acceptance criteria:**

- [x] Commands validate usage, select only the active handle, and surface typed errors.
- [x] All three commands register through the existing extension factory/harness.
- [x] Acceptance notifications do not promise a target role.

**Verification:**

- [x] `pnpm exec vitest run tests/extension/conduct-steering.test.ts tests/extension/conduct-registration.test.ts --maxWorkers=1 --no-file-parallelism`

**Dependencies:** Task 3.1

**Files:** `src/extension/commands/steer.ts`, `src/extension/commands/followup.ts`, `extensions/conduct.ts`, `tests/extension/conduct-steering.test.ts`, `tests/extension/conduct-registration.test.ts`

### Checkpoint C: User Flow

- [x] Focused extension tests pass.
- [x] Library and TUI surfaces share the same handle state.
- [x] `/conduct:copy` excludes tool summaries by construction.

## Phase 4: Review and Verification

### Task 4.1: Adversarially review boundary and terminal behavior

**Acceptance criteria:**

- [x] Review isolates the mailbox/seal/end artifact against the accepted spec.
- [x] Every finding is classified and all actionable findings are resolved.
- [x] Cross-model review is explicitly offered before reconciliation.

**Verification:**

- [x] Changed focused tests remain green after review fixes.

**Dependencies:** Checkpoint C

**Files:** Changed implementation and tests only

### Task 4.2: Complete repository-wide verification and review

**Acceptance criteria:**

- [x] Five-axis code review finds no unresolved critical/important issues.
- [x] Spec success criteria and all completed plan boxes are checked.
- [x] No unrelated source changes are included.

**Verification:**

- [x] `pnpm lint`
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`
- [x] `pnpm format:check`
- [x] `pnpm audit`
- [x] `git diff --check`

**Dependencies:** Task 4.1

**Files:** `docs/run-operator-controls/spec.md`, `docs/run-operator-controls/plan.md`

### Checkpoint D: Complete

- [x] All accepted-spec success criteria are satisfied.
- [x] All verification gates are green or an exact external blocker is documented.
- [x] Change is ready for the overseer's end-of-loop review.

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Guidance reaches a sealed role | High | Synchronous seal subscription plus SDK queue reclamation tests. |
| Native follow-up causes extra machine emission | High | Never call it; mailbox follow-up crosses the conductor session boundary. |
| Guidance races terminal `end` and is lost | High | Check mailbox before reduce; defer and re-prompt on pending input. |
| Consumed steer is replayed after handoff | High | Reclaim only strings still returned by `clearQueue`, matched to tracked envelopes. |
| Custom Host lacks steering capability | Medium | Optional RoleSession capability with typed `steering_unavailable` error. |
| Existing oversized modules grow further | Medium | New focused module plus production role-session adapter extraction. |
| Clipboard fails on headless/remote host | Low | Keep it in extension and surface the existing helper's error. |

## Open Questions

None blocking. Durable recovery, response reconstruction, receipts, and direct-text-only
copy remain explicitly deferred by the accepted spec.
