# Phase 7A — Production Host

> Sub-plan of `docs/extension-pivot-plan.md`. Read the pivot plan first for
> scope, authority relationship, risks, out-of-scope items, and whole-plan
> verification. Source spec: `docs/orchestrator-fsm-spec.md` (§8, §8.1, §11,
> §12). SDK surface pinned in `docs/sdk-surface.md` (§1, §3, §4, §6).
>
> **Status:** Tasks 7A.1–7A.5 complete. 380/380 tests green; `typecheck` /
> `build` / `lint` / `format:check` clean. Phase 7A code-complete pending human
> review. The manual real-model smoke is **structurally deferred**: there is no
> installable launch surface until Phase 7C, Task 7C.2 (`pi install ./` +
> `/conduct` available) lands, so the smoke is relocated there — see
> `phase-7c-packaging-distribution-docs.md` Task 7C.2 and
> `docs/dev-run-transcripts/README.md`.
>
> | Task | Description                                          | Feat commit | Doc commit |
> | ---- | ---------------------------------------------------- | ----------- | ---------- |
> | 7A.1 | Production host scaffold + boundary errors           | `2e20ad5`   | `4f844dd`  |
> | 7A.2 | Model and system-prompt resolution                   | `30d7a6a`   | `43599d0`  |
> | 7A.3 | Resource loader, tools allowlist, role session spawn | `d1ae204`   | `1f0f6bc`  |
> | 7A.4 | Production host parity with StubHost                 | `38f5c92`   | `e06fdb6`  |
> | 7A.5 | Production host factory + extension-agnostic test    | `3816f67`   | `971675f`  |
>
> **Scope:** Add the production `Host` implementation the SDK loop already
> expects. It reuses the existing pure core, seam, cost helpers, file-backed
> log, run handle, and host loop. It does not add extension commands; those are
> Phase 7B.

## Gate

- [x] Checkpoint E has human review (asserted done by human at the start of this
      session; AGENTS.md "Current status" block removed in `75c005b`).
- [x] The FSM spec remains closed; this phase only fills the production host
      gap.
- [x] `src/core`, `src/manifest`, `src/seam`, and `src/cost` remain free of pi
      imports (grep guard: 4/4 green).

## Tasks

- [x] **Task 7A.1: Production host scaffold + boundary errors** — feat
      `2e20ad5`, doc `4f844dd`
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
  - Dependencies: Checkpoint E review (asserted done by human).
  - Files likely touched:
    - `src/host/production-host.ts` (new, 143 LOC)
    - `src/host/errors.ts` (3 new error classes)
    - `src/host/index.ts` (re-exports)
    - `src/index.ts` (public barrel re-exports)
    - `tests/host/production-host.test.ts` (new, 14 table-driven tests)
  - Estimated scope: M

- [x] **Task 7A.2: Model and system-prompt resolution** — feat `30d7a6a`, doc
      `43599d0`
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

- [x] **Task 7A.3: Resource loader, tools allowlist, and role session spawn** —
      feat `d1ae204`, doc `1f0f6bc`
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
          not under pi's session directory.
    - [x] No `ExtensionCommandContext.newSession()` / session-tree replacement
          surface is used.
  - Verification:
    - [x] `pnpm test -- host/production-host` (30/30)
    - [x] `pnpm test -- host/production-host-spawn` (10/10)
    - [x] `pnpm typecheck`, `pnpm build`, `pnpm lint`, `pnpm format:check`
  - Dependencies: Task 7A.2
  - Files likely touched:
    - `src/host/production-host.ts` (rewrote `spawnRole`; +402 / -199)
    - `src/host/production-host-resolve.ts` (NEW; pure helpers split out to keep
      the class file under 400 LOC)
    - `src/host/index.ts`, `src/index.ts` (re-exports)
    - `tests/host/production-host-spawn.test.ts` (NEW; 10 tests)
  - Estimated scope: M

- [x] **Task 7A.4: Production host parity with existing loop semantics** — feat
      `38f5c92`, doc `e06fdb6`
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
    - `src/host/stub-host.ts` (refactored to use the shared handler; -113 lines)
    - `src/host/production-host.ts` (all Host methods implemented; +283 / -29)
    - `tests/host/production-host-parity.test.ts` (NEW; 5 tests)
  - Estimated scope: M

- [x] **Task 7A.5: Production host factory + real-model proof** — feat
      `3816f67`, doc `971675f`
  - Description: Add a tiny production host factory that accepts an
    `ExtensionCommandContext`-shaped object (`modelRegistry`, `cwd`) plus the
    run context (`runId`, `log`, `loadedManifest`) and returns a
    `ProductionHost`. The factory is shared by Phase 7B's extension command and
    Phase 7C's optional CLI fallback. Run one manual real-model smoke with a
    two-role manifest and record the transcript.
  - Acceptance:
    - [x] The factory is extension-agnostic: `src/host` does not import
          extension types or `extensions/*`. (Asserted by static check in
          `production-host-factory.test.ts`.)
    - [x] Unit tests assert the factory passes `modelRegistry`, `cwd`, `runId`,
          `log`, and `loadedManifest` through to `ProductionHost`.
    - [ ] A real-model run against the developer's pi auth/config reaches a
          terminal state: orchestrator → worker → orchestrator → end.
          **Relocated to Phase 7C, Task 7C.2** — not runnable until `pi install ./`
          exposes `/conduct` (no install/launch surface exists in 7A; 7A ships a
          library only, with no `bin` or extension entrypoint).
    - [ ] The manual transcript is committed under `docs/dev-run-transcripts/`
          and contains no API keys or provider secrets. **Relocated to 7C.2.**
  - Verification:
    - [x] `pnpm test -- host/production-host-factory` (6/6)
    - [x] `pnpm typecheck && pnpm build && pnpm test && pnpm lint && pnpm format:check`
    - [ ] Manual: real-model transcript recorded. **Structurally deferred to
          Phase 7C, Task 7C.2** — requires `pi install ./` (the installable
          launch surface) plus developer `~/.pi/agent/auth.json` with a working
          provider; see `docs/dev-run-transcripts/README.md` for the capture
          format.
  - Dependencies: Task 7A.4
  - Files likely touched:
    - `src/host/production-host-factory.ts` (NEW; 117 LOC)
    - `src/host/index.ts`, `src/index.ts` (re-exports)
    - `tests/host/production-host-factory.test.ts` (NEW; 6 tests)
    - `docs/dev-run-transcripts/README.md` (placeholder for the manual
      transcript)
  - Estimated scope: M

