# Phase 2 — Provider-registration pre-flight check at load time (Issue #6)

**Resolves:** #6 (enhancement).
**Risk:** Medium. Architectural boundary decision (host-side check, not
in the §13 validator); touches the `loadManifest` signature, the
`RunHandle` surface (new `loadedManifest` field), and the
`startRun` / `resumeRun` plumbing on the extension AND CLI paths.
Behavior is strictly additive: when no `ModelRegistry` is passed,
behavior is unchanged.
**Spec authority:** Consolidates issue #6's intent and the §8.1 model-
resolution flow. The check is a host-side addition, **not** an extension
of spec §13 (which stays scoped to static structural checks on the
manifest YAML).

## What I found

- **The gap:** `validateManifest` in `src/manifest/validate.ts` and
  `splitProviderId` in `src/host/production-host-resolve.ts` both
  accept `ollama:robit/ornith:9b` (post phase 2 fix). The first
  `spawnRole` for the role then calls
  `modelRegistry.find("ollama", "robit/ornith:9b")`, which returns
  `undefined` when `ollama` isn't registered. The host throws
  `ModelNotFoundError` and the loop's recovery path fires
  (`unavailableRole` marker → next re-dispatch escalates per §9.4 v1
  default).
- **Why a validator-level check is the wrong place:** the validator
  must stay host-agnostic (AGENTS.md invariant #1, enforced by
  `tests/grep-guard.test.ts`). Injecting a `ModelRegistry` would either
  require a `ModelRegistry`-shaped interface declared in `src/manifest/`
  (indirection + type coupling) or a `// @ts-expect-error` / cast that
  the grep guard would still flag. The right home is `src/host/`.
- **The check surface:** every `role.models[].entry` whose
  `(provider, id)` returns `undefined` from
  `modelRegistry.find(provider, id)`. One warning per affected role
  per affected entry, listing the entry string so the user can
  diagnose. Provider-not-registered and id-not-found are the same
  outcome from the user's perspective (`ModelNotFoundError`); one
  warning code is sufficient. A future finer-grained diagnostic is
  additive.
- **Advisory, not hard:** the issue itself states "advisory (a
  warning, not a hard error)" — providers can be registered by pi
  extensions that load after conductor, or dynamically during setup.
  Matches the existing soft-warning pattern
  (`no-cheaper-fallback`, `missing-required-tool`).
- **Plumbing:** the registry is available in the extension entrypoint
  (`ctx.modelRegistry` in `src/extension/commands/start.ts:137` and
  `src/extension/commands/resume.ts:90`) and in the CLI entrypoint
  (`ModelRegistry.create(AuthStorage.create())` in
  `src/bin/conduct.ts:253`, exposed via `CliDeps.modelRegistry` at
  line 82). `loadManifest` does not currently take a registry; the
  cleanest path is an optional second argument that flows through
  `loadManifestFromString` → `checkModelProvidersRegistered`. The
  registry argument is optional so the test path
  (`loadManifestFromString` without a registry) is unchanged.
- **Resume path:** `resumeRun` (in `src/host/api.ts`) ALSO calls
  `loadManifest(manifestPath)` at line 175 — to verify the snapshot's
  pinned `manifest_version` matches the on-disk manifest (§10).
  The preflight check therefore runs on resume too; the resume
  `ResumeRunOptions` interface must also accept the optional
  `modelRegistry`, and the extension's `handleResume` (in
  `src/extension/commands/resume.ts:90`) must forward
  `ctx.modelRegistry` to `resumeRun` the same way `handleStart`
  does. Same registry → same warnings → no double-fire concern.
- **CLI path:** the CLI fallback (`src/bin/conduct.ts:runCli`)
  constructs a `ModelRegistry` and threads it through the host
  factory's `extension.modelRegistry` (lines 178–183). The CLI is
  in scope for this issue: `runCli` must forward
  `CliDeps.modelRegistry` to `startRunImpl` via the new
  `StartRunOptions.modelRegistry` field, and surface any
  preflight warnings to stderr/stdout before the run starts (the
  CLI has no TUI; warnings are not user-interactive).
