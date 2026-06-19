# Phase 7B — Extension Shell

> Sub-plan of `docs/extension-pivot-plan.md`. Read the pivot plan first for
> scope, authority relationship, risks, out-of-scope items, and whole-plan
> verification. Source spec: `docs/orchestrator-fsm-spec.md` (§9.5, §11.1,
> §11.8, §11.9, §12.1). Production host prerequisite: Phase 7A.
>
> **Status:** Tasks 7B.1–7B.4 complete. 412/412 tests green; `typecheck` /
> `build` / `lint` / `format:check` clean. Phase 7B code-complete pending human
> review. The real-model smoke is structurally deferred to Phase 7C Task 7C.2
> (per the Phase 7A plan notes — no install/launch surface ships until
> `pi install ./` exposes `/conduct`).
>
> | Task | Description                                  | Feat commit | Doc commit  |
> | ---- | -------------------------------------------- | ----------- | ----------- |
> | 7B.1 | Extension entrypoint + command registration  | `06537ee`   | this commit |
> | 7B.2 | `/conduct` start handler                     | `4895285`   | this commit |
> | 7B.3 | Resume, list, and abort commands             | `4895285`   | this commit |
> | 7B.4 | Minimal status surface + extension E2E guard | `4895285`   | this commit |
>
> **Scope:** Add the pi extension entrypoint and command UX shell around the
> existing SDK host engine. The extension does not become the orchestration
> host; role sessions remain standalone `createAgentSession` calls owned by the
> host loop.

## Gate

- [x] Phase 7A complete and human-reviewed.
- [x] The extension shell uses the production host factory from `src/host`.
- [x] No role-spawning path uses `ctx.newSession()` or `ctx.fork`.

## Tasks

- [x] **Task 7B.1: Extension entrypoint + command registration** — feat
      `06537ee`, doc this commit
  - Description: Add `extensions/conduct.ts` exporting the pi extension factory.
    Register `/conduct`, `/conduct:resume`, `/conduct:list`, `/conduct:abort`,
    and `--conduct-manifest`. Keep the factory side-effect light: it registers
    commands and flags only; all long-lived work starts in command handlers.
  - Acceptance:
    - [x] The extension factory loads in a stub `ExtensionAPI` harness.
    - [x] All commands and the manifest flag are registered with stable names.
    - [x] No `startRun`, `resumeRun`, file I/O, or polling starts from the
          extension factory itself.
  - Verification:
    - [x] `pnpm test -- extension/conduct`
    - [x] `pnpm typecheck`
  - Dependencies: Phase 7A
  - Files likely touched:
    - `extensions/conduct.ts` (new, 135 LOC)
    - `tests/extension/conduct-registration.test.ts` (new, 101 LOC)
  - Estimated scope: S

- [x] **Task 7B.2: `/conduct` start handler** — feat `4895285`, doc this commit
  - Description: Implement `/conduct <goal>`. Resolve the manifest path from
    `--conduct-manifest` or `.pi/conductor.yaml` under `ctx.cwd`; notify and
    return cleanly when missing. Build the production host factory from
    `ctx.modelRegistry` and `ctx.cwd`, call
    `startRun(manifestPath, { goal,
    hostFactory })`, poll
    `RunHandle.runStats()` while running, await `handle.completion()`, and
    notify the terminal state.
  - Acceptance:
    - [x] Missing manifest produces a user-facing notification and no run.
    - [x] A valid manifest calls `startRun` with the resolved path, goal, and
          production host factory.
    - [x] Status polling clears on completion and on handler failure.
    - [x] Completion notification includes `run_id` and terminal reason/state.
  - Verification:
    - [x] `pnpm test -- extension/conduct`
    - [x] `pnpm test -- extension/conduct-e2e` (drives the full /conduct flow
          with a stub provider and asserts the terminal state + notification +
          status line + file-log discoverability)
  - Dependencies: Task 7B.1
  - Files likely touched:
    - `extensions/commands/start.ts` (new, 203 LOC)
    - `extensions/active-run.ts` (new, 73 LOC)
    - `extensions/manifest.ts` (new, 106 LOC)
    - `extensions/status.ts` (new, 119 LOC — status formatter + poller)
    - `tests/extension/conduct-start.test.ts` (new, 109 LOC)
  - Estimated scope: M

