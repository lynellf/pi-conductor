# Phase 1 — Foundation: types, manifest, uniform table

> Sub-plan of `docs/orchestrator-fsm-plan.md`. Read the main plan first for Overview,
> Architecture Decisions, Risks, Open Questions, and whole-plan Verification. Source
> spec: `docs/orchestrator-fsm-spec.md` (§5/§7/§8/§11/§12/§13).
>
> **Scope:** Pure types + manifest parse/validate + `MachineDefinition` derivation.
> Zero pi imports anywhere in `src/`.

## Tasks

- [ ] **Task 1: Project scaffold + TS/Vitest tooling**
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

- [ ] **Task 2: Core domain types (zero logic)**
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

- [ ] **Task 3: Manifest types + loader (YAML)**
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

- [ ] **Task 4: Manifest static checks + `MachineDefinition` derivation (§13, §12)**
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
- [ ] `pnpm typecheck && pnpm build && pnpm test` all green
- [ ] A manifest (`.pi/conductor.yaml`) can be parsed and validated against every
      §13 rule, and a `MachineDefinition` derived from it
- [ ] No pi imports in `src/core` or `src/manifest` (grep guard test)
- [ ] Review with human before reducer work