- **`RunHandle` surface:** the `RunHandle` constructor
  (`src/host/run-handle.ts:79–88`) currently does NOT accept or
  store `loadedManifest`. The handle exposes `runId`, `def`,
  `log`, and a private `configOverrideContainer`, but the loaded
  manifest is only available in the host factory's
  `HostFactoryContext` (per `api.ts:134` / `api.ts:186`),
  never on the handle itself. To surface warnings from the
  extension (or the CLI), the handle must grow a public
  `loadedManifest` field. The constructor opts gain a
  `loadedManifest: LoadedManifest` field; both `startRun` and
  `resumeRun` in `api.ts` must pass it to the `RunHandle`
  constructor (currently they don't).
- **Warning surfacing:** the existing flow
  (`LoadedManifest.warnings` → `startRun` / `resumeRun` →
  extension `handleStart` / `handleResume` UI notify, OR
  CLI `runCli` stderr) is the right channel. No new record
  types, no new reducer paths, no new state. The surfacing is
  a one-line read of `handle.loadedManifest.warnings` after
  `startRun` / `resumeRun` returns, plus the `ctx.ui.notify`
  or `out.error` call. (A follow-on `setStatus` widget is
  possible but `notify` / stderr is sufficient for "you have
  an unregistered provider" — the user gets the message and
  can choose to act.)

## Tasks

- [ ] **T2.1** Edit `src/manifest/validate.ts`:
      - Add `"unregistered-provider"` to the `ManifestWarningCode`
        union. The union is just a string-literal type — adding a
        code does not import pi. Confirms the grep guard is
        preserved: the file still has zero pi imports.
      - This is the only change in `src/manifest/`. The actual
        check that emits the warning lives in `src/host/`.

- [ ] **T2.2** Add `checkModelProvidersRegistered` in
      `src/host/manifest.ts` (or split into a new
      `src/host/preflight-model-providers.ts` if the file is
      approaching the 400-LOC ceiling — currently ~180 LOC, so
      `src/host/manifest.ts` is fine):
      - Signature:
        `checkModelProvidersRegistered(manifest: Manifest, modelRegistry: ModelRegistry): readonly ManifestWarning[]`
      - Implementation: iterate `manifest.roles[].models[]`, skip
        roles with no `models` or empty `models`, for each entry
        call `modelRegistry.find(provider, id)`. On `undefined`,
        emit a `ManifestWarning` with code
        `"unregistered-provider"`, `role` = the role name, and a
        message naming the entry string and the role.
      - Internal note: this check is structurally identical to
        what `resolveModel` would do for each entry — but called
        pre-emptively at load time, not on first `spawnRole`. Keep
        the implementation independent (no shared `splitProviderId`
        import); the import boundary keeps the load-time check
        clearly distinct from the runtime resolution. The existing
        `splitProviderId` is not exported; a re-implementation here
        is fine (or, if you'd rather, export it from
        `production-host-resolve.ts` and import — preference call
        during implementation).
      - **Cap the result:** one warning per (role, entry). If a
        role has `models: [a, b, c]` and all three miss, that's
        three warnings, not one aggregate. Matches the existing
        validator's per-entry granularity.

- [ ] **T2.3** Edit `src/host/manifest.ts`:
      - Add an optional `modelRegistry` parameter to
        `loadManifest(path, opts?: { modelRegistry?: ModelRegistry })`.
        Forward it to `loadManifestFromString`.
      - Add an optional `modelRegistry` parameter to
        `loadManifestFromString(rawYaml, manifestDir, modelRegistry?)`.
        When provided, call `checkModelProvidersRegistered` AFTER
        `validateManifest` + `toMachineDefinition`, append its
        warnings to `report.warnings`, and freeze the merged list
        onto the returned `LoadedManifest.warnings`.
      - Update the `LoadedManifest.warnings` JSDoc to mention
        `"unregistered-provider"` is produced when a
        `ModelRegistry` is provided at load time. (One line.)
      - Update the module-level JSDoc on `src/host/manifest.ts` to
        note this is an additional advisory check, separate from
        spec §13.

- [ ] **T2.4** Edit `src/host/api.ts`:
      - `startRun` lives here (line 118). It currently calls
        `loadManifest(manifestPath)` on line 119. Add an
        optional `modelRegistry?: ModelRegistry` field to
        `StartRunOptions` (line 73) and forward it:
        `loadManifest(manifestPath, { modelRegistry: opts.modelRegistry })`.
      - `resumeRun` ALSO needs the same change — it calls
        `loadManifest(manifestPath)` at `api.ts:175` to verify
        the snapshot's pinned `manifest_version` matches the
        on-disk manifest (§10). The freshly-loaded manifest is
        the source of `def` for the resumed run; a mismatch
        throws. Add an optional `modelRegistry?: ModelRegistry`
        field to `ResumeRunOptions` (line 87) and forward it the
        same way: `loadManifest(manifestPath, { modelRegistry: opts.modelRegistry })`.
        The preflight check runs again on resume; same registry
        → same warnings, no double-fire concern.
      - The `loadManifest` callers in the production paths are:
        - `src/extension/commands/start.ts:202` (run start —
          has `ctx.modelRegistry` at line 137, must forward
          to `startRun` via the new option; covered by T2.6).
        - `src/extension/commands/resume.ts` (run resume — has
          `ctx.modelRegistry` at line 90; calls `resumeRun` at
          line 109; must forward the registry via the new
          `ResumeRunOptions.modelRegistry`; covered by T2.6).
        - `src/bin/conduct.ts:runCli` (CLI fallback — has
          `CliDeps.modelRegistry` from the
          `ModelRegistry.create(AuthStorage.create())` in
          `main()` at line 253; calls `startRunImpl` at
          line 235; must forward the registry to
          `startRunImpl` via the new `StartRunOptions.modelRegistry`;
          covered by T2.7).
        - `src/extension/commands/list.ts:104` (line list
          command — no registry) is the only production
          caller without a registry; the check is skipped
          (no registry passed, no warning), which is correct
          — the list command doesn't spawn runs.

- [ ] **T2.5** Edit `src/host/run-handle.ts`:
      - Add `loadedManifest: LoadedManifest` to the `RunHandle`
        constructor opts (currently lines 79–88 do NOT accept
        it; the existing fields are `runId`, `def`, `log`,
        `configOverrideContainer`, `requestAbort`,
        `completionPromise`).
      - Expose it as a public `readonly` field, alongside the
        existing public `readonly` fields (`runId`, `def`,
        `log`). The field is set once in the constructor and
        never mutated. JSDoc points to the manifest doc-comment
        and notes the read-only contract.
      - Update `RunWithCompletionArgs` in `api.ts` to pass
        `loadedManifest: loaded` through to the `new RunHandle(...)`
        call (the existing `RunWithCompletionArgs` already
        carries `loadedManifest` for the `getRunCostCap` closure;
        just thread it into the constructor call). Both
        `startRun` and `resumeRun` build the handle via
        `runWithCompletion`; this change covers both paths.
      - This is a **required** change, not a fallback: without
        it, neither the extension nor the CLI can read the
        preflight warnings from the handle. The handle owns
        the run's state and is the natural read surface for
        downstream code (mirrors how `handle.def` and
        `handle.runId` are read today).
      - The dedicated test work for this field lives in T2.11
        (`tests/host/run-handle.test.ts`); no assertion is
        added to the existing `RunHandle.abort()` describe
        block to keep that test focused on its original
        scope.

- [ ] **T2.6** Edit `src/extension/commands/start.ts` AND
      `src/extension/commands/resume.ts`:
      - **`start.ts` (T2.6a)** — pass `ctx.modelRegistry` through
        to `startRun` via the new `StartRunOptions.modelRegistry`
        field (line 202 call site):
        `handle = await startRun(manifestPath, { goal, hostFactory, baseDir, modelRegistry });`
        The `modelRegistry` is already extracted at line 137
        (`const modelRegistry = ctx.modelRegistry;`), so no new
        extraction is needed.
      - **`start.ts` surfacing (T2.6b)** — after `startRun`
        returns, the extension now reads
        `handle.loadedManifest.warnings` (the new field from
        T2.5) and surfaces any `"unregistered-provider"`
        entries via `ctx.ui.notify(..., "warning")` — one
        aggregated notification is preferred (the message
        names every affected role + entry). Don't block the
        run start; warnings are advisory. Place the surface
        step BEFORE the `setActiveRun(handle)` call so a
        preflight warning fires before the run-status UI is
        installed.
      - **`resume.ts` (T2.6c)** — symmetric to `start.ts`:
        pass `ctx.modelRegistry` (already extracted at line 90)
        through to `resumeRun` via the new
        `ResumeRunOptions.modelRegistry` field (line 109 call
        site):
        `handle = await resumeRun(manifestPath, runId, { goal: "", hostFactory, baseDir, modelRegistry });`
        Then read `handle.loadedManifest.warnings` after
        `resumeRun` returns and surface any
        `"unregistered-provider"` entries via
        `ctx.ui.notify(..., "warning")` — same aggregated
        pattern as `start.ts`. The user just resumed a run;
        re-surfacing a load-time warning on resume is correct
        (the registry contents may have changed since
        start — a fresh preflight at resume time is the
        authoritative answer).

- [ ] **T2.7** Edit `src/bin/conduct.ts:runCli` to plumb the
      registry through and surface warnings on stderr:
      - The `ModelRegistry` is already created in `main()`
        (line 253: `ModelRegistry.create(AuthStorage.create())`)
        and exposed via `CliDeps.modelRegistry` (line 82,
        field of the public deps interface). The CLI's
        `runCli` already destructures it (line 165) and threads
        it into the host factory's
        `extension.modelRegistry` (line 178). The
        `startRunImpl` call at line 235 currently does NOT
        forward it; the change is a one-field addition to the
        `StartRunOptions`:
        `startRunImpl(manifestAbs, { goal, hostFactory, modelRegistry })`.
      - After `startRunImpl` returns the handle, the CLI
        reads `handle.loadedManifest.warnings` (the new field
        from T2.5) and prints any `"unregistered-provider"`
        entries to `out.error(...)` BEFORE the `await
        handle.completion()` call. Aggregated message:
        `"pi-conductor: <N> role.models[].entry value(s) are
        not registered in the ModelRegistry: <list>".`
        Don't block the run; the CLI still proceeds to the
        completion-await path. The runtime
        `ModelNotFoundError` is unchanged (it surfaces later
        from `spawnRole` if the entry is actually used; the
        CLI handles that error in its existing catch block).
      - Update `runCli`'s JSDoc to mention the preflight
        warning surface (one sentence: "warnings from the
        load-time `unregistered-provider` check are written
        to stderr before the run begins").

- [ ] **T2.8** Edit `CHANGELOG.md`:
      - Add a new `## [Unreleased]` entry above the current
        latest. `### Enhancements` heading (matches `### Bug
        fixes` convention from `[0.5.1]`).
      - Suggested wording: "Warn at load time when a
        `role.models[].entry` is not registered in the
        `ModelRegistry` (advisory `unregistered-provider`
        warning; issue #6). Surfaced on the extension
        `/conduct` and `/conduct:resume` paths (via
        `ctx.ui.notify`) and on the `conduct` CLI (via
        stderr). The runtime `ModelNotFoundError` is
        unchanged."

## Tests

- [ ] **T2.9** Add tests in `tests/host/manifest.test.ts`:
      - `unregistered-provider` warning emitted when the
        registry's `find` returns `undefined` for a declared
        entry. Use a fake `ModelRegistry` whose `find` always
        returns `undefined`; load a manifest with one role +
        `models: [{ model: "ollama:something", effort: "medium" }]`;
        assert `LoadedManifest.warnings` contains one
        `unregistered-provider` entry with the right role.
      - No warning when `find` returns a model. Register a
        provider + model in the fake registry; assert
        `warnings` does NOT contain `unregistered-provider`.
      - No warning when no `ModelRegistry` is passed (existing
        back-compat). Load without `modelRegistry`; assert
        `warnings` is empty (or only contains the existing
        soft-warning codes, not `unregistered-provider`).
      - Roles without `models` are skipped (system-model path).
        Load a manifest with a role that has no `models` field;
        assert `warnings` does not contain `unregistered-provider`
        for that role even when the registry's `find` would
        return `undefined`.
      - Per-entry granularity: a role with three entries that
        all miss → three warnings, not one.
      - Hard errors still block: an entry that fails
        `validateManifest` (`bare-model-alias`) still throws
        `HostManifestError` before the preflight check runs.
        Confirms the new check is strictly post-validation, not
        a replacement for §13.

- [ ] **T2.10** Add tests in `tests/host/api.test.ts` for the
      new `modelRegistry` option on `StartRunOptions` and
      `ResumeRunOptions`:
      - `startRun` with `modelRegistry` → preflight runs;
        `handle.loadedManifest.warnings` contains the
        expected `"unregistered-provider"` entries; the
        warnings surface to the caller (read via
        `handle.loadedManifest.warnings`).
      - `startRun` without `modelRegistry` → preflight
        skipped; `handle.loadedManifest.warnings` does NOT
        contain `"unregistered-provider"`.
      - `resumeRun` with `modelRegistry` → preflight runs on
        the resumed load; same warning set as a fresh
        `startRun` with the same registry.
      - `resumeRun` without `modelRegistry` → preflight
        skipped on resume; existing run state preserved.
      - `handle.loadedManifest` is the same reference
        returned by `loadManifest` (cheap reference-equality
        check; confirms the T2.5 field is wired correctly).

- [ ] **T2.11** Add tests in `tests/host/run-handle.test.ts`:
      - Existing `RunHandle.abort()` describe block: add a
        one-line assertion that the new
        `handle.loadedManifest` field is the same reference
        passed to the constructor (covers T2.5's wiring).
      - New describe block for the `loadedManifest` accessor:
        pass a fake `LoadedManifest` to the constructor; read
        `handle.loadedManifest` and assert it is the same
        reference (read-only, no setters, no side effects on
        read).

- [ ] **T2.12** Add tests in `tests/bin/conduct.test.ts` (or
      the existing CLI test file) for the CLI surface:
      - `runCli` with a `ModelRegistry` whose `find` returns
        `undefined` → `out.error` is called with an aggregated
        preflight message naming the affected role/entry;
        the run still proceeds to `handle.completion()`.
      - `runCli` with a `ModelRegistry` whose `find` returns
        a model → no preflight message on `out.error`.

- [ ] **T2.13** Confirm the grep-guard test still passes:
      - `pnpm test -- tests/grep-guard.test.ts` — the check
        scans `src/manifest/**` (and `src/core`, `src/seam`,
        `src/cost`, `src/persistence`) for
        `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai`
        imports. Phase 2 only adds a string literal to
        `ManifestWarningCode` in `src/manifest/validate.ts` —
        no new imports. The guard passes unchanged.

## Verification

- `pnpm typecheck` — clean. The new `checkModelProvidersRegistered`
  signature is fully typed; `ModelRegistry` import is in
  `src/host/`, which the grep guard allows. The new
  `RunHandle.loadedManifest` field is fully typed; the
  `StartRunOptions.modelRegistry` and
  `ResumeRunOptions.modelRegistry` fields are fully typed.
- `pnpm lint` — clean. The new function follows the existing
  style (named exports, no default, JSDoc on public exports).
- `pnpm test` — all green, including the new tests in
  `tests/host/manifest.test.ts` (T2.9),
  `tests/host/api.test.ts` (T2.10 — covers startRun +
  resumeRun + handle.loadedManifest wiring),
  `tests/host/run-handle.test.ts` (T2.11 — covers the new
  `loadedManifest` field), `tests/bin/conduct.test.ts`
  (T2.12 — covers the CLI surface), and the unchanged
  `tests/grep-guard.test.ts`.
- Manual: in `extensions/conduct.ts` or a test harness, load a
  manifest with `ollama:something` in `models` while only
  `anthropic` is registered. Confirm the warning surfaces via
  the extension UI on `/conduct` AND on `/conduct:resume`;
  confirm the runtime `spawnRole` still throws
  `ModelNotFoundError` (the warning does not suppress the
  error — it's advisory only).
- Manual: in the same setup, run `conduct manifest.yaml "goal"`
  from the CLI (with only `anthropic` registered in
  `ModelRegistry.create(AuthStorage.create())` and
  `ollama:something` declared in the manifest's
  `role.models[].entry`). Confirm the preflight message
  appears on stderr; confirm the run still proceeds to
  `handle.completion()`; confirm the runtime
  `ModelNotFoundError` still surfaces from `spawnRole` (if
  the model is actually used) — the warning is advisory
  only.
- Manual: in the same setup, register `ollama` after loading
  the manifest. Confirm the warning is not retroactive (the
  check is load-time, not per-spawn). Matches the issue's
  rationale: "the provider might be registered by a pi
  extension that loads after conductor, or the provider
  might be dynamically registered during setup."

## Out of scope

- **Differentiating provider-not-registered vs id-not-found.**
  Both surface as `ModelNotFoundError`; one warning code is
  sufficient. A future finer-grained diagnostic is additive.
- **Hard rejection.** Issue #6 explicitly states advisory; a
  hard reject would block legitimate cases (late-loading pi
  extensions, dynamic registration).
- **Spec §13 changes.** The check is a host-side addition,
  not a §13 extension. §13 stays scoped to static structural
  rules. The new code is documented in `src/host/manifest.ts`'s
  JSDoc as an "additional advisory check" — explicit boundary.
- **Better `ModelNotFoundError` messages.** The existing message
  names the role and the full entry, which is enough to debug.
  A "did you mean…" hint is a separate enhancement.
- **Retrospective re-checking.** The check is load-time. If a
  provider is registered after manifest-load, the warning
  doesn't get cleared (it was a snapshot). The runtime still
  works; the user just sees a stale warning. Acceptable trade-off
  given the issue's "advisory only" framing.

## Architectural rationale (for the plan reviewer)

The check is NOT in the §13 validator because:

1. The validator must stay host-agnostic (AGENTS.md invariant
   #1, grep guard). Adding `ModelRegistry` to its signature
   would require either a `ModelRegistry`-shaped interface
   declared in `src/manifest/` (extra indirection, type
   coupling) or a cast/escape that the grep guard flags.
2. The check operates on the **runtime** registry, which is a
   §8.1 concern (model resolution), not a §13 concern
   (manifest static structure). Spec §13 explicitly enumerates
   its scope: structural rules on the manifest YAML.
3. The check is structurally similar to the existing
   `no-cheaper-fallback` and `missing-required-tool` soft
   warnings — they live in the validator because they inspect
   `role.models` / `role.tools` from the parsed manifest
   (structural). The new check inspects an **external runtime
   artifact** (the `ModelRegistry`), so its home is
   `src/host/manifest.ts` where the registry import is legal.

The check is NOT in `toMachineDefinition` because:

1. `toMachineDefinition` produces the reducer's `def` snapshot.
   It should not have runtime side inputs (it would change the
   reducer's `def` from a pure derivation to a runtime-dependent
   one). Phase 1's `toMachineDefinition` is host-agnostic.
2. The check is an **advisory warning** — `toMachineDefinition`
   throws on hard errors, not warnings.

The check is NOT inside `ProductionHost` because:

1. The host is constructed at run-start, but the user's
   first read of the warnings should be at manifest-load
   (before the run starts). Catching it later means the user
   has already kicked off the run before the warning shows.
2. The `LoadedManifest.warnings` list is the natural
   integration point — it's the existing channel for
   load-time soft warnings.

## Risk

Medium. The architectural decision (host-side, post-validation,
pre-startRun) is a clean fit but the plumbing touches six
files (`src/manifest/validate.ts` for the new warning code,
`src/host/manifest.ts` for the check + `loadManifest` signature,
`src/host/api.ts` for the `startRun` + `resumeRun` options
plus the `RunHandle` constructor call,
`src/host/run-handle.ts` for the new `loadedManifest` field,
`src/extension/commands/start.ts` + `resume.ts` for plumbing
and warning surface, and `src/bin/conduct.ts:runCli` for the
CLI plumbing). The check itself is ~15 LOC; the plumbing is
the bulk of the diff. Behavior is strictly additive: callers
that don't pass a `ModelRegistry` see no change. The grep
guard is the main invariant to preserve, and it's preserved
by design.