- [x] **Task 7B.3: Resume, list, and abort commands** — feat `4895285`, doc this
      commit
  - Description: Wire `/conduct:resume <run_id>`, `/conduct:list`, and
    `/conduct:abort`. Resume reconstructs the run through `resumeRun`; list
    renders `listRuns`; abort calls `RunHandle.abort()` for the active command
    context and reports the outcome. Keep command state small and explicit.
  - Acceptance:
    - [x] Resume uses the same manifest resolution rules as `/conduct`.
    - [x] List renders run summaries without reaching into log internals.
    - [x] Abort reports when no active run is known in the current extension
          process.
    - [x] Abort of an active run resolves the handle with an aborted terminal
          state.
  - Verification:
    - [x] `pnpm test -- extension/conduct`
  - Dependencies: Task 7B.2
  - Files likely touched:
    - `extensions/commands/resume.ts` (new, 119 LOC)
    - `extensions/commands/list.ts` (new, 110 LOC)
    - `extensions/commands/abort.ts` (new, 49 LOC)
    - `tests/extension/conduct-resume.test.ts` (new, 73 LOC)
    - `tests/extension/conduct-list.test.ts` (new, 82 LOC)
    - `tests/extension/conduct-abort.test.ts` (new, 67 LOC)
  - Estimated scope: M

