# Phase 7A — Production Host

> Sub-plan of `docs/extension-pivot-plan.md`. Read the pivot plan first for
> scope, authority relationship, risks, out-of-scope items, and whole-plan
> verification. Source spec: `docs/orchestrator-fsm-spec.md` (§8, §8.1, §11,
> §12). SDK surface pinned in `docs/sdk-surface.md` (§1, §3, §4, §6).
>
> **Status:** Tasks 7A.1–7A.4 complete (feat commits `2e20ad5`, `30d7a6a`,
> `d1ae204`, `38f5c92`; this doc commit pending). 374/374 tests green;
> `typecheck` / `build` / `lint` / `format:check` clean. Phase 7A
> complete pending human review.
>
> **Scope:** Add the production `Host` implementation the SDK loop already
> expects. It reuses the existing pure core, seam, cost helpers, file-backed log,
> run handle, and host loop. It does not add extension commands; those are Phase
> 7B.

## Gate

- [ ] Checkpoint E has human review.
- [ ] The FSM spec remains closed; this phase only fills the production host
      gap.
- [ ] `src/core`, `src/manifest`, `src/seam`, and `src/cost` remain free of pi
      imports.

## Tasks

- [x] **Task 7A.2: Model and system-prompt resolution** — commit `30d7a6a`
  - Description: Implement the pure resolution pieces used by `spawnRole`.
    Resolve `role.models[modelIndex]` in `provider:id` form through
    `modelRegistry.find(provider, id)`, record the logical model string for
    lifecycle records, and load `role.system_prompt` from `cwd` as UTF-8.
    Missing models and missing prompt files fail loudly with the errors from
    7A.1.
  - Acceptance:
    - [x] A mock registry hit returns the selected `Model` and logical
          `provider:id`.
    - [x] A mock registry miss throws `ModelNotFoundError`.
    - [x] A declared prompt path loads as UTF-8; a missing declared path throws
          `SystemPromptNotFoundError`.
    - [x] A role with omitted `models` keeps the existing "system model" path
          explicit rather than guessing a provider alias.
  - Verification:
    - [x] `pnpm test -- host/production-host` (30/30, was 14/14)
    - [x] `pnpm typecheck`
  - Dependencies: Task 7A.1
  - Files likely touched:
    - `src/host/production-host.ts` (3 new exports: `selectModelEntry`,
      `resolveModel`, `loadSystemPrompt`)
    - `src/host/index.ts`, `src/index.ts` (re-exports)
    - `tests/host/production-host.test.ts` (16 new tests; 5 case table for
      malformed entries)
  - Estimated scope: M

- [x] **Task 7A.3: Resource loader, tools allowlist, and role session spawn** — commit `d1ae204`
  - Description: Wire the real `createAgentSession` call. Build a
    `DefaultResourceLoader` with `systemPromptOverride: () => rolePrompt`, call
    `loader.reload()`, force-include `handoff` and `end` in the `tools`
    allowlist, pass the existing custom emission tools, and use a file-backed
    `SessionManager` rooted under the conductor run log directory rather than
    pi's own session tree.
  - Acceptance:
    - [x] Tests assert `systemPromptOverride` is invoked through the resource
          loader path.
    - [x] `tools` contains role-declared tools plus force-injected `handoff` and
          `end` exactly once.
    - [x] Role session files are created under a per-run conductor directory,
          not under pi's session dir.
    - [x] No `ExtensionCommandContext.newSession()` / session-tree replacement
          surface is used.
  - Verification:
    - [x] `pnpm test -- host/production-host` (30/30)
    - [x] `pnpm test -- host/production-host-spawn` (10/10)
    - [x] `pnpm typecheck`, `pnpm build`, `pnpm lint`, `pnpm format:check`
  - Dependencies: Task 7A.2
  - Files likely touched:
    - `src/host/production-host.ts` (rewrote `spawnRole`; +402 / -199)
    - `src/host/production-host-resolve.ts` (NEW; pure helpers split out
      to keep the class file under 400 LOC)
    - `src/host/index.ts`, `src/index.ts` (re-exports)
    - `tests/host/production-host-spawn.test.ts` (NEW; 10 tests)
  - Estimated scope: M

