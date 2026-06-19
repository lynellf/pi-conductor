# Phase 7C — Packaging, Distribution, Docs

> Sub-plan of `docs/extension-pivot-plan.md`. Read the pivot plan first for
> scope, authority relationship, risks, out-of-scope items, and whole-plan
> verification. Source docs: `docs/orchestrator-fsm-plan.md`,
> `docs/orchestrator-fsm-spec.md`, and `docs/sdk-surface.md`. Extension shell
> prerequisite: Phase 7B.
>
> **Status:** Tasks 7C.1–7C.4 complete. 432/432 tests green; `typecheck` /
> `build` / `lint` / `format:check` clean. Phase 7C code-complete pending human
> review.
>
> | Task | Description                                                  | Feat commit | Doc commit  |
> | ---- | ------------------------------------------------------------ | ----------- | ----------- |
> | 7C.1 | Package metadata + typebox identity swap                     | `d6562e7`   | this commit |
> | 7C.2 | Local install proof + extension helpers relocate + package-metadata guard | `d3fe553`   | this commit |
> | 7C.3 | `bin/conduct` CLI fallback                                   | `b19907b`   | this commit |
> | 7C.4 | Docs pivot (README / AGENTS / FSM plan §9.5 / extension-usage) | `8e7fbfc` | this commit |
>
> The relocated Phase 7A.5 real-model smoke was captured during 7C.2:
> `9341c3a` (transcript at
> `docs/dev-run-transcripts/2026-06-19-cli-real-model-smoke.md`).
>
> **Scope:** Package `pi-conductor` as a pi package, prove local installation,
> add a CLI fallback, and update user-facing docs to match the extension
> framing. This phase still does not publish to npm.

## Gate

- [x] Phase 7B complete and human-reviewed.
- [x] The extension loads from the source checkout before packaging work starts.
- [x] Runtime dependency changes are reviewed against `pi install` behavior.

## Tasks