## Checkpoint 7A — Production Host Ready

- [x] All Phase 7A tasks complete (7A.1–7A.5).
- [x] Stub-driven E2E remains green (329 → 329 after the shared-handler refactor
      in 7A.4).
- [x] Production-host unit tests are green: 14 (7A.1) + 16 (7A.2) + 10 (7A.3) +
      5 (7A.4) + 6 (7A.5) = 51 production-host tests across four files
      (`host/production-host.test.ts`, `host/production-host-spawn.test.ts`,
      `host/production-host-parity.test.ts`,
      `host/production-host-factory.test.ts`).
- [ ] Manual real-model transcript is committed. **Structurally deferred to
      Phase 7C, Task 7C.2** — not runnable until `pi install ./` exposes
      `/conduct` (no install/launch surface ships in 7A). See
      `docs/dev-run-transcripts/README.md` for the capture format.
- [x] `pnpm typecheck && pnpm build && pnpm test && pnpm lint && pnpm format:check`
      green (380/380 tests, 73 files lint-clean).
- [x] Human review before Phase 7B.

## Notes

### Files at end of 7A

```
src/host/production-host.ts              453 LOC  (Host class + spawn + 10 methods)
src/host/production-host-resolve.ts     136 LOC  (pure helpers: selectModelEntry,
                                                    resolveModel, loadSystemPrompt,
                                                    buildToolsAllowlist)
src/host/production-host-factory.ts     117 LOC  (createProductionHost factory)
src/host/session-event-handler.ts       145 LOC  (shared with StubHost)
src/host/stub-host.ts                   349 LOC  (refactored to use shared handler)
src/host/errors.ts                      154 LOC  (3 new + 2 existing typed errors)
src/host/index.ts                       159 LOC  (barrel)

tests/host/production-host.test.ts               338 LOC  (7A.1 + 7A.2)
tests/host/production-host-spawn.test.ts         293 LOC  (7A.3)
tests/host/production-host-parity.test.ts        438 LOC  (7A.4)
tests/host/production-host-factory.test.ts       168 LOC  (7A.5)
```

### Design notes

- **Module size.** `production-host.ts` is 453 LOC — over the AGENTS.md ~400-LOC
  soft ceiling but under the 500-LOC hard cap. Size is justified inline in the
  file header; the class is a single coherent declaration the loop imports. Pure
  resolution pieces live in `production-host-resolve.ts`; the shared event
  handler lives in `session-event-handler.ts`.
- **Extraction discipline.** The shared event handler was extracted (7A.4)
  because it was a real ~50-line duplicate across `StubHost` and
  `ProductionHost`. The `unavailableRole` marker (7A.4) and the
  `ExtensionContextInputs` factory inputs (7A.5) stayed inlined because they're
  small enough that extraction would add a file without meaningfully reducing
  duplication.
- **Session directory default.** `<cwd>/.pi-conductor/runs/<runId>/sessions` for
  the production host; the extension is expected to pass an explicit override
  when it wants sessions in the conductor's run-log dir.
- **Agent directory default.** `<cwd>/.pi-conductor/agent`. The extension is
  expected to pass `~/.pi/agent` here so spawned role sessions see the user's pi
  configuration (auth, models). Production host with the default agent dir is
  isolated; with the user's `~/.pi/agent` it shares the user's config.
- **The "system model" path is explicit.** When a role has no `models` field,
  `selectModelEntry` returns `null` and `spawnRole` does NOT pass a `model` to
  `createAgentSession` — the SDK uses its default. The production host never
  guesses a provider alias. (7A.2 acceptance.)
- **No `ctx.newSession()` for role sessions.** Role sessions are spawned via the
  standalone `createAgentSession` + a file-backed `SessionManager` rooted in the
  conductor's per-run directory. The conductor's `run_id`-keyed log is the
  host's append-only record; role session files are the SDK's own JSONL files in
  the conductor dir. (Phase 7A gate; also called out in the pivot plan §1.)
- **`createProductionHost` is the bridge for 7B and 7C.** Phase 7B imports it
  from `src/host/index.js` to construct a host in the extension entrypoint;
  Phase 7C's optional CLI fallback does the same. The factory takes
  `ExtensionContextInputs` (structurally compatible with
  `ExtensionCommandContext`) + a `RunContextInputs` and returns a
  `ProductionHost`. Static check in the factory test ensures the host layer has
  zero compile-time dependency on extension types.