- [x] **Task 7A.4: Production host parity with existing loop semantics** — commit `38f5c92`
  - Description: Match `StubHost` behavior for usage capture, terminal reason,
    run cost, model fallback, visit index, abort, seal, persistence, and run
    memory seeding. Extract shared session-event logic only if it removes real
    duplication; otherwise keep the implementation boring and local.
  - Acceptance:
    - [x] Production host records normalized usage with the same SDK mapping
          tested in Phase 5.
    - [x] `sealSession` prevents side-effecting tools after a valid emission in
          the production path.
    - [x] `persistRecord`, `seedRunMemory`, and `nextVisitIndex` read from the
          same log/manifest sources as `StubHost`.
    - [x] Existing stub E2E and cost/fallback/stats tests remain green.
  - Verification:
    - [x] `pnpm test -- host/cost host/fallback host/stats host/e2e` (green
          after the StubHost refactor)
    - [x] `pnpm test -- host/production-host` (30/30)
    - [x] `pnpm test -- host/production-host-spawn` (10/10)
    - [x] `pnpm test -- host/production-host-parity` (5/5)
  - Dependencies: Task 7A.3
  - Files likely touched:
    - `src/host/session-event-handler.ts` (NEW; ~145 LOC, shared handler)
    - `src/host/stub-host.ts` (refactored to use the shared handler; -113
      lines)
    - `src/host/production-host.ts` (all Host methods implemented;
      +283 / -29)
    - `tests/host/production-host-parity.test.ts` (NEW; 5 tests)
  - Estimated scope: M

- [x] **Task 7A.1: Production host scaffold + boundary errors** — commit `2e20ad5`
  - Description: Add `ProductionHost implements Host` in `src/host/` with a
    constructor that accepts the production context: `modelRegistry`, `cwd`,
    `log`, `loadedManifest`, `runId`, and any existing run-handle/session state
    dependencies the loop already passes to `StubHost`. Define typed errors for
    missing model, malformed `provider:id`, and missing system prompt. Keep all
    pi imports inside `src/host`.
  - Acceptance:
    - [x] `ProductionHost` satisfies the existing `Host` interface without
          changing the loop contract.
    - [x] Boundary errors include the role name and missing value in their
          messages.
    - [x] The grep guard still allows pi imports only in `src/host`.
  - Verification:
    - [x] `pnpm test -- host/production-host` (14/14 pass)
    - [x] `pnpm test -- grep-guard` (4/4 pass)
  - Dependencies: Checkpoint E review (asserted done by human; AGENTS.md
    "Current status" block removed in `75c005b`).
  - Files likely touched:
    - `src/host/production-host.ts` (new, 143 LOC)
    - `src/host/errors.ts` (3 new error classes)
    - `src/host/index.ts` (re-exports)
    - `src/index.ts` (public barrel re-exports)
    - `tests/host/production-host.test.ts` (new, 14 table-driven tests)
  - Estimated scope: M

- [ ] **Task 7A.2: Model and system-prompt resolution**
  - Description: Implement the pure resolution pieces used by `spawnRole`.
    Resolve `role.models[modelIndex]` in `provider:id` form through
    `modelRegistry.find(provider, id)`, record the logical model string for
    lifecycle records, and load `role.system_prompt` from `cwd` as UTF-8.
    Missing models and missing prompt files fail loudly with the errors from
    7A.1.
  - Acceptance:
    - [ ] A mock registry hit returns the selected `Model` and logical
          `provider:id`.
    - [ ] A mock registry miss throws `ModelNotFoundError`.
    - [ ] A declared prompt path loads as UTF-8; a missing declared path throws
          `SystemPromptNotFoundError`.
    - [ ] A role with omitted `models` keeps the existing "system model" path
          explicit rather than guessing a provider alias.
  - Verification:
    - [ ] `pnpm test -- host/production-host`
    - [ ] `pnpm typecheck`
  - Dependencies: Task 7A.1
  - Files likely touched:
    - `src/host/production-host.ts`
    - `tests/host/production-host.test.ts`
    - `tests/fixtures/production-host/.pi/roles/*.md`
  - Estimated scope: M