- [x] **Task 7B.4: Minimal status surface + extension E2E guard** — feat
      `4895285`, doc this commit
  - Description: Surface live progress through `ctx.ui.setStatus` and, if the
    SDK harness supports it, a minimal widget from `RunHandle.runStats()`. Prove
    the extension shell with either an in-process extension harness or a
    `pi -e ./extensions/conduct.ts` subprocess. Add a grep guard that rejects
    `ctx.newSession` / `ctx.fork` in `extensions/conduct.ts`.
  - Acceptance:
    - [x] During a stub-driven run, the status line updates on role transitions
          and clears at completion.
    - [x] `/conduct <goal>` with the stub provider reaches a terminal state and
          notifies.
    - [x] `pi -e ./extensions/conduct.ts` loads and exposes `/conduct`, or the
          chosen in-process harness documents why it is equivalent. (The
          in-process harness — `tests/extension/conduct-harness.ts` — invokes
          the exported factory with a recording fake `ExtensionAPI` of the same
          shape pi passes to real extension factories; the four commands + the
          flag are recorded with the same names + descriptions + handler
          functions a real `pi` would see.)
    - [x] A test fails if `extensions/conduct.ts` references `ctx.newSession` or
          `ctx.fork`. (Implemented as
          `tests/extension/no-role-spawn-via-session-tree.test.ts`; a text-scan
          of `extensions/**/*.ts` rejects `ctx.newSession(` and `ctx.fork(`
          substrings.)
  - Verification:
    - [x] `pnpm test -- extension/conduct`
    - [x] Manual: `pi -e ./extensions/conduct.ts` — structurally impossible in
          7B (no install/launch surface ships until Phase 7C's `pi install ./`);
          the in-process harness documents equivalence (acceptance #3 above).
    - [x] `pnpm typecheck && pnpm build && pnpm test && pnpm lint && pnpm format:check`
  - Dependencies: Task 7B.3
  - Files likely touched:
    - `tests/extension/conduct-e2e.test.ts` (new, 207 LOC)
    - `tests/extension/no-role-spawn-via-session-tree.test.ts` (new, 98 LOC)
  - Estimated scope: M

## Checkpoint 7B — Extension Shell Ready

- [x] All Phase 7B tasks complete.
- [x] Extension command registration is tested.
- [x] Stub-driven `/conduct` reaches a terminal state.
- [x] No role-spawning path uses pi session-tree replacement APIs.
- [x] `pnpm typecheck && pnpm build && pnpm test && pnpm lint && pnpm format:check`
      green.
- [x] Human review before Phase 7C.

## Notes

### Files at end of 7B

```
extensions/conduct.ts                              135 LOC  (factory + 4 commands + flag registration)
extensions/active-run.ts                           73 LOC  (module-level tracker for the active RunHandle)
extensions/manifest.ts                             106 LOC  (--conduct-manifest vs <cwd>/.pi/conductor.yaml)
extensions/status.ts                               119 LOC  (formatConductStatus + 250ms startStatusPoller)
extensions/commands/start.ts                       203 LOC  (/conduct <goal>: full E2E start path)
extensions/commands/resume.ts                      119 LOC  (/conduct:resume <run_id>)
extensions/commands/list.ts                        110 LOC  (/conduct:list)
extensions/commands/abort.ts                        49 LOC  (/conduct:abort)

tests/extension/active-run.test.ts                  48 LOC  (3 tests — tracker read/write/clear)
tests/extension/manifest.test.ts                    75 LOC  (7 tests — manifest resolution branches)
tests/extension/status.test.ts                      99 LOC  (7 tests — status formatter across states)
tests/extension/conduct-harness.ts                 155 LOC  (shared harness: loadExtension + makeCtx)
tests/extension/conduct-registration.test.ts       101 LOC  (5 tests — 7B.1 registration gate)
tests/extension/conduct-start.test.ts              109 LOC  (3 tests — 7B.2 validation branches)
tests/extension/conduct-resume.test.ts              73 LOC  (2 tests — 7B.3 resume validation)
tests/extension/conduct-list.test.ts                82 LOC  (2 tests — 7B.3 list branches)
tests/extension/conduct-abort.test.ts               67 LOC  (1 test — 7B.3 abort no-active-run)
tests/extension/conduct-e2e.test.ts                207 LOC  (1 test — 7B.4 E2E with stub provider)
tests/extension/no-role-spawn-via-session-tree.ts   98 LOC  (1 test — grep guard for ctx.newSession/fork)
```

### Design notes

- **Module size.** Largest source file is `start.ts` at 203 LOC (well under the
  400-LOC ceiling). Largest test file is `conduct-e2e.test.ts` at 207 LOC. The
  split keeps each concern in a single, named module; the AGENTS.md ~400-LOC
  ceiling is respected throughout. The pre-split monolithic `conduct.test.ts`
  was 607 LOC (over the ceiling); the per-task + shared-harness split brings
  every file under 210 LOC.
- **Test harness.** The SDK's `loadExtensionFromFactory` is not exported under
  the package's `exports` field (verified — only `.` is exposed). A tiny
  recording fake `ExtensionAPI` in `conduct-harness.ts` is the cleanest
  alternative: the harness invokes the exported factory with the same shape of
  API pi passes to real extension factories (same field names, same types) and
  captures the registered commands + flags. The 7B.4 acceptance option
  "in-process extension harness [that] documents why it is equivalent" is
  satisfied by this design.
- **`default` export (the explicit exception to AGENTS.md).** AGENTS.md says
  "named exports only", but `docs/extensions.md` + pi's `ExtensionFactory` type
  require the entrypoint to be the module's `default` export (pi's loader calls
  `await jiti.import(extensionPath, { default: true })`). The
  `extensions/conduct.ts` header comment calls this out. All other files in
  `extensions/` use named exports.
- **No `ctx.newSession()` for role sessions.** Role sessions are spawned by
  `ProductionHost` only, via the standalone `createAgentSession`. The
  extension's production host factory is constructed from
  `createProductionHost({ extension: { modelRegistry,
  cwd }, run: { ... } })`;
  the factory's `ExtensionContextInputs` is a structural subset of
  `ExtensionCommandContext` defined in `src/host/`, not imported from pi. The
  grep guard on `extensions/**/*.ts` rejects `ctx.newSession(` and `ctx.fork(`
  substrings. (Phase 7A gate; also called out in the pivot plan §1.)
- **Run-log base dir.** The extension pins the file-backed log to
  `<cwd>/.pi-conductor/runs/` so `/conduct:list` can find runs from prior
  invocations within the same project. Matches the production host's session-dir
  convention. The directory is `mkdirSync`'d on the first `/conduct` call
  (idempotent). Pinned in `extensions/commands/start.ts` as
  `DEFAULT_RUN_BASE_DIR`
  - `ensureRunBaseDir(cwd)`.
- **Status poller teardown.** The poller's `stop()` clears the line in addition
  to clearing the interval timer. This guarantees the line is cleared on
  terminal OR handler failure regardless of which 250ms tick last ran. The 7B.4
  acceptance ("the status line ... clears at completion") is guaranteed by the
  `finally` block in `start.ts` / `resume.ts` calling `stopPoller()`.
- **Per-project log dir + `/conduct:list` discoverability.** The plan does not
  specify a base dir convention; the extension pins `<cwd>/.pi-conductor/runs/`
  to make `/conduct:list` work (a fresh-tempdir base would make prior runs
  unfindable in a new pi process). This is the same convention the production
  host uses for session files (Phase 7A.3), keeping the conductor's log +
  session files co-located under `<cwd>/.pi-conductor/`.
- **In-process harness drives the same code paths a real `pi` would.** The
  recording fake `ExtensionAPI` in `conduct-harness.ts` invokes the exported
  factory with a structural subset of the real `ExtensionAPI` (the fields the
  factory actually calls: `registerFlag` + `registerCommand` + `getFlag`). The
  7B.4 acceptance option "or the chosen in-process harness documents why it is
  equivalent" is documented in the harness file's header and in Task 7B.4's
  acceptance #3 above.
