# Phase 7C — Packaging, Distribution, Docs

> Sub-plan of `docs/extension-pivot-plan.md`. Read the pivot plan first for
> scope, authority relationship, risks, out-of-scope items, and whole-plan
> verification. Source docs: `docs/orchestrator-fsm-plan.md`,
> `docs/orchestrator-fsm-spec.md`, and `docs/sdk-surface.md`. Extension shell
> prerequisite: Phase 7B.
>
> **Status:** Draft — awaiting human review before any task starts.
>
> **Scope:** Package `pi-conductor` as a pi package, prove local installation,
> optionally add a CLI fallback, and update user-facing docs to match the
> extension framing. This phase still does not publish to npm.

## Gate

- [ ] Phase 7B complete and human-reviewed.
- [ ] The extension loads from the source checkout before packaging work starts.
- [ ] Runtime dependency changes are reviewed against `pi install` behavior.

## Tasks

- [ ] **Task 7C.1: Package metadata + runtime dependency audit**
  - Description: Update `package.json` for pi package discovery:
    `"pi": { "extensions": ["./extensions"] }` and `"keywords":
    ["pi-package"]`. Move pi-bundled packages to `peerDependencies` only after
    verifying the available-imports name for TypeBox. Audit runtime imports so
    anything needed after `npm install --omit=dev` is not left in
    `devDependencies`.
  - Acceptance:
    - [ ] `package.json` declares the extension path and `pi-package` keyword.
    - [ ] `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and the
          TypeBox package name pi exposes are peer dependencies with the chosen
          range documented in the commit/PR.
    - [ ] No runtime import used by `extensions/conduct.ts` or `src/host` is
          present only in `devDependencies`, except pi-bundled peers.
    - [ ] `pnpm-lock.yaml` remains committed and consistent.
  - Verification:
    - [ ] `pnpm install --lockfile-only`
    - [ ] `pnpm typecheck && pnpm build && pnpm test`
  - Dependencies: Phase 7B
  - Files likely touched:
    - `package.json`
    - `pnpm-lock.yaml`
  - Estimated scope: M

- [ ] **Task 7C.2: Local install proof + CI guard**
  - Description: Prove the package installs through the same local-path flow a
    user will run. Add a CI or scripted guard that installs from a clean checkout
    into a temp pi environment and asserts the extension loads. **This is also
    the home of the relocated 7A.5 real-model smoke** — it is the first phase
    with an installable launch surface (`pi install ./` + `/conduct`), so the
    manual transcript is captured here.
  - Acceptance:
    - [ ] Manual `pi install ./` on a clean checkout succeeds.
    - [ ] `pi list` shows the package.
    - [ ] `/conduct` is available after install.
    - [ ] A CI/scripted check exercises local install or documents a specific
          SDK limitation that keeps it manual for now.
    - [ ] **Relocated from 7A.5:** A real-model run against the developer's pi
          auth/config reaches a terminal state: orchestrator → worker →
          orchestrator → end.
    - [ ] **Relocated from 7A.5:** The manual transcript is committed under
          `docs/dev-run-transcripts/` and contains no API keys or provider
          secrets.
  - Verification:
    - [ ] Manual: `pi install ./ && pi list`
    - [ ] Automated/scripted install check if SDK supports it
    - [ ] Manual: real-model transcript recorded (see
          `docs/dev-run-transcripts/README.md` for the capture format; requires
          developer `~/.pi/agent/auth.json` with a working provider).
    - [ ] `pnpm lint && pnpm format:check`
  - Dependencies: Task 7C.1
  - Files likely touched:
    - `package.json`
    - `.github/workflows/*` or existing CI config
    - `scripts/*`
  - Estimated scope: M

- [ ] **Task 7C.3: Optional CLI fallback**
  - Description: Add a thin `bin/conduct.ts` fallback that calls `startRun` with
    the production host factory built from a fresh `ModelRegistry.create()`.
    This is not the primary surface; it exists to exercise the production host
    without TUI wiring and to support non-pi consumers. If v1 scope is tight,
    explicitly defer this task in the plan instead of partially implementing it.
  - Acceptance:
    - [ ] Either the CLI is implemented and exposed through package metadata, or
          this task is marked deferred with a short rationale.
    - [ ] Implemented CLI accepts `conduct <manifestPath> <goal...>`.
    - [ ] Implemented CLI exits non-zero with a typed message on missing
          manifest, missing model, or missing prompt.
    - [ ] Manual real-model run reaches a terminal state when implemented.
  - Verification:
    - [ ] `pnpm test -- bin/conduct` if implemented
    - [ ] Manual: `node dist/bin/conduct.js .pi/conductor.yaml "goal"` if
          implemented
    - [ ] `pnpm typecheck && pnpm build`
  - Dependencies: Task 7C.1
  - Files likely touched:
    - `bin/conduct.ts`
    - `package.json`
    - `tests/bin/conduct.test.ts`
  - Estimated scope: M

- [ ] **Task 7C.4: Docs pivot**
  - Description: Update public docs to lead with the extension shape while
    preserving the architecture boundary: the SDK host is the engine; the pi
    extension is the shell. Clarify that §9.5 is not reversed and role sessions
    stay outside pi's session tree.
  - Acceptance:
    - [ ] `README.md` starts from "pi-conductor is a pi extension for
          multi-role LLM orchestration" and documents `pi install`, `/conduct`,
          manifest declaration, role prompt files, status surface, and advanced
          library use.
    - [ ] `docs/orchestrator-fsm-plan.md` §9.5 has a clarification paragraph,
          not a behavioral rewrite.
    - [ ] `AGENTS.md` repo layout and current status include `extensions/` and
          the pivot status.
    - [ ] `docs/extension-usage.md` documents `/conduct`, resume/list/abort,
          manifest path resolution, and the caveat that worker role sessions
          are independent SDK sessions, not `/switch` targets.
  - Verification:
    - [ ] `rg -n "not a pi extension|Extension Pivot|/conduct|extensions/"`
    - [ ] `pnpm lint && pnpm format:check`
  - Dependencies: Tasks 7C.1 and 7C.2; Task 7C.3 if implemented
  - Files likely touched:
    - `README.md`
    - `docs/orchestrator-fsm-plan.md`
    - `AGENTS.md`
    - `docs/extension-usage.md`
  - Estimated scope: M

## Checkpoint 7C — Extension Pivot Complete

- [ ] All non-deferred Phase 7C tasks complete.
- [ ] `pi install ./` local-path install loads the extension.
- [ ] `/conduct` is available after install.
- [ ] Runtime dependency audit is complete.
- [ ] README, AGENTS, main FSM plan, and usage docs match the extension framing.
- [ ] `pnpm typecheck && pnpm build && pnpm test && pnpm lint && pnpm format:check`
      green.
- [ ] Human review; v1 extension pivot ready for user testing.
