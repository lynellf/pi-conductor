# Phase 1 — Foundation: types, manifest, uniform table

> Sub-plan of `docs/orchestrator-fsm-plan.md`. Read the main plan first for Overview,
> Architecture Decisions, Risks, Open Questions, and whole-plan Verification. Source
> spec: `docs/orchestrator-fsm-spec.md` (§5/§7/§8/§11/§12/§13).
>
> **Scope:** Pure types + manifest parse/validate + `MachineDefinition` derivation.
> Zero pi imports anywhere in `src/`.

## Status & Verification Log

Last reviewed 2026-06-18 by an agent audit against the working tree + git history.

| Task | State | Evidence |
| ---- | ---- | -------- |
| 1 scaffold + tooling | ✅ Done **in working tree only — not committed** | `pnpm typecheck`, `pnpm build`, `pnpm test` (5/5), `pnpm lint`, `pnpm format:check` all green. Files: `package.json`, `tsconfig.json`/`tsconfig.test.json` (strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax` + `NodeNext`), `vitest.config.ts`, `biome.json`, `lefthook.yml`, `pnpm-workspace.yaml` (supply-chain hardening: `minimumReleaseAge: 10080`, `strictDepBuilds: true`, `onlyBuiltDependencies: [esbuild, lefthook]`), `pnpm-lock.yaml`, `src/index.ts` stub, `tests/smoke.test.ts`, `tests/grep-guard.test.ts`. |
| 2 core domain types | ❌ Not started | `src/core/` does not exist. `src/index.ts` exports only `PACKAGE_NAME`. No `Role`/`State`/`MachineDefinition`/`MachineEvent`/`Checkpoint`/`Transition*`/`SessionLifecycleEvent`/`ModelFallback`/`RejectReason` types; no `createInitialCheckpoint` signature. |
| 3 manifest types + YAML loader | ❌ Not started | `src/manifest/` does not exist. `yaml@^2.6.0` is present as a devDependency (prep only). No `.pi/conductor.yaml` fixture; Checkpoint A requires one. |
| 4 `validateManifest` + `toMachineDefinition` | ❌ Not started | No `src/manifest/validate.ts` or `definition.ts`. No §13 table-driven tests. |
| Checkpoint A | ❌ Not met | No manifest parse/validate/derive; no human review gate passed. |

### Remediation (in order, before Phase 2)

1. **Commit Task 1 before anything else.** `git ls-files src tests package.json` is empty; `git status` shows every scaffold file as `??`. The four existing commits are docs-only. Until the scaffold is in history it is not reproducible from a fresh clone, and the Lefthook pre-push hook (installed by `lefthook`'s postinstall on `pnpm install`, allowlisted under `strictDepBuilds`) has nothing to guard. Follow `git-workflow-and-versioning`: one atomic commit for scaffold + supply-chain hardening. Also correct AGENTS.md's "Current status" line — it says this work has "landed"; as of git history it has not.
2. **Task 2 — `src/core/types.ts`.** Encode §5.1/§5.2 events, §7.1–§7.2 `State = Role | "done"` + transition shapes, §11.1–§11.5 record types incl. the §11.2 `payload_summary` shape, §12 `TransitionResult` discriminant with the `def: MachineDefinition` param on `reduce`/`reduceLifecycle` and the `meta.role === current_role` assertion contract, `ModelFallback`/`RejectReason`, and a `createInitialCheckpoint(def): Checkpoint` *signature* (impl lands in Phase 2 / Task 6). `MachineEvent.payload` MUST be `unknown` (reducer never branches on payload — §3/§12). No `any`. Add a snapshot test pinning the public type surface (`tests/core/types.test.ts`). Update `src/index.ts` to re-export.
3. **Task 3 — `src/manifest/types.ts` + `parse.ts`.** `parseManifest(rawYaml): Manifest` over `.pi/conductor.yaml` per §8 (single YAML, resolved). Support `is_orchestrator`, `max_visits`, `models`, `max_session_cost_usd`, `max_run_cost_usd`, `system_prompt`, `tools`. Typed error for malformed YAML and missing `roles[]`. Add a committed `.pi/conductor.yaml` fixture matching the §8 example (Checkpoint A's "a manifest can be parsed" clause needs a real file). `tests/manifest/parse.test.ts`: valid parse + 2 malformed cases.
4. **Task 4 — `src/manifest/validate.ts` + `definition.ts`.** `validateManifest` implements every §13 bullet distinctly as hard error vs soft warning: exactly one orchestrator (hard); every worker declared + finite `max_visits`, uncapped → hard reject; `max_run_cost_usd` only on orchestrator, on a worker → hard reject; missing cheaper fallback when `max_session_cost_usd` present → **warning only**; `done` reachable/terminal sanity. `toMachineDefinition(m)` derives the pinned, frozen snapshot (`Object.freeze` on `workers`/`orchestrator`/`max_visits`/`manifest_version`) and MUST only be called from a manifest that passed `validateManifest` (throw otherwise — no silent fallback, per code conventions). `tests/manifest/validate.test.ts` table-driven from §13, one assertion per case.
5. **Re-run Checkpoint A gates:** `pnpm typecheck && pnpm build && pnpm test` (grep-guard now non-vacuous once `src/core` + `src/manifest` exist), then human review, before opening Phase 2.

### Notes for the next implementer

- The grep guard (`tests/grep-guard.test.ts`) is already in place and passing, but **vacuously**: `src/core`/`src/manifest`/`src/seam`/`src/cost` don't exist yet so `listTs` returns `[]`. That is intended (`try/catch` on missing dirs). The guard becomes meaningful only after Tasks 2–4 populate `src/core` and `src/manifest`. Do not read the current green grep-guard as "invariant proven."
- `tsconfig.json` `rootDir` is `./src`; `tsconfig.test.json` overrides `rootDir: "."` so tests type-check too (`pnpm typecheck` uses it). Keep that split when adding test files.
- `dist/` is currently gitignored-by-convention (not in `git status` untracked list, meaning `.gitignore` covers it) — confirm before committing Task 1.

## Tasks

- [x] **Task 1: Project scaffold + TS/Vitest tooling** *(done in working tree — see Status; **not yet committed to git**, remediation step 1)*
  - Description: Greenfield repo → a buildable, testable TS package. `package.json`,
    `tsconfig.json` (strict), Vitest config, `src/` + `tests/` layout, lint/format.
    One trivial failing→passing test to prove the loop.
  - Acceptance: `pnpm build` emits JS; `pnpm test` runs and passes 1 sample test;
    `pnpm typecheck` clean. No pi imports anywhere in `src/`.
  - Verification: `pnpm typecheck && pnpm build && pnpm test`
  - Dependencies: None
  - Files: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`,
    `tests/smoke.test.ts`
  - Scope: S

- [ ] **Task 2: Core domain types (zero logic)** *(not started)*
  - Description: Encode §5/§7/§11/§12 types as TS: `Role`, `State = Role | "done"`,
    `MachineDefinition` (pinned manifest snapshot: `manifest_version`, `orchestrator`,
    `workers`, `max_visits`), `MachineEvent` (its `handoff`/`end` payload shapes are
    `unknown` at the reducer level — see §12 note; the *typed* payload is a host/seam
    concern, not a reducer input, so no forward dependency on Task 9), `Checkpoint`,
    `TransitionAccepted` (incl. the §11.2 `payload_summary` shape),
    `TransitionRejected`, `SessionLifecycleEvent`, `ModelFallback`, `RejectReason`
    union. Also export `createInitialCheckpoint(def): Checkpoint` (§12) as a type +
    signature here; the implementation lands in Task 6. Pure types, no runtime.
  - Acceptance: Every record shape in §11.1–§11.5 has a matching exported type.
    `TransitionResult` discriminant matches §12 exactly, including the `def` param on
    `reduce`/`reduceLifecycle`, the `meta.role === current_role` assertion contract
    (§12), and `createInitialCheckpoint`. No `any`. `MachineEvent.payload` is `unknown`.
  - Verification: `pnpm typecheck`; a snapshot test asserting the public type surface.
  - Dependencies: Task 1
  - Files: `src/core/types.ts`, `src/index.ts`
  - Scope: S

- [ ] **Task 3: Manifest types + loader (YAML)** *(not started)*
  - Description: Encode §8 manifest as a typed shape (`RoleConfig`, `Manifest`) and a
    `parseManifest(rawYaml): Manifest` that reads the `roles[]` structure from the
    `.pi/conductor.yaml` source (§8 resolved: single YAML file, not JSON, not
    per-role frontmatter). No validation yet beyond parsing. Support `is_orchestrator`,
    `max_visits`, `models`, `max_session_cost_usd`, `max_run_cost_usd`,
    `system_prompt`, `tools`.
  - Acceptance: Parses the §8 example manifest; rejects malformed YAML with a typed
    error. `max_run_cost_usd` parses only when present on a role (placement checked in
    Task 4, not here).
  - Verification: Unit tests for valid parse + 2 malformed cases (bad YAML syntax;
    missing `roles[]`).
  - Dependencies: Task 2
  - Files: `src/manifest/types.ts`, `src/manifest/parse.ts`,
    `tests/manifest/parse.test.ts`
  - Scope: S

- [ ] **Task 4: Manifest static checks + `MachineDefinition` derivation (§13, §12)** *(not started)*
  - Description: `validateManifest(m: Manifest): ManifestReport` implementing every
    §13 rule: exactly one orchestrator; every worker declared + finite `max_visits`
    (hard reject uncapped); `max_run_cost_usd` only on orchestrator (hard reject on
    worker); soft warning when `max_session_cost_usd` present without a cheaper
    fallback model; `done` reachable/terminal sanity. Return hard errors vs soft
    warnings distinctly. Also export `toMachineDefinition(m: Manifest):
    MachineDefinition` — the pinned, immutable snapshot the reducers consume — derived
    only from a manifest that passed `validateManifest`.
  - Acceptance: Each §13 bullet has a passing + failing test. Uncapped worker → hard
    reject. `max_run_cost_usd` on a worker → hard reject. Missing orchestrator → hard
    reject. Cheaper-fallback rule is a warning only. `toMachineDefinition` produces a
    frozen object whose `workers`/`max_visits` match the manifest.
  - Verification: `pnpm test -- manifest`; table-driven cases enumerated from §13.
  - Dependencies: Task 3
  - Files: `src/manifest/validate.ts`, `src/manifest/definition.ts`,
    `tests/manifest/validate.test.ts`
  - Scope: M

## Checkpoint A — foundation verified
- [x] `pnpm typecheck && pnpm build && pnpm test` all green *(as of Task 1 only; must re-run after Tasks 2–4)*
- [ ] A manifest (`.pi/conductor.yaml`) can be parsed and validated against every
      §13 rule, and a `MachineDefinition` derived from it *(blocked on Tasks 3–4)*
- [x] No pi imports in `src/core` or `src/manifest` (grep guard test) *(passing vacuously — dirs do not exist yet; non-vacuous after Tasks 2–4)*
- [ ] Review with human before reducer work
