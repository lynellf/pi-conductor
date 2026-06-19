# Phase 1 — Foundation: types, manifest, uniform table

> Sub-plan of `docs/orchestrator-fsm-plan.md`. Read the main plan first for
> Overview, Architecture Decisions, Risks, Open Questions, and whole-plan
> Verification. Source spec: `docs/orchestrator-fsm-spec.md`
> (§5/§7/§8/§11/§12/§13).
>
> **Scope:** Pure types + manifest parse/validate + `MachineDefinition`
> derivation. Zero pi imports anywhere in `src/`.

## Status & Verification Log

Last reviewed 2026-06-18 by an agent audit against the working tree + git
history (commits `d87db12` → `6fda6d9`). All four tasks are implemented,
committed, and green.

Verification re-run at this review
(`pnpm typecheck && pnpm build && pnpm test && pnpm lint && pnpm format:check`):
all clean. `pnpm test` = 28/28 across 5 files (`smoke`, `grep-guard`,
`core/types`, `manifest/parse`, `manifest/validate`). `pnpm audit` run
2026-06-19 — 1 low advisory accepted (see Feedback #5).

| Task                                         | State                                              | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 scaffold + tooling                         | ✅ Done & committed (`d87db12`)                    | `package.json`, `tsconfig.json`/`tsconfig.test.json` (strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax` + `NodeNext`), `vitest.config.ts`, `biome.json`, `lefthook.yml`, `pnpm-workspace.yaml` (supply-chain hardening: `minimumReleaseAge: 10080`, `strictDepBuilds: true`, `onlyBuiltDependencies: [esbuild, lefthook]`), `pnpm-lock.yaml`, `src/index.ts`, `tests/smoke.test.ts`, `tests/grep-guard.test.ts`.                                                                                                                                                                                       |
| 2 core domain types                          | ✅ Done & committed (`4f8d1f6`)                    | `src/core/types.ts` exports `Role`, `State = Role \| "done"`, `MachineDefinition`, `MachineEvent` (with `payload: unknown`), `Checkpoint`, `TransitionAccepted`/`TransitionRejected`/`TransitionResult`, `SessionLifecycleEvent`, `ModelFallback`, `RejectReason`, `PayloadSummary`, `UsageRecord`, `Effect`, `LegalTargets`, `ActiveRoleSession`, and a `createInitialCheckpoint(def)` _signature_ (`declare function`). `reduce`/`reduceLifecycle` signatures carry the `def: MachineDefinition` param + `meta.role === current_role` assertion contract. Snapshot pin: `tests/core/types.test.ts` (3 tests). Re-exported from `src/index.ts`. |
| 3 manifest types + YAML loader               | ✅ Done & committed (`0a3c53b`)                    | `src/manifest/types.ts` (`Manifest`, `RoleConfig`, `ManifestParseError`), `src/manifest/parse.ts` (`parseManifest` + `parseManifestFromObject`, frozen results, typed `Error.cause`). Committed fixture `.pi/conductor.yaml` mirrors the §8 example. Tests: `tests/manifest/parse.test.ts` (3 tests: valid parse + malformed YAML + missing `roles[]`).                                                                                                                                                                                                                                                                                          |
| 4 `validateManifest` + `toMachineDefinition` | ✅ Done & committed (`6fda6d9`)                    | `src/manifest/validate.ts` (5 hard error codes + 2 soft warning codes), `src/manifest/definition.ts` (`toMachineDefinition` re-validates, throws on hard errors, `Object.freeze` on top level + `workers` + `max_visits`). Table-driven: `tests/manifest/validate.test.ts` (17 tests) covering every §13 bullet + frozen-snapshot + throw-on-hard-error.                                                                                                                                                                                                                                                                                         |
| Checkpoint A                                 | 🟡 Automated gates green; **human review pending** | All automated gates pass non-vacuously. Grep guard now scans real `src/core` + `src/manifest` files. Only the human-review gate remains.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### Feedback & notes for Phase 2 (not blockers; record for traceability)

These came out of the 2026-06-18 audit. None block Phase 2 once the human-review
gate passes; they are recorded so the next implementer isn't blindsided and so
the spec/code drift is visible.

1. **§13 `version:`-integer check lives in the parser, not the validator.** §13
   lists "A top-level `version:` integer is present (§10). Hard reject if
   missing." as a load-time check. It is enforced in `parseManifest` (throws
   `ManifestParseError`), not in `validateManifest`. Functionally equivalent
   (load-time, blocks derivation), and the layering is defensible — parse owns
   shape, validate owns semantics — but the §13 attribution is split across two
   modules. No action required unless the team wants a `ManifestReport` error
   code for it for uniform surfacing.
2. **§13 cheaper-fallback rule is structural, not semantic.**
   `no-cheaper-fallback` fires when `models.length < 2`. Spec §13 phrasing is
   "at least one model cheaper than the primary." `validateManifest` has no
   price data, so it approximates with "≥2 entries." A 2-entry list whose second
   model is _more_ expensive would not warn. This is a known approximation;
   either (a) refine in the host (Phase 4) using cost data, or (b) amend §13 to
   acknowledge the structural proxy. Pick one before Phase 4.
3. **§13 `done`-reachable/terminal and `end`-legal-from-orchestrator checks are
   not implemented as explicit code.** Both are structurally guaranteed by the
   FSM table (§7.2: orchestrator `end`→`done`; `done` terminal; no manifest can
   violate either). Task 4's description listed "done reachable/terminal sanity"
   — this is the recorded justification for the omission, not an oversight. If a
   future manifest feature could break the guarantee (e.g. custom terminal
   states), revisit then.
4. **Two codes were added beyond the Task-4 description's enumerated list:**
   `bare-model-alias` (hard, §8.1 `provider:id` form) and
   `missing-required-tool` (soft, §8.1 `handoff`/`end` in `tools:`). Both
   correctly implement §13 bullets the task description didn't spell out. Net
   positive for coverage; noted here so the test count (17, not the ~10 the
   original description implied) isn't a surprise.
5. **`pnpm audit` run 2026-06-19: 1 low advisory, accepted.** The only finding
   is `esbuild@0.27.7` (GHSA-g7r4-m6w7-qqqr — arbitrary file read in the dev
   server on Windows), a transitive dev-only dep via `vitest>vite>esbuild`. It
   is low-severity, dev-only, and Windows-only; our runtime never runs the
   esbuild dev server. The fix requires vitest 4.x (→ vite 8 → esbuild ≥0.28.1),
   but vitest 4.1.9 was published 2026-06-15 — only 4 days ago — so our own
   `minimumReleaseAge: 10080` (7-day) supply-chain rule (`pnpm-workspace.yaml`)
   forbids the upgrade until 2026-06-22. Per the AGENTS.md gate ("no
   high/critical advisories unaddressed"), zero high/critical are present, so
   Checkpoint A's audit gate is satisfied. Re-audit after 2026-06-22 and bump
   vitest→4 once eligible; track as a Phase-2 housekeeping item, not a Phase-1
   blocker.
6. **AGENTS.md "Current status" section is stale.** It reads "Task 1 (scaffold +
   pnpm supply-chain hardening) landed. Tasks 2–4 (core types, manifest
   parse/validate/ derive) next." All four are now landed. One-line update
   needed (separate from this doc) so the repo's entry point doesn't contradict
   history.

### Notes for the next implementer

- The grep guard (`tests/grep-guard.test.ts`) is now **non-vacuous**: `src/core`
  and `src/manifest` both contain `.ts` files and are scanned.
  `src/seam`/`src/cost` still don't exist (the `try/catch` returns `[]`), so
  those two assertions remain vacuous until Phase 3. Don't read the green guard
  as "seam/cost invariant proven" yet.
- `tsconfig.json` `rootDir` is `./src`; `tsconfig.test.json` overrides
  `rootDir: "."` so tests type-check too (`pnpm typecheck` uses it). Keep that
  split when adding test files in Phase 2.
- `src/index.ts` re-exports the Phase-1 public surface (types +
  `parseManifest` + `validateManifest` + `toMachineDefinition` +
  `ManifestParseError`). The reducer signatures (`reduce`, `reduceLifecycle`,
  `createInitialCheckpoint`) are currently `declare function` in
  `src/core/types.ts` with no runtime; Phase 2 Task 6 will give them
  implementations and the barrel will re-export the runtime values.
- `toMachineDefinition` re-runs `validateManifest` internally and throws on hard
  errors ("no silent fallbacks"). Phase 2 reducer code can assume any `def` it
  receives is already validated + frozen.

## Tasks

- [x] **Task 1: Project scaffold + TS/Vitest tooling** _(committed `d87db12`)_
  - Description: Greenfield repo → a buildable, testable TS package.
    `package.json`, `tsconfig.json` (strict), Vitest config, `src/` + `tests/`
    layout, lint/format. One trivial failing→passing test to prove the loop.
  - Acceptance: `pnpm build` emits JS; `pnpm test` runs and passes 1 sample
    test; `pnpm typecheck` clean. No pi imports anywhere in `src/`.
  - Verification: `pnpm typecheck && pnpm build && pnpm test`
  - Dependencies: None
  - Files: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`,
    `tests/smoke.test.ts`
  - Scope: S

- [x] **Task 2: Core domain types (zero logic)** _(committed `4f8d1f6`)_
  - Description: Encode §5/§7/§11/§12 types as TS: `Role`,
    `State = Role | "done"`, `MachineDefinition` (pinned manifest snapshot:
    `manifest_version`, `orchestrator`, `workers`, `max_visits`), `MachineEvent`
    (its `handoff`/`end` payload shapes are `unknown` at the reducer level — see
    §12 note; the _typed_ payload is a host/seam concern, not a reducer input,
    so no forward dependency on Task 9), `Checkpoint`, `TransitionAccepted`
    (incl. the §11.2 `payload_summary` shape), `TransitionRejected`,
    `SessionLifecycleEvent`, `ModelFallback`, `RejectReason` union. Also export
    `createInitialCheckpoint(def): Checkpoint` (§12) as a type + signature here;
    the implementation lands in Task 6. Pure types, no runtime.
  - Acceptance: Every record shape in §11.1–§11.5 has a matching exported type.
    `TransitionResult` discriminant matches §12 exactly, including the `def`
    param on `reduce`/`reduceLifecycle`, the `meta.role === current_role`
    assertion contract (§12), and `createInitialCheckpoint`. No `any`.
    `MachineEvent.payload` is `unknown`.
  - Verification: `pnpm typecheck`; a snapshot test asserting the public type
    surface.
  - Dependencies: Task 1
  - Files: `src/core/types.ts`, `src/index.ts`
  - Scope: S

- [x] **Task 3: Manifest types + loader (YAML)** _(committed `0a3c53b`)_
  - Description: Encode §8 manifest as a typed shape (`RoleConfig`, `Manifest`)
    and a `parseManifest(rawYaml): Manifest` that reads the `roles[]` structure
    from the `.pi/conductor.yaml` source (§8 resolved: single YAML file, not
    JSON, not per-role frontmatter). No validation yet beyond parsing. Support
    `is_orchestrator`, `max_visits`, `models`, `max_session_cost_usd`,
    `max_run_cost_usd`, `system_prompt`, `tools`.
  - Acceptance: Parses the §8 example manifest; rejects malformed YAML with a
    typed error. `max_run_cost_usd` parses only when present on a role
    (placement checked in Task 4, not here).
  - Verification: Unit tests for valid parse + 2 malformed cases (bad YAML
    syntax; missing `roles[]`).
  - Dependencies: Task 2
  - Files: `src/manifest/types.ts`, `src/manifest/parse.ts`,
    `tests/manifest/parse.test.ts`
  - Scope: S

- [x] **Task 4: Manifest static checks + `MachineDefinition` derivation (§13,
      §12)** _(committed `6fda6d9`)_
  - Description: `validateManifest(m: Manifest): ManifestReport` implementing
    every §13 rule: exactly one orchestrator; every worker declared + finite
    `max_visits` (hard reject uncapped); `max_run_cost_usd` only on orchestrator
    (hard reject on worker); soft warning when `max_session_cost_usd` present
    without a cheaper fallback model; `done` reachable/terminal sanity. Return
    hard errors vs soft warnings distinctly. Also export
    `toMachineDefinition(m: Manifest):
    MachineDefinition` — the pinned,
    immutable snapshot the reducers consume — derived only from a manifest that
    passed `validateManifest`.
  - Acceptance: Each §13 bullet has a passing + failing test. Uncapped worker →
    hard reject. `max_run_cost_usd` on a worker → hard reject. Missing
    orchestrator → hard reject. Cheaper-fallback rule is a warning only.
    `toMachineDefinition` produces a frozen object whose `workers`/`max_visits`
    match the manifest.
  - Verification: `pnpm test -- manifest`; table-driven cases enumerated from
    §13.
  - Dependencies: Task 3
  - Files: `src/manifest/validate.ts`, `src/manifest/definition.ts`,
    `tests/manifest/validate.test.ts`
  - Scope: M

## Checkpoint A — foundation verified

- [x] `pnpm typecheck && pnpm build && pnpm test` all green _(28/28; re-run
      after Tasks 2–4, non-vacuous)_
- [x] `pnpm lint` + `pnpm format:check` clean
- [x] A manifest (`.pi/conductor.yaml`) can be parsed and validated against
      every §13 rule, and a `MachineDefinition` derived from it _(fixture
      committed; 17 table-driven cases)_
- [x] No pi imports in `src/core` or `src/manifest` (grep guard test)
      _(non-vacuous: both dirs now contain .ts files)_
- [x] `pnpm audit` — no high/critical advisories unaddressed _(1 low,
      dev-only/Windows-only esbuild advisory accepted; see Feedback #5)_
- [x] Review with human before reducer work
