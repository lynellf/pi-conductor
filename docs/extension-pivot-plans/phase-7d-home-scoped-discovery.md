# Phase 7D — HOME-scoped manifest + system-prompt discovery

> Sub-plan of `docs/extension-pivot-plan.md`. Spec delta:
> `docs/home-scoped-discovery-spec.md` (acknowledged 2026-06-20). Read the
> spec delta first — it contains the investigation, the proposed §8/§8.1/§13
> edits, and the five resolved design questions that gate this plan.
>
> **Status:** Ready for implementation.
>
> **Scope:** Widen manifest resolution to include a `$HOME` fallback
> (`~/.pi/conductor.yaml`) and change system-prompt path resolution to be
> manifest-base-relative for `version >= 2` (version-gated back-compat for
> `version == 1`). No core modules touched; no spec invariants violated.
>
> **Authority:** This plan implements the acknowledged spec delta
> (`docs/home-scoped-discovery-spec.md`). The spec delta amends
> `docs/orchestrator-fsm-spec.md` §8, §8.1, §13, §11. Spec §-level edits are
> staged as a task within this plan (Task 7D.6) but are the overseer's
> concern — they are applied to the spec only as part of this phase's doc
> commit, not silently.

## Resolved decisions (from spec delta, overseer-acknowledged 2026-06-20)

| Q | Decision | Rationale |
|---|----------|-----------|
| Q1 | HOME manifest at `~/.pi/conductor.yaml` | Mirrors project-local shape; pi's `~/.pi/` is namespaced by subdirectory |
| Q2 | Version-gated back-compat: v1=cwd-relative, v2=manifest-base-relative | Preserves §10 additive-versioning rule; existing v1 manifests unchanged |
| Q3 | Flag set but missing → hard null, no fallthrough | "No silent fallbacks" — a bad flag is user error |
| Q4 | CLI (`bin/conduct`) stays explicit-path-only | Scripting surface; discovery ergonomics belong to the extension |
| Q5 | Run log stays `<cwd>/.pi-conductor/runs/` regardless of manifest source | `/conduct:list` is per-project |

## Gate

- [x] Phase 7C complete (432 tests green, typecheck/build/lint clean).
- [x] Spec delta (`docs/home-scoped-discovery-spec.md`) acknowledged by the
      overseer. ✓ (2026-06-20)
- [x] No core module (`src/core`, `src/manifest`, `src/seam`, `src/cost`,
      `src/persistence`) is touched by any task in this phase.

## What changes, what doesn't

### Changes

| File | Change |
|------|--------|
| `src/extension/manifest.ts` | `resolveManifestPath` gains `homeDir` param + step 3 (`<home>/.pi/conductor.yaml`) |
| `src/host/manifest.ts` | `LoadedManifest` gains `manifestDir: string \| null` + `manifestVersion: number`; `loadManifest` computes `dirname(path)`; `loadManifestFromString` gains optional `manifestDir` param |
| `src/host/production-host-resolve.ts` | `loadSystemPrompt` gains `manifestDir` + `manifestVersion` params; v2 resolves against `manifestDir`, v1 against `cwd` |
| `src/host/production-host.ts` | `spawnRole` threads `manifestDir` + `manifestVersion` from `loadedManifest` into `loadSystemPrompt` |
| `src/host/errors.ts` | `SystemPromptNotFoundError` message reflects the actual resolution root |
| `src/extension/commands/start.ts` | No-manifest notification mentions the HOME path tried |
| `docs/orchestrator-fsm-spec.md` | §8, §8.1, §13, §11 clarifications (staged from the spec delta) |
| `docs/extension-usage.md` | Document three-step resolution + v2 manifest-base prompt convention |
| `tests/extension/manifest.test.ts` | HOME fallback cases |
| `tests/host/production-host-spawn.test.ts` | v2 manifest-base prompt resolution case |
| New: `tests/host/production-host-resolve.test.ts` (or extend existing) | `loadSystemPrompt` version-gated resolution unit tests |

### Does NOT change

- `src/core/*` — reducer, lifecycle, run-memory, types, targets. Untouched.
- `src/manifest/*` — parse, validate, types, definition. Untouched. (The
  `version` field already exists on `Manifest`; no parse/validate changes.)