- [x] **Task 7C.1: Package metadata + runtime dependency audit** — feat
      `d6562e7`, doc this commit
  - Description: Update `package.json` for pi package discovery:
    `"pi": { "extensions": ["./extensions"] }` and `"keywords":
    ["pi-package"]`. Move pi-bundled packages to `peerDependencies` only after
    verifying the available-imports name for TypeBox. Audit runtime imports so
    anything needed after `npm install --omit=dev` is not left in
    `devDependencies`.
  - Acceptance:
    - [x] `package.json` declares the extension path and `pi-package` keyword.
    - [x] `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and the
          TypeBox package name pi exposes are peer dependencies with the chosen
          range documented in the commit/PR.
    - [x] No runtime import used by `extensions/conduct.ts` or `src/host` is
          present only in `devDependencies`, except pi-bundled peers.
    - [x] `pnpm-lock.yaml` remains committed and consistent.
  - Verification:
    - [x] `pnpm install --lockfile-only`
    - [x] `pnpm typecheck && pnpm build && pnpm test` (412/412 after typebox swap)
  - Dependencies: Phase 7B
  - Files touched:
    - `package.json` (added `pi.extensions` + `pi-package` keyword + `bin` field;
      moved three pi-bundled packages to `peerDependencies` with `*` range;
      added `extensions/` to `files`)
    - `pnpm-lock.yaml` (consistent)
    - `src/seam/schema.ts` (typed comment + import swap)
    - `src/seam/validate-emission.ts` (import swap)
    - `src/host/tools.ts` (import swap)
    - `tests/host/seal.test.ts` (import swap)
    - `tests/seam/validate-emission.test.ts` (import swap)
  - Notes on typebox identity swap (added scope beyond the plan):
    - The pivot plan §4 calls out the typebox identity mismatch risk
      (extension's typebox ≠ host's). The host was using
      `@sinclair/typebox@^0.34.49` (the old name for the same package);
      pi bundles `typebox@1.1.38` (the renamed successor). Swapping
      `@sinclair/typebox` → `typebox` across the host, seam, and tests
      closes the identity gap so the seam's `handoff`/`end` schemas
      are validated by pi against the same TypeBox instance. The
      `typebox` API surface (`Type`, `Static`, `TSchema`, `Value.Check`)
      is identical between the two package names. Reversible in a
      single commit if needed.
  - Estimated scope: M

- [x] **Task 7C.2: Local install proof + CI guard** — feat `d3fe553`, doc this commit
  - Description: Prove the package installs through the same local-path flow a
    user will run. Add a CI or scripted guard that installs from a clean checkout
    into a temp pi environment and asserts the extension loads. **This is also
    the home of the relocated 7A.5 real-model smoke** — it is the first phase
    with an installable launch surface (`pi install ./` + `/conduct`), so the
    manual transcript is captured here.
  - Acceptance:
    - [x] Manual `pi install -l ./` on a clean checkout succeeds.
    - [x] `pi list` shows the package.
    - [x] `/conduct` is available after install. (The in-process extension
          harness from Phase 7B proves the factory registers the command;
          the manual install proof shows pi loads the extension without
          errors — `pi --print "say hi"` runs cleanly with the conductor
          installed project-locally.)
    - [x] A scripted guard (`tests/package-metadata.test.ts`, 11 cases)
          exercises local install metadata: extension path declared,
          `pi-package` keyword, three pi-bundled packages as peer
          dependencies with `*` range and NOT re-bundled, extension
          entrypoint exports a default function, no bare-specifier
          import in `extensions/conduct.ts` or `src/host/index.ts`
          resolves only to devDependencies (the runtime-import-in-
          devDep class of bug that would break `npm install --omit=dev`).
    - [x] **Relocated from 7A.5:** A real-model run against the developer's
          pi auth/config reaches a terminal state: orchestrator → worker →
          orchestrator → end. Captured in
          `docs/dev-run-transcripts/2026-06-19-cli-real-model-smoke.md`.
    - [x] **Relocated from 7A.5:** The manual transcript is committed under
          `docs/dev-run-transcripts/` and contains no API keys or provider
          secrets.
  - Verification:
    - [x] Manual: `pi install -l ./ && pi list` (both succeeded)
    - [x] Automated/scripted install check: `tests/package-metadata.test.ts`
    - [x] Manual: real-model transcript recorded (7C.2 doc commit `9341c3a`)
    - [x] `pnpm lint && pnpm format:check` (clean)
  - Dependencies: Task 7C.1
  - Files touched:
    - `extensions/conduct.ts` (import path updates)
    - `extensions/{active-run,manifest,status}.ts` → moved to
      `src/extension/` (git mv preserves history)
    - `extensions/commands/{start,resume,list,abort}.ts` → moved to
      `src/extension/commands/` (git mv preserves history)
    - `tests/extension/*.test.ts` (import path updates for the move)
    - `tests/package-metadata.test.ts` (new, 11 cases)
    - `.gitignore` (added `.pi/settings.json` so `pi install -l` does
      not pollute the repo)
    - `docs/dev-run-transcripts/2026-06-19-cli-real-model-smoke.md` (new,
      captured smoke)
    - `docs/dev-run-transcripts/README.md` (status updated)
  - Notes on the extension-helpers relocation (added scope beyond the plan):
    - pi's `extensions/` directory scan treats every `.ts` file as an
      extension entrypoint (each must export a default factory
      function). Our helpers (`active-run.ts`, `manifest.ts`,
      `status.ts`, `commands/*.ts`) are NOT entrypoints; pi failed to
      load them with `Extension does not export a valid factory
      function`. The fix is structural: helpers live under
      `src/extension/` (alongside `src/host/`, which has the same
      posture — may import pi, not scanned by the grep guard); only
      the entrypoint (`extensions/conduct.ts`) lives under
      `extensions/`. The convention matches what pi packages ship.
      This was discovered during the install proof and fixed in the
      same task.
  - Estimated scope: M

- [x] **Task 7C.3: Optional CLI fallback** — feat `b19907b`, doc this commit
  - Description: Add a thin `bin/conduct.ts` fallback that calls `startRun` with
    the production host factory built from a fresh `ModelRegistry.create()`.
    This is not the primary surface; it exists to exercise the production host
    without TUI wiring and to support non-pi consumers. If v1 scope is tight,
    explicitly defer this task in the plan instead of partially implementing it.
  - Acceptance:
    - [x] CLI implemented and exposed through package metadata (`bin` field
          in `package.json` → `./dist/bin/conduct.js`; `exports['./bin/conduct']`
          for direct import).
    - [x] CLI accepts `conduct <manifestPath> <goal...>`.
    - [x] CLI exits non-zero with a typed message on missing manifest, missing
          model, or missing prompt (exit codes 1/2/3 documented; tested in
          `tests/bin/conduct.test.ts`).
    - [x] Manual real-model run reaches a terminal state when implemented.
          Captured in `docs/dev-run-transcripts/2026-06-19-cli-real-model-smoke.md`.
  - Verification:
    - [x] `pnpm test -- bin/conduct` (9 cases, all green)
    - [x] Manual: `node dist/bin/conduct.js (no args)` → exit 2 + Usage
    - [x] Manual: `node dist/bin/conduct.js /nonexistent "goal"` → exit 3
    - [x] Manual: real-model smoke (see transcript) reached terminal state
    - [x] `pnpm typecheck && pnpm build`
  - Dependencies: Task 7C.1
  - Files touched:
    - `src/bin/conduct.ts` (new, 162 LOC including shebang + entrypoint guard)
    - `package.json` (`bin` field + `exports['./bin/conduct']`)
    - `tests/bin/conduct.test.ts` (new, 9 cases)
  - Implementation notes:
    - `runCli(argv, deps)` is exported with injectable deps (`startRun`,
      `modelRegistry`, `console`, `exit`, `cwd`). The auto-execution
      at the bottom of `src/bin/conduct.ts` is guarded by an
      `import.meta.url === process.argv[1]` check so tests can import
      the module without triggering the entrypoint.
    - The `dist/bin/conduct.js` artifact is built by `pnpm build` and
      ships in the npm tarball via `files: ['dist', 'extensions']`.
    - Model resolution uses `ModelRegistry.create(AuthStorage.create())`
      — a fresh registry, no shared state with pi's session. This is
      the correct posture for a standalone CLI; library consumers
      (the extension, advanced users) inject their own registry.
  - Estimated scope: M

- [x] **Task 7C.4: Docs pivot** — feat `8e7fbfc`, doc this commit
  - Description: Update public docs to lead with the extension shape while
    preserving the architecture boundary: the SDK host is the engine; the pi
    extension is the shell. Clarify that §9.5 is not reversed and role sessions
    stay outside pi's session tree.
  - Acceptance:
    - [x] `README.md` starts from "pi-conductor is a pi extension for
          multi-role LLM orchestration" and documents `pi install`, `/conduct`,
          manifest declaration, role prompt files, status surface, and advanced
          library use.
    - [x] `docs/orchestrator-fsm-plan.md` §9.5 has a clarification paragraph,
          not a behavioral rewrite.
    - [x] `AGENTS.md` repo layout and current status include `extensions/` and
          the pivot status.
    - [x] `docs/extension-usage.md` documents `/conduct`, resume/list/abort,
          manifest path resolution, and the caveat that worker role sessions
          are independent SDK sessions, not `/switch` targets.
  - Verification:
    - [x] `rg -n "not a pi extension|Extension Pivot|/conduct|extensions/"`
          (returns many extension-`/conduct` hits across the new docs;
          no "not a pi extension" framing remains in README.md)
    - [x] `pnpm lint && pnpm format:check` (clean)
  - Dependencies: Tasks 7C.1 and 7C.2; Task 7C.3 if implemented
  - Files touched:
    - `README.md` (rewrite: extension-first framing; 320 LOC)
    - `docs/orchestrator-fsm-plan.md` (§9.5 Open-Question item 5
      clarification; 5-paragraph addition, no behavioral rewrite)
    - `AGENTS.md` (current status block; two new invariants;
      repo-layout update)
    - `docs/extension-usage.md` (new, 167 LOC)
  - Estimated scope: M

## Checkpoint 7C — Extension Pivot Complete

- [x] All non-deferred Phase 7C tasks complete (7C.1–7C.4 all checked).
- [x] `pi install -l ./` local-path install loads the extension.
- [x] `/conduct` is available after install (in-process harness from 7B +
      manual `pi --print` install proof).
- [x] Runtime dependency audit is complete (`tests/package-metadata.test.ts`).
- [x] README, AGENTS, main FSM plan, and usage docs match the extension framing.
- [x] `pnpm typecheck && pnpm build && pnpm test && pnpm lint && pnpm format:check`
      green (432/432 tests, 43 files lint-clean).
- [ ] **Human review; v1 extension pivot ready for user testing.**
