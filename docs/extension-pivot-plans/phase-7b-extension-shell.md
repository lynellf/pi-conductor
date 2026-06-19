# Phase 7B — Extension Shell

> Sub-plan of `docs/extension-pivot-plan.md`. Read the pivot plan first for
> scope, authority relationship, risks, out-of-scope items, and whole-plan
> verification. Source spec: `docs/orchestrator-fsm-spec.md` (§9.5, §11.1,
> §11.8, §11.9, §12.1). Production host prerequisite: Phase 7A.
>
> **Status:** Draft — awaiting human review before any task starts.
>
> **Scope:** Add the pi extension entrypoint and command UX shell around the
> existing SDK host engine. The extension does not become the orchestration
> host; role sessions remain standalone `createAgentSession` calls owned by the
> host loop.

## Gate

- [ ] Phase 7A complete and human-reviewed.
- [ ] The extension shell uses the production host factory from `src/host`.
- [ ] No role-spawning path uses `ctx.newSession()` or `ctx.fork`.

## Tasks

- [ ] **Task 7B.1: Extension entrypoint + command registration**
  - Description: Add `extensions/conduct.ts` exporting the pi extension factory.
    Register `/conduct`, `/conduct:resume`, `/conduct:list`,
    `/conduct:abort`, and `--conduct-manifest`. Keep the factory side-effect
    light: it registers commands and flags only; all long-lived work starts in
    command handlers.
  - Acceptance:
    - [ ] The extension factory loads in a stub `ExtensionAPI` harness.
    - [ ] All commands and the manifest flag are registered with stable names.
    - [ ] No `startRun`, `resumeRun`, file I/O, or polling starts from the
          extension factory itself.
  - Verification:
    - [ ] `pnpm test -- extension/conduct`
    - [ ] `pnpm typecheck`
  - Dependencies: Phase 7A
  - Files likely touched:
    - `extensions/conduct.ts`
    - `tests/extension/conduct.test.ts`
  - Estimated scope: S

- [ ] **Task 7B.2: `/conduct` start handler**
  - Description: Implement `/conduct <goal>`. Resolve the manifest path from
    `--conduct-manifest` or `.pi/conductor.yaml` under `ctx.cwd`; notify and
    return cleanly when missing. Build the production host factory from
    `ctx.modelRegistry` and `ctx.cwd`, call `startRun(manifestPath, { goal,
    hostFactory })`, poll `RunHandle.runStats()` while running, await
    `handle.completion()`, and notify the terminal state.
  - Acceptance:
    - [ ] Missing manifest produces a user-facing notification and no run.
    - [ ] A valid manifest calls `startRun` with the resolved path, goal, and
          production host factory.
    - [ ] Status polling clears on completion and on handler failure.
    - [ ] Completion notification includes `run_id` and terminal reason/state.
  - Verification:
    - [ ] `pnpm test -- extension/conduct`
    - [ ] `pnpm test -- host/api`
  - Dependencies: Task 7B.1
  - Files likely touched:
    - `extensions/conduct.ts`
    - `tests/extension/conduct.test.ts`
  - Estimated scope: M

- [ ] **Task 7B.3: Resume, list, and abort commands**
  - Description: Wire `/conduct:resume <run_id>`, `/conduct:list`, and
    `/conduct:abort`. Resume reconstructs the run through `resumeRun`; list
    renders `listRuns`; abort calls `RunHandle.abort()` for the active command
    context and reports the outcome. Keep command state small and explicit.
  - Acceptance:
    - [ ] Resume uses the same manifest resolution rules as `/conduct`.
    - [ ] List renders run summaries without reaching into log internals.
    - [ ] Abort reports when no active run is known in the current extension
          process.
    - [ ] Abort of an active run resolves the handle with an aborted terminal
          state.
  - Verification:
    - [ ] `pnpm test -- extension/conduct`
  - Dependencies: Task 7B.2
  - Files likely touched:
    - `extensions/conduct.ts`
    - `tests/extension/conduct.test.ts`
  - Estimated scope: M

- [ ] **Task 7B.4: Minimal status surface + extension E2E guard**
  - Description: Surface live progress through `ctx.ui.setStatus` and, if the
    SDK harness supports it, a minimal widget from `RunHandle.runStats()`.
    Prove the extension shell with either an in-process extension harness or a
    `pi -e ./extensions/conduct.ts` subprocess. Add a grep guard that rejects
    `ctx.newSession` / `ctx.fork` in `extensions/conduct.ts`.
  - Acceptance:
    - [ ] During a stub-driven run, the status line updates on role transitions
          and clears at completion.
    - [ ] `/conduct <goal>` with the stub provider reaches a terminal state and
          notifies.
    - [ ] `pi -e ./extensions/conduct.ts` loads and exposes `/conduct`, or the
          chosen in-process harness documents why it is equivalent.
    - [ ] A test fails if `extensions/conduct.ts` references `ctx.newSession` or
          `ctx.fork`.
  - Verification:
    - [ ] `pnpm test -- extension/conduct`
    - [ ] Manual or automated: `pi -e ./extensions/conduct.ts`
    - [ ] `pnpm typecheck && pnpm build && pnpm test && pnpm lint && pnpm format:check`
  - Dependencies: Task 7B.3
  - Files likely touched:
    - `extensions/conduct.ts`
    - `tests/extension/conduct.test.ts`
    - `tests/grep-guard.test.ts`
  - Estimated scope: M

## Checkpoint 7B — Extension Shell Ready

- [ ] All Phase 7B tasks complete.
- [ ] Extension command registration is tested.
- [ ] Stub-driven `/conduct` reaches a terminal state.
- [ ] No role-spawning path uses pi session-tree replacement APIs.
- [ ] `pnpm typecheck && pnpm build && pnpm test && pnpm lint && pnpm format:check`
      green.
- [ ] Human review before Phase 7C.