- `src/seam/*`, `src/cost/*`, `src/persistence/*` — untouched.
- `src/bin/conduct.ts` — Q4: CLI stays explicit-path-only.
- `src/host/api.ts` — `startRun`/`resumeRun` pass `loadedManifest` through
  unchanged; the new fields ride on `LoadedManifest` with no API signature change.
- `src/host/loop.ts`, `src/host/run-handle.ts`, `src/host/stub-host.ts` —
  unchanged. `StubHost` does not load system prompts from disk (it uses
  scripted prompts); it is unaffected by the resolution-root change.
- `extensions/conduct.ts` — unchanged (the flag reader + handler wiring
  already calls `resolveManifestPath`; the new `homeDir` defaults to
  `os.homedir()` so no call-site change is needed unless tests inject).

## Tasks

- [x] **Task 7D.1: `resolveManifestPath` HOME fallback**
  - Description: Add a third resolution step to `resolveManifestPath` in
    `src/extension/manifest.ts`. After the cwd default (step 2) fails to find
    a file, check `<home>/.pi/conductor.yaml` (step 3). Add a `homeDir`
    parameter (defaulting to `os.homedir()`) so tests can inject a temp HOME.
    The flag path (step 1) behavior is unchanged: set-but-missing → hard null,
    no fallthrough (Q3).
  - Acceptance:
    - [x] `resolveManifestPath(undefined, cwd, homeDir)` returns
          `<home>/.pi/conductor.yaml` when the file exists there and no
          cwd-local manifest exists.
    - [x] `resolveManifestPath(undefined, cwd, homeDir)` returns the cwd
          default when both cwd and HOME manifests exist (cwd wins).
    - [x] `resolveManifestPath(undefined, cwd)` (no `homeDir`) defaults to
          `os.homedir()` — the production call site in `start.ts` does not
          need to change.
    - [x] Flag set but missing → `null` (no fallthrough to cwd or HOME). Unchanged.
    - [x] Flag set and exists → flag path (no HOME check). Unchanged.
    - [x] None found → `null`. Unchanged.
  - Verification:
    - [x] `pnpm test -- tests/extension/manifest.test.ts` — all existing
          cases still pass; new HOME cases pass.
    - [x] `pnpm typecheck` — clean (new optional param is backward-compatible).
  - Dependencies: Phase 7C
  - Files touched: `src/extension/manifest.ts`, `tests/extension/manifest.test.ts`
  - Test cases (table-driven, add to existing `describe` block):

    | Case | flagValue | cwd has `.pi/conductor.yaml` | homeDir has `.pi/conductor.yaml` | Expected |
    |------|-----------|------------------------------|----------------------------------|----------|
    | HOME fallback when no cwd manifest | undefined | no | yes | `<home>/.pi/conductor.yaml` |
    | cwd wins over HOME | undefined | yes | yes | `<cwd>/.pi/conductor.yaml` |
    | neither exists | undefined | no | no | `null` |
    | flag set, missing — no HOME fallthrough | "missing.yaml" | yes | yes | `null` |
    | flag set, exists — no HOME check | "custom.yaml" | yes | yes | `<cwd>/custom.yaml` |
    | HOME fallback with injected temp dir | undefined | no | yes (temp) | `<temp>/.pi/conductor.yaml` |
    | empty homeDir string → step 3 skipped | undefined | no | n/a (empty) | `null` |

  - Estimated scope: S

