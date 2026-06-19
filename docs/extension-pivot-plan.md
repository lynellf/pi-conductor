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
- `AGENTS.md` "Current status" + "Repo layout" — mark the pivot and add
  `extensions/`.

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

## 3. Implementation sub-plans

Task details now live in phase sub-plans so each implementation slice has its
own acceptance criteria, verification, dependency notes, and likely files
touched. This parent remains the canonical overview and gate index.

### Phase 7A — Production `Host`

➡️ Sub-plan:
[`docs/extension-pivot-plans/phase-7a-production-host.md`](extension-pivot-plans/phase-7a-production-host.md)

Gate: unblocks real-model runs with or without the extension shell. This is the
production `Host` gap that already existed under the library framing.

Exit criteria:
- [ ] `ProductionHost` resolves `provider:id` models, loads role prompts, wires
      `DefaultResourceLoader`, spawns real role sessions, and preserves the
      existing host-loop semantics.
- [ ] A factory can construct the production host from an
      `ExtensionCommandContext`-shaped object without importing extension code
      into `src/host`.
- [ ] Stub E2E remains green; production-host unit tests are green; a manual
      real-model transcript is recorded.
- [ ] Human review before Phase 7B.

### Phase 7B — Extension shell

➡️ Sub-plan:
[`docs/extension-pivot-plans/phase-7b-extension-shell.md`](extension-pivot-plans/phase-7b-extension-shell.md)

Gate: Phase 7A landed and reviewed. The extension can be loaded before 7A, but
`/conduct` cannot be meaningfully user-tested without the production host.

Exit criteria:
- [ ] `extensions/conduct.ts` registers `/conduct`, `/conduct:resume`,
      `/conduct:list`, `/conduct:abort`, and `--conduct-manifest`.
- [ ] `/conduct <goal>` starts a run through `startRun` + production
      `hostFactory`, surfaces progress with `RunHandle.runStats()`, and notifies
      on completion.
- [ ] Role sessions remain standalone `createAgentSession` sessions; no
      `ctx.newSession()` / `ctx.fork` path is used for role spawning.
- [ ] Extension harness or `pi -e` test proves the shell loads and the stub path
      reaches a terminal state.
- [ ] Human review before Phase 7C.

### Phase 7C — Packaging, distribution, docs

➡️ Sub-plan:
[`docs/extension-pivot-plans/phase-7c-packaging-distribution-docs.md`](extension-pivot-plans/phase-7c-packaging-distribution-docs.md)

Gate: Phase 7B landed and reviewed.

Exit criteria:
- [ ] `package.json` declares the pi package metadata and keeps pi-bundled
      packages as peers without moving runtime imports into `devDependencies`.
- [ ] `pi install ./` on a clean checkout loads the extension and exposes
      `/conduct`.
- [ ] Optional CLI fallback is either implemented and documented or explicitly
      deferred.
- [ ] README, main FSM plan, AGENTS, and extension usage docs reflect the
      extension framing without reopening the FSM spec.

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
| Real-model E2E can't run in CI (no API key) | Med | CI runs the stub-provider path; the real-model gate is manual with a committed transcript (7A.5). Same as under the library framing. |
| `SessionManager` file location for role sessions collides with pi's session dir | Low | 7A.3 puts role session files under the conductor log dir, not pi's. Verified against `SessionManager.create(cwd)` semantics in `docs/sdk-surface.md` §6. |

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