- [ ] **Task 7A.3: Resource loader, tools allowlist, and role session spawn**
  - Description: Wire the real `createAgentSession` call. Build a
    `DefaultResourceLoader` with `systemPromptOverride: () => rolePrompt`, call
    `loader.reload()`, force-include `handoff` and `end` in the `tools`
    allowlist, pass the existing custom emission tools, and use a file-backed
    `SessionManager` rooted under the conductor run log directory rather than
    pi's own session tree.
  - Acceptance:
    - [ ] Tests assert `systemPromptOverride` is invoked through the resource
          loader path.
    - [ ] `tools` contains role-declared tools plus force-injected `handoff` and
          `end` exactly once.
    - [ ] Role session files are created under a per-run conductor directory,
          not under pi's session directory.
    - [ ] No `ExtensionCommandContext.newSession()` / session-tree replacement
          surface is used.
  - Verification:
    - [ ] `pnpm test -- host/production-host`
    - [ ] `pnpm test -- host/e2e`
  - Dependencies: Task 7A.2
  - Files likely touched:
    - `src/host/production-host.ts`
    - `tests/host/production-host.test.ts`
  - Estimated scope: M

- [ ] **Task 7A.4: Production host parity with existing loop semantics**
  - Description: Match `StubHost` behavior for usage capture, terminal reason,
    run cost, model fallback, visit index, abort, seal, persistence, and run
    memory seeding. Extract shared session-event logic only if it removes real
    duplication; otherwise keep the implementation boring and local.
  - Acceptance:
    - [ ] Production host records normalized usage with the same SDK mapping
          tested in Phase 5.
    - [ ] `sealSession` prevents side-effecting tools after a valid emission in
          the production path.
    - [ ] `persistRecord`, `seedRunMemory`, and `nextVisitIndex` read from the
          same log/manifest sources as `StubHost`.
    - [ ] Existing stub E2E and cost/fallback/stats tests remain green.
  - Verification:
    - [ ] `pnpm test -- host/cost host/fallback host/stats host/e2e`
    - [ ] `pnpm test -- host/production-host`
  - Dependencies: Task 7A.3
  - Files likely touched:
    - `src/host/production-host.ts`
    - `src/host/stub-host.ts`
    - `src/host/cost.ts`
    - `tests/host/production-host.test.ts`
  - Estimated scope: M

- [ ] **Task 7A.5: Production host factory + real-model proof**
  - Description: Add a tiny production host factory that accepts an
    `ExtensionCommandContext`-shaped object (`modelRegistry`, `cwd`) plus the
    run context (`runId`, `log`, `loadedManifest`) and returns a
    `ProductionHost`. The factory is shared by Phase 7B's extension command and
    Phase 7C's optional CLI fallback. Run one manual real-model smoke with a
    two-role manifest and record the transcript.
  - Acceptance:
    - [ ] The factory is extension-agnostic: `src/host` does not import
          extension types or `extensions/*`.
    - [ ] Unit tests assert the factory passes `modelRegistry`, `cwd`, `runId`,
          `log`, and `loadedManifest` through to `ProductionHost`.
    - [ ] A real-model run against the developer's pi auth/config reaches a
          terminal state: orchestrator → worker → orchestrator → end.
    - [ ] The manual transcript is committed under `docs/dev-run-transcripts/`
          and contains no API keys or provider secrets.
  - Verification:
    - [ ] `pnpm test -- host/production-host`
    - [ ] `pnpm typecheck && pnpm build && pnpm test && pnpm lint && pnpm format:check`
    - [ ] Manual: real-model transcript recorded
  - Dependencies: Task 7A.4
  - Files likely touched:
    - `src/host/production-host.ts`
    - `src/host/production-host-factory.ts`
    - `src/host/index.ts`
    - `tests/host/production-host.test.ts`
    - `docs/dev-run-transcripts/*.md`
  - Estimated scope: M

## Checkpoint 7A — Production Host Ready

- [x] All Phase 7A tasks complete (7A.1–7A.4).
- [x] Stub-driven E2E remains green (329 → 329 after the shared-handler
      refactor).
- [x] Production-host unit tests are green (30+10+5 across the three
      production-host test files).
- [ ] Manual real-model transcript is committed.
- [x] `pnpm typecheck && pnpm build && pnpm test && pnpm lint && pnpm format:check`
      green (374/374 tests, 71 files lint-clean).
- [ ] Human review before Phase 7B.