- [x] **Task 7D.2: `LoadedManifest` carries `manifestDir` + `manifestVersion`**
  - Description: Add two fields to `LoadedManifest` in `src/host/manifest.ts`:
    - `manifestDir: string | null` — the directory containing the resolved
      manifest file (`dirname(path)`). `null` when loaded via
      `loadManifestFromString` without a `manifestDir` argument (test/programmatic
      path).
    - `manifestVersion: number` — the parsed `manifest.version` integer
      (already available on `Manifest`; surfaced here for convenience so
      `loadSystemPrompt` doesn't need to re-read `loadedManifest.manifest.version`).
  - `loadManifest(path)` sets `manifestDir = dirname(path)` and
    `manifestVersion = manifest.version`.
  - `loadManifestFromString(rawYaml, manifestDir?)` sets `manifestDir` from
    the optional arg (defaulting to `null`) and `manifestVersion` from the
    parsed manifest. Existing callers that don't pass `manifestDir` get
    `null` — safe for v1 (cwd-relative resolution doesn't use `manifestDir`).
  - Acceptance:
    - [x] `loadManifest(path)` returns `manifestDir = dirname(path)`.
    - [x] `loadManifestFromString(rawYaml)` returns `manifestDir = null`.
    - [x] `loadManifestFromString(rawYaml, "/some/dir")` returns
          `manifestDir = "/some/dir"`.
    - [x] `manifestVersion` matches the parsed `version:` field in all cases.
    - [x] All existing callers of `loadManifestFromString` (tests,
          `defaults.test.ts`) still compile — the new param is optional.
    - [x] `HostFactoryContext.loadedManifest` flows the new fields through to
          `ProductionHost` with no `api.ts` signature change (the fields ride
          on the `LoadedManifest` object).
  - Verification:
    - [x] `pnpm typecheck` — clean.
    - [x] `pnpm test` — all existing tests green (the new fields are additive;
          no existing assertion checks the exact shape of `LoadedManifest`).
  - Dependencies: Task 7D.1 (independent, but same commit batch is fine)
  - Files touched: `src/host/manifest.ts`, `tests/host/production-host.test.ts`
    (or a new `tests/host/manifest.test.ts` if one doesn't exist — check
    `tests/host/` for an existing manifest loader test)
  - Estimated scope: S

- [x] **Task 7D.3: `loadSystemPrompt` version-gated resolution root**
  - Description: Change `loadSystemPrompt` in
    `src/host/production-host-resolve.ts` to accept `manifestDir` and
    `manifestVersion` parameters. Resolution logic:
    - `path === undefined` → `null` (unchanged).
    - `path` absolute → used as-is (unchanged).
    - `path` relative + `manifestVersion >= 2` + `manifestDir !== null` →
      `resolve(manifestDir, path)`.
    - `path` relative + `manifestVersion >= 2` + `manifestDir === null` →
      throw `SystemPromptNotFoundError` with a message explaining the
      manifest was loaded without a file path and cannot resolve relative
      prompts against a manifest base. (This is a test/programmatic error —
      production always has a path.)
    - `path` relative + `manifestVersion == 1` → `resolve(cwd, path)`
      (back-compat — unchanged from current behavior).
  - The function signature changes from
    `loadSystemPrompt(role, path, cwd)` to
  - `loadSystemPrompt(role, path, cwd, manifestDir, manifestVersion)`.
  - `manifestDir` is `string | null`; `manifestVersion` is `number`.
  - Acceptance:
    - [x] v1 manifest with `.pi/roles/foo.md` → resolves against `cwd`
          (existing behavior preserved).
    - [x] v2 manifest with `roles/foo.md` + `manifestDir` set → resolves
          against `manifestDir`.
    - [x] v2 manifest with `roles/foo.md` + `manifestDir === null` → throws
          `SystemPromptNotFoundError` with a clear message.
    - [x] Absolute path → used as-is regardless of version.
    - [x] `path === undefined` → `null` regardless of version.
  - Verification:
    - [x] Unit tests for `loadSystemPrompt` covering all branches above.
    - [x] `pnpm typecheck` — clean.
  - Dependencies: Task 7D.2 (needs `manifestDir` + `manifestVersion` on
    `LoadedManifest`)
  - Files touched: `src/host/production-host-resolve.ts`,
    `src/host/errors.ts` (message update), tests
  - Test cases (table-driven):

    | Case | version | path | manifestDir | cwd has file | manifestDir has file | Expected |
    |------|---------|------|-------------|--------------|----------------------|----------|
    | v1 relative, cwd has file | 1 | `.pi/roles/foo.md` | `/manifest/dir` | yes | no | content from cwd |
    | v1 relative, cwd missing | 1 | `.pi/roles/foo.md` | `/manifest/dir` | no | yes | `SystemPromptNotFoundError` |
    | v2 relative, manifestDir has file | 2 | `roles/foo.md` | `/manifest/dir` | no | yes | content from manifestDir |
    | v2 relative, manifestDir missing | 2 | `roles/foo.md` | `/manifest/dir` | yes | no | `SystemPromptNotFoundError` |
    | v2 relative, manifestDir null | 2 | `roles/foo.md` | null | yes | n/a | `SystemPromptNotFoundError` (no base) |
    | absolute path, v2 | 2 | `/abs/path/foo.md` | `/manifest/dir` | n/a | n/a | content from abs path |
    | no path declared | 2 | undefined | `/manifest/dir` | n/a | n/a | `null` |
    | no path declared | 1 | undefined | null | n/a | n/a | `null` |

  - Estimated scope: M

- [x] **Task 7D.4: Thread `manifestDir` + `manifestVersion` through `ProductionHost`**
  - Description: `ProductionHost.spawnRole` currently calls
    `loadSystemPrompt(role, roleConfig?.system_prompt, this.cwd)`. Change it
    to pass `this.loadedManifest.manifestDir` and
    `this.loadedManifest.manifestVersion` as the new params. No new fields on
    `ProductionHost` — the values are already on `this.loadedManifest` (added
    in Task 7D.2).
  - The `createProductionHost` factory (`production-host-factory.ts`) passes
    `loadedManifest` through unchanged — no factory change needed.
  - `startRun` / `resumeRun` (`api.ts`) pass `loadedManifest` through
    unchanged — no API change needed.
  - Acceptance:
    - [x] `ProductionHost.spawnRole` with a v1 manifest + cwd-relative prompt
          → prompt loaded from cwd (existing spawn test still passes).
    - [x] `ProductionHost.spawnRole` with a v2 manifest + manifest-base-relative
          prompt → prompt loaded from `manifestDir`.
    - [x] The existing `production-host-spawn.test.ts` fixture (v1 manifest,
          `.pi/roles/implementer.md`) still passes without modification
          (v1 back-compat).
  - Verification:
    - [x] `pnpm test -- tests/host/production-host-spawn.test.ts` — existing
          cases green.
    - [x] New test case: v2 manifest with `roles/implementer.md` prompt
          resolved against `manifestDir` (not cwd).
    - [x] `pnpm typecheck && pnpm build` — clean.
  - Dependencies: Tasks 7D.2, 7D.3
  - Files touched: `src/host/production-host.ts`,
    `tests/host/production-host-spawn.test.ts`
  - Estimated scope: S

- [x] **Task 7D.5: Update error messages + no-manifest notification**
  - Description:
    - `SystemPromptNotFoundError` (`src/host/errors.ts`): the message
      currently says "resolved against cwd." Update to reflect the actual
      resolution root: "resolved against manifest dir" for v2, "resolved
      against cwd" for v1. The error constructor gains optional
      `resolutionRoot` context (or the message is built at the throw site in
      `loadSystemPrompt` and passed in). Keep it simple: pass the resolved
      base path into the error message at the throw site.
    - `handleStart` (`src/extension/commands/start.ts`): the no-manifest
      notification currently says `Tried --conduct-manifest="..." and
      <cwd>/.pi/conductor.yaml.` Add the HOME path:
      `Tried --conduct-manifest="...", <cwd>/.pi/conductor.yaml, and
      <home>/.pi/conductor.yaml.` Use the actual `homeDir` value (or
      `os.homedir()`) so the user sees the concrete path tried.
    - `handleResume` (`src/extension/commands/resume.ts`): check whether the
      resume handler also has a no-manifest notification; if so, update it
      identically.
  - Acceptance:
    - [x] `SystemPromptNotFoundError` message names the actual resolution root
          (cwd or manifest dir) and the resolved full path.
    - [x] No-manifest notification lists all three tried paths.
    - [x] Existing tests that assert on error message substrings are updated
          if needed (grep for `"resolved against cwd"` in tests).
  - Verification:
    - [x] `pnpm test` — green (update any assertions that match the old
          message text).
    - [x] `pnpm lint` — clean.
  - Dependencies: Tasks 7D.1, 7D.3
  - Files touched: `src/host/errors.ts`, `src/host/production-host-resolve.ts`
    (throw site), `src/extension/commands/start.ts`,
    `src/extension/commands/resume.ts` (if applicable), tests
  - Estimated scope: S

- [x] **Task 7D.6: Spec edits + user-facing docs**
  - Description: Apply the spec §8/§8.1/§13/§11 clarifications from the
    acknowledged spec delta to `docs/orchestrator-fsm-spec.md`. Update
    `docs/extension-usage.md` to document:
    - The three-step manifest resolution chain (flag → cwd → HOME).
    - The v2 manifest-base-relative prompt convention.
    - That v1 manifests keep cwd-relative prompts (back-compat).
    - That the run log is always cwd-scoped.
  - The spec edits are the overseer's concern per the operating model; they
    are staged in this task and committed as a doc commit, not a feat commit.
    The overseer reviews at end-of-loop.
  - Acceptance:
    - [x] `docs/orchestrator-fsm-spec.md` §8 reflects the three-step
          resolution chain.
    - [x] `docs/orchestrator-fsm-spec.md` §8.1 has the new system-prompt
          path-resolution subsection (manifest-base for v2, cwd for v1).
    - [x] `docs/orchestrator-fsm-spec.md` §13 clarifies checks run against
          the resolved manifest regardless of source.
    - [x] `docs/orchestrator-fsm-spec.md` §11.1/§11.9 clarify run log stays
          cwd-scoped.
    - [x] `docs/extension-usage.md` documents the resolution chain + v2
          convention.
    - [x] `docs/home-scoped-discovery-spec.md` status reflects
          "superseded by spec §8/§8.1 edits" (or a cross-reference).
  - Verification:
    - [x] `pnpm lint` — clean (docs are markdown; biome may not lint them,
        but verify no broken cross-refs).
  - Dependencies: Tasks 7D.1–7D.5 (land code first, then docs)
  - Files touched: `docs/orchestrator-fsm-spec.md`, `docs/extension-usage.md`,
    `docs/home-scoped-discovery-spec.md` (status note)
  - Estimated scope: S

- [x] **Task 7D.7: Full verification gate**
  - Description: Run the complete verification suite to confirm no regressions
    and all invariants hold.
  - Acceptance:
    - [x] `pnpm typecheck` — clean (strict + `noUncheckedIndexedAccess` +
          `exactOptionalPropertyTypes`).
    - [x] `pnpm build` — emits `dist/` with `.d.ts`.
    - [x] `pnpm test` — all green (existing 486 + new tests from 7D.1–7D.5
          = 514; the 432 baseline in this plan is stale).
    - [x] `tests/grep-guard.test.ts` — passes (no core modules touched;
          `src/extension/manifest.ts` and `src/host/*` are not scanned).
    - [x] `pnpm lint` (`biome check .`) — clean.
    - [x] `pnpm format:check` — clean.
    - [x] `pnpm audit` — no new high/critical advisories (existing 3 high
          advisories in `undici` are pre-existing transitive deps of
          `@earendil-works/pi-coding-agent`; not introduced by Phase 7D).
  - Dependencies: Tasks 7D.1–7D.6
  - Estimated scope: S

## Open questions surfaced during planning

None remaining — all five design questions were resolved by the overseer
(2026-06-20) and are recorded in the spec delta. The implementation details
(parameter names, optional vs required, message wording) are implementation
decisions within the implementer's discretion, not spec-level open questions.

## Risks

1. **`loadManifestFromString` callers break.** The function gains an optional
   `manifestDir` param. All existing callers pass no second arg →
   `manifestDir = null`. This is safe for v1 (cwd-relative resolution ignores
   `manifestDir`). A v2 manifest loaded via `loadManifestFromString` without
   `manifestDir` will throw on prompt resolution — but no existing test uses
   v2 via `loadManifestFromString`, so no breakage. The new v2 test case
   passes `manifestDir` explicitly.

2. **`StubHost` parity.** `StubHost` does not load system prompts from disk
   (it uses scripted prompts). The `loadSystemPrompt` signature change does
   not affect `StubHost`. No stub-host test changes needed.

3. **Spec edits applied without per-edit overseer sign-off.** Per the
   operating model, the overseer reviews at end-of-loop. The spec edits are
   staged from the acknowledged spec delta (which the overseer did
   acknowledge), so the content is pre-approved; the application to
   `orchestrator-fsm-spec.md` is mechanical. If the overseer wants to review
   the applied spec edits before the code lands, Task 7D.6 can be split into a
   separate doc-only commit reviewed independently.

## Exit criteria

- [x] All tasks 7D.1–7D.7 complete with checkboxes ticked.
- [x] `pnpm typecheck && pnpm build && pnpm test && pnpm lint && pnpm format:check`
      all clean.
- [x] `tests/grep-guard.test.ts` green (no core modules touched).
- [x] Spec delta (`docs/home-scoped-discovery-spec.md`) status updated to
      reflect implementation is complete.
- [x] `docs/orchestrator-fsm-spec.md` §8/§8.1/§13/§11 reflect the acknowledged
      changes.
- [x] `docs/extension-usage.md` documents the HOME fallback + v2 prompt
      convention.
