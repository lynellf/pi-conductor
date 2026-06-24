# Spec: Publishing-Readiness Remediation

## What I found

### Test failures (4 tests, 3 files — P0 blocker)

`pnpm test` currently reports **4 failed | 537 passed (541)**. All four failures
are in the extension-shell test suite and share a single root cause:

**HOME-fallback manifest resolution leaks the developer's real
`~/.pi/conductor.yaml` into hermetic tests.**

- `tests/extension/conduct-start.test.ts` — 2 tests ("no manifest found" + "HOME
  fallback path in no-manifest message")
- `tests/extension/conduct-list.test.ts` — 1 test ("manifest is missing")
- `tests/extension/conduct-resume.test.ts` — 1 test ("manifest is missing")

Each test creates a temp `cwd` with no manifest and expects a "no manifest"
warning notification. But `resolveManifestPath(flagValue, ctx.cwd)` defaults
`homeDir` to `os.homedir()`, and the developer's `~/.pi/conductor.yaml` exists,
so the HOME fallback resolves a real manifest instead of returning `null`. The
handlers (`handleStart`, `handleList`, `handleResume`) call
`resolveManifestPath` with only two arguments — there is no path for the test
harness to inject a hermetic `homeDir`.

### Extension packaging bug (P0 — npm install would break)

`extensions/conduct.ts` imports from `../src/extension/commands/*.js`,
`../src/extension/*.js`, etc. These are TypeScript source files loaded by pi
via jiti (which resolves `.js` specifiers to `.ts` files at runtime). The
entire `src/` tree cascades: `src/extension/commands/start.ts` imports
`../../index.js` → `src/index.ts` → `src/core/*.ts`, `src/host/*.ts`, etc.

**`package.json#files` is `["dist", "extensions", "README.md"]` — `src/` is
NOT shipped.** So an `npm install pi-conductor` (or `pi install
npm:pi-conductor`) would have `extensions/conduct.ts` but not the `src/` tree
it imports from. The extension would fail to load at runtime.

This works today for `pi install ./` (local) and `pi install git:…` (git)
because `src/` is present in the working tree / git repo. It breaks for npm
publish, where only `files`-listed entries are packed.

### `private: true` (P1 — blocks npm publish)

`package.json` has `"private": true`, which blocks `npm publish`. The user has
confirmed the target is full npm publish readiness.

### Missing publish metadata (P1)

`package.json` lacks `repository`, `author`, `homepage`, `bugs`, and `license`
fields. `npm publish` does not require these, but they are standard for
discoverability and are checked by `npm audit` / registry metadata. The
`LICENSE` file exists (MIT, Copyright 2026 Ezell). No git remote is configured.

### No `prepare` script (P1 — git installs lack `dist/`)

`dist/` is gitignored. For `pi install git:…`, npm/pnpm runs `prepare` after
install — but no `prepare` script exists. So git installs get no `dist/`,
meaning `import { startRun } from "pi-conductor"` (which resolves to
`dist/index.js` via `main`/`exports`) would fail. The extension surface
works via jiti from `src/` (present in git), but the library API does not.

`prepublishOnly` (`pnpm typecheck && pnpm build && pnpm test`) already gates
npm publish, but does not cover git installs.

### No CHANGELOG.md (P1)

Missing entirely. Standard for any published package.

### Broken documentation links (P1)

Commit `237c0f0` ("remove completed plans") deleted 40 doc files (10,317
lines): all plan docs, `extension-usage.md`, `sdk-surface.md`,
`dev-run-transcripts/`, `handoff-visibility-spec.md`, `home-scoped-discovery-spec.md`,
`role-panel-review-flow-spec.md`, etc. Only `docs/orchestrator-fsm-spec.md` was
restored (in `8be1a93`).

The README references ~10 missing doc paths. AGENTS.md references ~7. Source
code and tests reference `docs/extensions.md`, `docs/packages.md`,
`docs/handoff-visibility-spec.md`, `docs/tui-bridge-plans/phase-5-renderer-polish.md`
— all missing.

### Audit findings (P2 — informational)

`pnpm audit --prod` reports 7 vulnerabilities (2 low, 2 moderate, 3 high) in
`undici`, transitive via `@earendil-works/pi-coding-agent` (a peer dependency).
These cannot be fixed by pi-conductor directly — they resolve when the consumer
installs a newer pi version.

### `peerDependencies` ranges (P2 — by design)

All four peers use `"*"`. The project convention (AGENTS.md, package-metadata
test) is that pi bundles these packages, so `"*"` lets the consumer's installed
version satisfy the peer. Changing to semver ranges is a separate decision and
is NOT part of this remediation.

## Assumptions

1. "Full npm publish readiness" means the package can be `npm publish`'d and
   subsequently installed via `npm install pi-conductor` or
   `pi install npm:pi-conductor`, with both the extension surface and the
   library API working out of the box.
2. The `src/` TypeScript source must be shipped in the npm package because
   `extensions/conduct.ts` imports from `../src/` and pi loads it via jiti
   (runtime TypeScript). The compiled `dist/` serves the library API
   (`main`/`exports`); the `src/` TypeScript serves the extension (jiti load).
   Shipping source is consistent with the jiti-based extension model.
3. The `peerDependencies` `"*"` ranges are intentionally kept — the project
   convention is that pi bundles these packages, and the `package-metadata`
   test asserts `"*"`. Changing ranges is out of scope.
4. The audit vulnerabilities are in a transitive peer dependency and cannot be
   remediated by pi-conductor. They are noted but not actioned.
5. No git remote is configured. The `repository` field will use a placeholder
   GitHub URL pattern (`github:earendil-works/pi-conductor`) that the maintainer
   can correct if the repo lives elsewhere. The `author` field will use the
   LICENSE copyright holder ("Ezell").
6. The broken doc links are remediated by **removing stale references** from
   README, AGENTS.md, and source comments — NOT by restoring deleted plan docs.
   The plan docs were intentionally removed ("remove completed plans"); restoring
   them is out of scope. The spec (`docs/orchestrator-fsm-spec.md`) and
   `docs/active-model-status-spec.md` survive and remain linked.

## Objective

Make pi-conductor ready for `npm publish` with both the extension surface and
the library API functional out of the box, all tests green, documentation links
non-broken, and standard publish metadata present.

## Proposed changes

### 1. Fix HOME-fallback test isolation (P0)

**Problem:** `handleStart`, `handleList`, `handleResume` call
`resolveManifestPath(flagValue, ctx.cwd)` without a `homeDir` argument, so the
HOME fallback always uses `os.homedir()`. Tests can't inject a hermetic
`homeDir`.

**Fix:** Thread an optional `homeDir` through the handler dependency
interface. The `HandleDeps` type already carries `getFlag` and `displaySink`;
add an optional `homeDir?: string`. When present, the handler passes it to
`resolveManifestPath`. When absent (production), `resolveManifestPath` defaults
to `os.homedir()` as today. The factory in `extensions/conduct.ts` does not
pass `homeDir`, so production behavior is unchanged.

The no-manifest notification message also uses `os.homedir()` directly for the
HOME path diagnostic. This should use the same `homeDir` value (from `deps` or
defaulted) so the message is consistent with what the resolver actually
checked.

**Tests:** Update the three failing test files to pass `homeDir: ""` (empty
string disables the HOME fallback per the existing `resolveManifestPath`
contract) through the `HandleDeps` injected by the test harness. No production
behavior changes.

**Alternative considered:** Pass `homeDir` through `ExtensionCommandContext`.
Rejected — the SDK context type is not ours to extend, and `HandleDeps` is the
existing injection point for handler-internal dependencies.

### 2. Ship `src/` in the npm package (P0)

**Problem:** `extensions/conduct.ts` imports from `../src/extension/*.js`
(loaded by jiti as TypeScript). `src/` is not in `files`.

**Fix:** Add `"src"` to the `files` array in `package.json`:
`["dist", "extensions", "src", "README.md", "LICENSE"]`. Also add `"LICENSE"`
explicitly (npm includes it by default, but explicit is better for
discoverability).

**Side effect:** The npm tarball grows (ships TypeScript source). This is
acceptable — the extension model requires it, and the source is the
authoritative artifact for jiti-loaded modules.

**Alternative considered:** Compile `extensions/conduct.ts` into
`dist/extensions/conduct.js` and point `pi.extensions` to `"./dist/extensions"`.
Rejected — requires tsconfig changes (extensions/ is outside `rootDir: ./src`),
breaks the local-dev jiti-from-source workflow, and adds complexity for no
benefit (jiti loads TypeScript natively).

**Alternative considered:** Change extension imports to `../dist/extension/*.js`.
Rejected — breaks local dev when `dist/` hasn't been built; the current
jiti-from-source approach is the project convention.

### 3. Flip `private: false` + add publish metadata (P1)

**Changes to `package.json`:**
- Remove `"private": true` (or set to `false`).
- Add `"license": "MIT"` (matches `LICENSE` file).
- Add `"author": "Ezell <lynellf@gmail.com>"` (from git config + LICENSE
  copyright).
- Add `"repository": { "type": "git", "url": "github:earendil-works/pi-conductor" }`
  (placeholder; maintainer corrects if the repo URL differs).
- Add `"homepage": "https://github.com/earendil-works/pi-conductor#readme"`.
- Add `"bugs": { "url": "https://github.com/earendil-works/pi-conductor/issues" }`.
- Bump `"version"` from `"0.1.0"` to `"0.1.0"` (no change needed — 0.1.0 is a
  valid first publish version; the maintainer decides on the actual first
  published version).

**Test update:** The `package-metadata.test.ts` may need a new assertion that
`private` is absent or `false` and that `license`/`repository` are present.

### 4. Add `prepare` script (P1)

**Change:** Add `"prepare": "pnpm build"` to `package.json#scripts`.

**Rationale:** `prepare` runs after `npm install` when installing from git
(equivalent to `pi install git:…`). It ensures `dist/` is built for library
consumers. In local dev, `pnpm install` also triggers `prepare`, which runs
`tsc` — this is fast and idempotent. `prepublishOnly` remains the full gate
(typecheck + build + test).

### 5. Add CHANGELOG.md (P1)

Create `docs/CHANGELOG.md` (or root `CHANGELOG.md`) with an initial `## [0.1.0]
- 2026-06-2x` entry summarizing the completed work (FSM core, host driver,
extension shell, CLI, manifest resolution, handoff visibility). Keep it concise
— one section per major area, bullet points.

Convention: root `CHANGELOG.md` (npm convention; shows on the npm registry
page). Add `"CHANGELOG.md"` to `files`.

### 6. Fix broken documentation links (P1)

**Approach:** Remove or rewrite stale references to deleted docs. Do NOT
restore deleted plan docs.

**README.md:**
- Remove links to `docs/orchestrator-fsm-plan.md`,
  `docs/orchestrator-fsm-plans/`, `docs/extension-pivot-plan.md`,
  `docs/extension-pivot-plans/`, `docs/extension-usage.md`,
  `docs/sdk-surface.md`, `docs/dev-run-transcripts/`,
  `docs/orchestrator-fsm-plans/phase-6-out-of-scope.md`.
- Keep the link to `docs/orchestrator-fsm-spec.md` (exists).
- Rewrite the "Status & what's left" and "Architecture in brief" sections to
  reference only the spec (no plan links). The "Not yet built" section can stay
  but should not link to a missing phase-6 doc.
- The pi doc references (`docs/quickstart.md`, `docs/sdk.md`) are links to
  pi's own docs inside the installed `@earendil-works/pi-coding-agent` package
  — these are fine as-is (they're describing where to look in pi's package, not
  in pi-conductor's repo).

**AGENTS.md:**
- Remove/rewrite references to `docs/orchestrator-fsm-plan.md`,
  `docs/orchestrator-fsm-plans/`, `docs/extension-pivot-plan.md`,
  `docs/extension-pivot-plans/`, `docs/extension-usage.md`,
  `docs/sdk-surface.md`, `docs/home-scoped-discovery-spec.md`.
- Update the "Current status" section to reflect the actual doc state (spec
  exists, plan docs removed).

**Source code comments:**
- `src/extension/status.ts` — references `docs/handoff-visibility-spec.md` (missing).
  Rewrite comment to describe the behavior inline without the doc link.
- `src/extension/conduct-message-renderer.ts` — references
  `docs/tui-bridge-plans/phase-5-renderer-polish.md` (missing). Same approach.
- `src/extension/display-sink-wiring.ts` — same missing reference. Same approach.
- `extensions/conduct.ts` — references `docs/extensions.md` (missing). Rewrite.
- `tests/package-metadata.test.ts` — references `docs/extensions.md` and
  `docs/packages.md` (missing). Rewrite comments to describe the contract
  inline.
- `tests/extension/conduct-message-renderer.test.ts` — references
  `docs/tui-bridge-plans/phase-5-renderer-polish.md` (missing). Rewrite.

**Conductor manifest comment:** `.pi/conductor.yaml` references
`docs/role-panel-review-flow-spec.md` and `docs/role-panel-review-flow-plan.md`
(missing). But `.pi/` is gitignored, so this doesn't affect the published
package. Note it but don't fix (out of scope for publishing — it's a local
config file).

### 7. Verify `npm pack` contents (P1 gate)

After changes, run `npm pack --dry-run` and verify:
- `src/` directory is present (extension imports resolve).
- `dist/` directory is present (library API).
- `extensions/conduct.ts` is present.
- `CHANGELOG.md` and `LICENSE` are present.
- No test files, no `node_modules`, no `.pi/` runtime data.

## Non-goals

- Restoring deleted plan/spec docs (intentionally removed).
- Changing `peerDependencies` ranges from `"*"`.
- Fixing transitive `undici` audit vulnerabilities (peer dependency).
- Building a TUI run viewer (v1.1, explicitly deferred).
- Adding CI/CD publish automation (separate decision).
- Updating `.pi/conductor.yaml` comments (gitignored, local config).

## Verification gates

After all changes:

1. `pnpm test` — all 541 tests green (4 previously failing now pass).
2. `pnpm typecheck` — clean.
3. `pnpm build` — clean, `dist/` emitted.
4. `pnpm lint` / `pnpm format:check` — clean.
5. `npm pack --dry-run` — includes `src/`, `dist/`, `extensions/`, `CHANGELOG.md`,
   `LICENSE`, `README.md`; excludes tests, node_modules, .pi/, scratch/.
6. `npm publish --dry-run` — succeeds (private removed, metadata present).
7. No broken doc links in README.md, AGENTS.md, or source comments (grep for
   `docs/` references and verify each target exists).
