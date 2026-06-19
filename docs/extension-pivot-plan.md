# Extension Pivot Plan — pi-conductor as a pi extension

> **Status:** Draft — awaiting human review before any task starts.
> **Scope:** Pivot the delivery target from "importable library + SDK host
> driver" to "installable pi extension exposing `/conduct` (and friends) inside
> pi," reusing the existing pure core + SDK host driver as the engine.
> **Authority relationship:** This plan sits **on top of**
> `docs/orchestrator-fsm-spec.md` and `docs/orchestrator-fsm-plan.md`. It does
> **not** reopen the FSM spec. It supersedes only the **delivery-shape** parts of
> the plan (§9.5 "host = pi SDK, not a TUI extension" is **clarified, not
> reversed**: the orchestration engine stays the SDK host; the extension is the
> UX shell around it).

## 1. The correction, precisely stated

The original plan resolved §9.5 as "**host = pi SDK, not a TUI extension**" and
shipped pi-conductor as an importable library whose `Host` drives the standalone
`createAgentSession`. That decision stays. What the plan did **not** do — and what
the human's end-goal always required — is package that engine as a **pi
extension** so a user installs it and types `/conduct <goal>` inside pi.

The gap is **packaging + a UX shell + the production `Host`**, not a re-architecture.
Verified facts that make this true:

- `src/host/stub-host.ts` already calls the **standalone `createAgentSession`**
  (`@earendil-works/pi-coding-agent`'s top-level export), not
  `ExtensionContext.newSession` or any session-replacement surface. This is
  exactly the function an extension module imports to spawn under-the-hood role
  sessions. No host rewrite is needed for the pivot.
- `ExtensionCommandContext` (the `ctx` handed to `registerCommand` handlers)
  exposes `modelRegistry` and `cwd` — both reusable to share pi's configured
  providers and working directory with spawned role sessions.
- `ExtensionCommandContext.newSession()` exists but is the **pi-native session
  replacement/forking** surface. We **do not use it** for role sessions: that
  would put workers in pi's session tree, reopening §9.5 and breaking the
  host-owned `run_id`-keyed log (spec §11.1). It remains legal for future
  `/conduct` affordances (e.g., "open this run's log in a new pi session"), but
  v1 role sessions are standalone `createAgentSession` calls.
- pi packages auto-discover `extensions/*.ts` (conventional dirs) or whatever
  `package.json#pi.extensions` globs point at. Distribution is `pi install
  npm:pi-conductor` / `git:…` / local path.

So: the pure core (Phases 1–3) is reused unchanged; the SDK host driver (Phase 4)
is reused with **one production `Host` implementation added** (the gap that
already blocked real-model testing); **Phase 5 surfaces become extension
commands/UI**; and a new **Phase 7 (extension shell)** wraps it all.

## 2. What changes, what doesn't

### Reused unchanged

- `src/core`, `src/manifest`, `src/seam`, `src/cost`, `src/persistence` — pure,
  host-agnostic, zero pi imports. The grep-guard invariant is untouched.
- `src/host/host.ts` (`Host` interface, `RoleSession`, `SpawnRoleOptions`) — the
  seam the loop programs against.
- `src/host/loop.ts`, `src/host/tools.ts`, `src/host/seam.ts`,
  `src/host/tool-wrapper.ts`, `src/host/cost.ts`, `src/host/stats.ts`,
  `src/host/run-handle.ts`, `src/host/api.ts` (`startRun`/`resumeRun`/`listRuns`),
  `src/host/log-file.ts`, `src/host/manifest.ts`, `src/host/config.ts`,
  `src/host/defaults.ts`.
- `src/host/stub-host.ts` + `src/host/stub-provider.ts` — the stub E2E path stays
  for CI; the extension tests can also drive a real `pi` process with the stub
  provider registered.
- All existing tests (329) and the grep guard.

### Added (the real work)

1. **`src/host/production-host.ts`** — a `Host` implementation that resolves
   `role.models[]` `provider:id` entries to real `Model`s via
   `modelRegistry.find(provider, id)`, loads each `role.system_prompt` file from
   disk and wires it via `DefaultResourceLoader({ systemPromptOverride: () =>
   rolePrompt })`, and uses a real/file-backed `SessionManager`. This is the gap
   that **already** blocked real-model user testing under the library framing —
   the pivot does not create it, it inherits it. Built so it can be constructed
   from an `ExtensionCommandContext` (shares `modelRegistry`/`cwd`) **or**
   standalone (for a CLI fallback / tests).
2. **`extensions/conduct.ts`** (the pi extension entrypoint) — `export default
   function (pi: ExtensionAPI)`. Registers:
   - `/conduct <goal>` — `pi.registerCommand("conduct", …)`. Handler builds a
     `productionHostFactory` from `ctx.modelRegistry`/`ctx.cwd`, calls
     `startRun(manifestPath, { goal, hostFactory })`, and surfaces the
     `RunHandle` to the user (notify on start, on completion; stream status via
     `ctx.ui.setStatus`).
   - `/conduct:resume <run_id>` — `resumeRun`.
   - `/conduct:list` — `listRuns` rendered via `ctx.ui.custom()` or a selector.
   - `/conduct:runs` (optional, v1.1) — a TUI run viewer
     (`ctx.ui.custom()` widget) showing live run status from `RunHandle.runStats()`.
   - `/conduct:abort` — `RunHandle.abort()`.
   - A `pi.registerFlag("--conduct-manifest", { type: "string" })` for
     overriding the manifest path (default: `.pi/conductor.yaml` resolved
     against `ctx.cwd`).
   - The handler defers `startRun` to the command body (never the extension
     factory) per `docs/extensions.md`'s "long-lived resources" guidance:
     factories may run in invocations that never start a session.
3. **`package.json` `pi` manifest** — `"pi": { "extensions": ["./extensions"] }`,
   `"keywords": ["pi-package"]`, and the pi core packages moved to
   `peerDependencies` (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`,
   `typebox`) per `docs/packages.md` ("do not bundle them"). `pi install` runs
   `npm install --omit=dev`, so anything the extension imports at runtime must be
   in `dependencies` (the pure core + `src/host` runtime deps) — **except** the
   pi core packages, which pi bundles.
4. **Extension E2E test** — drive the real `pi` process (or an in-process
   `ExtensionAPI` harness if available) with the stub provider registered, invoke
   `/conduct <goal>`, and assert the run reaches a terminal state. This is the
   gate that proves the extension shell actually works, not just that the library
   compiles.

### Changed (spec/plan text, not behavior)

- `docs/orchestrator-fsm-plan.md` §9.5 note: append a clarifying paragraph that
  the SDK host is the **engine** and the extension is the **shell**; §9.5's
  rejection of "orchestration *as* extension tool/event handlers" stands; role
  sessions remain standalone `createAgentSession` calls.
- `README.md` — replace the "It is a library, not a pi extension" section. The
  new framing: pi-conductor ships as a pi extension; the pure core + SDK host
  driver are the engine it wraps; the library is also importable for advanced /
  test use.
- `AGENTS.md` "Current status" — mark the pivot.

### Explicitly NOT changed

- The FSM spec (`docs/orchestrator-fsm-spec.md`). The reducer, lifecycle, caps,
  persistence, records, run-memory are all untouched. The pivot is delivery-shape
  only.
- The host-owned `run_id`-keyed log (spec §11.1). Role sessions are **not** put
  in pi's session tree; `getBranch()` scoping stays unused.
- The grep-guard invariant. `src/extension/` (if we add a separate dir) is
  treated like `src/host/` — allowed to import pi. The extension entrypoint
  lives under `extensions/` (pi's conventional dir) and is exempt by location.
- The pure core's zero-pi-imports rule. The extension imports the **public
  barrel** (`src/index.ts`) + pi types only; it never reaches into `src/core`.

## 3. Task list

Each task has acceptance + verification. Phases 7A–7C gate each other; 7A can
land independently of the (already-needed) production `Host`.

### Phase 7A — Production `Host` (unblocks real-model runs, extension or not)

This is the task that was already missing under the library framing. It is
prerequisite to any real-model user test, with or without the extension shell.

➡️ Task 7A.1 — `src/host/production-host.ts`

- Implement `ProductionHost implements Host`:
  - Constructor takes `{ modelRegistry, cwd, log, loadedManifest, runId }`.
    `modelRegistry` is shared (from `ExtensionCommandContext` in the extension
    path; from a `ModelRegistry.create(authStorage, modelsPath)` in standalone).
  - `spawnRole(role, { modelIndex })`:
    - Resolve the model: read `roleConfig.models[modelIndex]`, split `provider:id`,
      call `modelRegistry.find(provider, id)`. Throw a typed `ModelNotFoundError`
      if absent. Track the logical `provider:id` string for the lifecycle record.
    - Load the system prompt: read `role.system_prompt` (resolved against `cwd`)
      as UTF-8. Throw `SystemPromptNotFoundError` if the path is declared but
      missing. Pass via
      `new DefaultResourceLoader({ cwd, agentDir, settingsManager,
      systemPromptOverride: () => rolePrompt })` then `await loader.reload()`,
      handed to `createAgentSession({ resourceLoader: loader, … })`.
    - Build the tool allowlist: `role.tools` + force-injected `handoff`/`end`.
    - Use a **file-backed** `SessionManager` (role session files live under a
      per-run subdirectory of the conductor log dir, **not** pi's session dir —
      keeps conductor runs isolated from pi's own session tree).
    - Wire the same event subscription + `SessionState` usage accumulation +
      per-session cap as `StubHost` (Task 17). Extract the shared
      `onSessionEvent` logic into a helper if it reduces duplication; otherwise
      duplicate (boring > clever).
  - `captureUsage` / `sessionTerminalReason` / `runCostSoFar` /
    `nextVisitIndex` / `getNextModel` / `abortSession` / `sealSession` /
    `persistRecord` / `seedRunMemory` — same semantics as `StubHost`, reading
    from `loadedManifest` + the log.
- **Acceptance:**
  - A real-model run against `ModelRegistry.create()` pointed at the developer's
    `~/.pi/agent/auth.json` reaches a terminal state (hand-coded two-role
    manifest, one orchestrator turn + one worker turn + `end`). Manual gate (no
    API key in CI); record a transcript in `docs/dev-run-transcripts/`.
  - Unit test: `spawnRole` with a mock `modelRegistry` exercises model
    resolution (hit + `ModelNotFoundError`), system-prompt loading (hit +
    `SystemPromptNotFoundError`), and the `resourceLoader` wiring (assert the
    `systemPromptOverride` is invoked). No network.
  - `pnpm typecheck && pnpm build && pnpm test && pnpm lint && pnpm
    format:check` green.
- **Verification:** the existing stub E2E suite still green; the new
  `tests/host/production-host.test.ts` green; manual real-model transcript
  committed.

➡️ Task 7A.2 — `productionHostFactory`

- A tiny factory `(ctx: { modelRegistry, cwd, runId, log, loadedManifest }) =>
  ProductionHost` used by both the extension command handler and a `bin/`
  fallback (see 7C.2). Keeps the extension thin.

### Phase 7B — Extension shell

Gate: Phase 7A landed and reviewed. The extension can't be user-tested without a
real `Host`.

➡️ Task 7B.1 — `extensions/conduct.ts` entrypoint

- `export default function (pi: ExtensionAPI)`.
- Register `/conduct` (start), `/conduct:resume`, `/conduct:list`,
  `/conduct:abort`, and the `--conduct-manifest` flag.
- The `/conduct` handler:
  1. Resolve the manifest path (flag override or `.pi/conductor.yaml` under
     `ctx.cwd`). Notify + bail if missing.
  2. Build `productionHostFactory` from `ctx.modelRegistry` + `ctx.cwd`.
  3. `const handle = await startRun(manifestPath, { goal: args, hostFactory })`.
  4. `ctx.ui.setStatus("conduct", "run <runId>: orchestrator…")` from
     `handle.runStats()` on a polling tick (the loop is sync-ish; poll
     `runStats()` on an interval, clear on completion).
  5. `const { finalCheckpoint, exitReason } = await handle.completion()`.
  6. `ctx.ui.notify(...)` with the terminal state.
- **Acceptance:**
  - `pi -e ./extensions/conduct.ts` loads without error; `/conduct` appears in
    command listing.
  - `/conduct <goal>` with the stub provider registered (via an
    `extensions/conduct.dev.ts` shim or a `--conduct-stub` flag) reaches a
    terminal state and notifies.
  - No call to `ctx.newSession()` for role sessions (asserted by code review +
    a grep guard: `extensions/conduct.ts` must not reference
    `ctx.newSession`/`ctx.fork` for role spawning).
- **Verification:** `tests/extension/conduct.test.ts` drives the extension
  factory with a stub `ExtensionAPI` (or an in-process harness if the SDK
  exposes one — verify before assuming; fall back to a real `pi -e` subprocess
  test if not). Green.

➡️ Task 7B.2 — Status/observability surface

- Wire `RunHandle.runStats()` → `ctx.ui.setStatus` / `ctx.ui.setWidget` so the
  user sees live role transitions, visit count, and remaining budget. Keep it
  minimal in v1 (status line + a widget with the run-memory summary); full TUI
  viewer deferred to v1.1.
- **Acceptance:** during a stub-driven run, the status line updates on each
  role transition; the widget shows `runStats()` fields. Tested in 7B.1's harness.

### Phase 7C — Packaging, distribution, docs

Gate: Phase 7B landed and reviewed.

➡️ Task 7C.1 — `package.json` as a pi package

- Add `"pi": { "extensions": ["./extensions"] }`, `"keywords": ["pi-package"]`.
- Move `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `typebox` to
  `peerDependencies` (`"*"` range) — pi bundles them; do not ship them in the
  tarball.
- Keep `@sinclair/typebox` alignment: verify whether pi re-exports `typebox` or
  `@sinclair/typebox` is the canonical name the SDK uses, and peer-depend on the
  **same name** pi's `Available Imports` table lists (`typebox`). Mismatched
  typebox instances would break `Static<typeof schema>` identity across the
  seam.
- Keep `pnpm` for dev; `pi install` uses `npm install --omit=dev` at the user's
  end — ensure no runtime import is accidentally in `devDependencies`.
- **Acceptance:** `pi install ./` (local path) on a clean checkout loads the
  extension and `/conduct` is available; `pi list` shows the package.
- **Verification:** manual + a CI job that runs `pi install ./` into a temp dir
  and asserts the extension loads.

➡️ Task 7C.2 — `bin/conduct.ts` fallback (optional, recommended)

- A thin CLI that calls `startRun` with `productionHostFactory` built from a
  fresh `ModelRegistry.create()`. Not the primary surface (the extension is),
  but it (a) gives CI a no-TUI way to exercise the production `Host`, and (b)
  gives non-pi users a fallback. Mark optional in v1 if scope is tight.
- **Acceptance:** `node dist/bin/conduct.js .pi/conductor.yaml "goal"` runs to
  completion against real models (manual gate).

➡️ Task 7C.3 — Docs pivot

- Rewrite `README.md`: lead with "pi-conductor is a pi extension for
  multi-role LLM orchestration." `pi install`, `/conduct` usage, manifest
  declaration, role prompt files, status surface. Keep a short "library use"
  section for advanced/test consumers. Remove the "It is a library, not a pi
  extension" framing.
- Update `docs/orchestrator-fsm-plan.md` §9.5 note (clarification, not
  reversal — see §1).
- Update `AGENTS.md` "Current status" + "Repo layout" (add `extensions/`).
- Add `docs/extension-usage.md` with the `/conduct` command reference, the
  manifest path resolution rules, and the "role sessions are independent SDK
  sessions, not pi session-tree entries" caveat (so users don't expect
  `/switch` into a worker).

## 4. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Extension uses `ctx.newSession()` for role sessions (reopens §9.5, breaks §11.1 log) | High | Grep guard on `extensions/conduct.ts` for `ctx.newSession`/`ctx.fork`; code review; spec note in §1 |
| Typebox identity mismatch across the seam (extension's `typebox` ≠ host's) | High — `Static<typeof schema>` breaks | Peer-depend on the **same** typebox name pi's `Available Imports` table lists; verify in 7C.1 before shipping |
| `pi install` uses `npm install --omit=dev` → runtime import in devDeps vanishes | Med | Audit `dependencies` vs `devDependencies` in 7C.1; CI job installs with `--omit=dev` and loads the extension |
| Production `Host` shares `ctx.modelRegistry` → spawned role sessions see pi's configured providers incl. the user's API keys | Med (security) | Intended (that's how the user's configured models become available); document it. Never log API keys. `modelRegistry.find` returns the `Model`, not the key. |
| Extension factory starts `startRun` (long-lived) → resource leak in no-session invocations | Med | Defer all `startRun` calls to command handlers (never the factory); matches `docs/extensions.md` guidance. Assert in 7B.1. |
| Polling `runStats()` for the status line races the sync loop | Low | The loop writes stats to the `RunHandle` synchronously per transition; poll on a coarse interval (250ms) and render the last value. No cross-process sync needed. |
| No in-process `ExtensionAPI` harness exists → 7B.1 tests need a `pi -e` subprocess | Med | Verify the SDK surface first; if no harness, the subprocess test is slower but sufficient. Don't assume — check. |
| Real-model E2E can't run in CI (no API key) | Med | CI runs the stub-provider path; the real-model gate is manual with a committed transcript (7A.1). Same as under the library framing. |
| `SessionManager` file location for role sessions collides with pi's session dir | Low | 7A.1 puts role session files under the conductor log dir, not pi's. Verified against `SessionManager.create(cwd)` semantics in `docs/sdk-surface.md` §6. |

## 5. Verification (whole plan)

- [ ] Phase 7A: a real-model run reaches a terminal state (manual transcript);
  stub E2E still green; `pnpm test` + lint + typecheck + build clean.
- [ ] Phase 7B: `pi -e ./extensions/conduct.ts` loads; `/conduct` with the stub
  provider reaches a terminal state and notifies; no `ctx.newSession` for role
  sessions (grep-guarded).
- [ ] Phase 7C: `pi install ./` on a clean checkout loads the extension; typebox
  peer-dep identity verified; no runtime import in `devDependencies`.
- [ ] README + plan + AGENTS.md reflect the extension framing; §9.5 clarification
  recorded.
- [ ] The pure core grep guard still passes (the extension does not weaken it).

## 6. Out of scope for this pivot

- A full TUI run viewer (`ctx.ui.custom()` with keyboard nav) — v1.1.
- Putting role sessions in pi's session tree (`ctx.newSession`/`fork`) —
  explicitly rejected (§1).
- Reopening the FSM spec — the pivot is delivery-shape only.
- A public npm publish — local-path and git installs are the v1 distribution;
  npm publishing is a separate decision after user testing.
