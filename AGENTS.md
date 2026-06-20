# AGENTS.md

> **Read this before any work in the repo.**
>
> **Step 0 — load the `using-agent-skills` skill first.** Read it in full before
> touching anything. It defines the skill-discovery flow (which skill applies to
> which phase of work) and the **Core Operating Behaviors** that govern _all_
> work here: surface assumptions, manage confusion actively, push back when
> warranted, enforce simplicity, maintain scope discipline, verify (don't
> assume). Those behaviors are non-negotiable and are _not_ restated below —
> they apply on top of this file.
>
> After that, read the rest of this file, then the spec
> (`docs/orchestrator-fsm-spec.md`) and the current phase sub-plan
> (`docs/orchestrator-fsm-plans/phase-*.md`) before making changes. When a task
> matches a skill's phase (define → plan → build → verify → review → ship), load
> that skill and follow its steps in order, including its verification step —
> skills are workflows, not suggestions.
>
> Quick map for this repo: spec-driven-development (no spec yet) →
> planning-and-task-breakdown → incremental-implementation →
> test-driven-development → code-review-and-quality →
> git-workflow-and-versioning. High-stakes / unfamiliar core code →
> doubt-driven-development. UI/SDK host work → source-driven-development (verify
> against pinned SDK surfaces in `docs/sdk-surface.md`).

Guidance for any agent (human or LLM) working in this repo. Read this first; it
restates only what the spec/plan assume as standing context. Source of truth for
behavior is `docs/orchestrator-fsm-spec.md`; sequencing is in
`docs/orchestrator-fsm-plan.md` + `docs/orchestrator-fsm-plans/*`. Delivery plan
(shipping as a pi extension) is in `docs/extension-pivot-plan.md` +
`docs/extension-pivot-plans/*`.

## Current status (post-Phase 7C)

- **Phases 1–5 (pure core + stub-driven E2E):** complete, human-reviewed, 276 → 329 tests green.
- **Phase 7A (production `Host`):** complete, human-reviewed, 380 tests green. The 7A.5 real-model smoke was structurally deferred until Phase 7C landed the installable launch surface (relocated to Phase 7C Task 7C.2).
- **Phase 7B (extension shell):** complete, human-reviewed, 412 tests green. `/conduct`, `/conduct:resume`, `/conduct:list`, `/conduct:abort`, and `--conduct-manifest` are registered.
- **Phase 7C (packaging + CLI + docs):** complete; final review at loop close. `pi install ./` works, `bin/conduct` ships, README + `AGENTS.md` + main FSM plan + `docs/extension-usage.md` reflect the extension framing. 432 tests green; typecheck/build/lint/format:check clean.
- **Phase 7D (HOME-scoped manifest + prompt discovery):** complete; pending end-of-loop review. 514 tests green; typecheck/build/lint/format:check clean. Manifest resolution chain (flag → cwd → HOME) and v1/v2 back-compat prompt resolution implemented per the acknowledged spec delta (`docs/home-scoped-discovery-spec.md`). No core modules touched; grep guard green.

See `docs/extension-pivot-plan.md` for the pivot rationale (delivery-shape
change only; FSM spec §12 invariants untouched) and `docs/extension-usage.md`
for the user-facing surface.

## What this is

`pi-conductor` orchestrates multi-role LLM workflows on
[pi](https://github.com/earendil-works/pi-coding-agent) via a **guarded,
observable handoff state machine**. It ships as a pi extension exposing
`/conduct`, `/conduct:resume`, `/conduct:list`, and `/conduct:abort`
(`docs/extension-usage.md` walks through the surface end-to-end). Three
layers, kept strictly apart:

- **Pure core** (`src/core`, `src/manifest`, `src/seam`, `src/cost`,
  `src/persistence`): a deterministic FSM reducer + manifest static checks +
  TypeBox emission schemas + cost roll-up. Zero pi imports. Zero I/O.
- **SDK host driver** (`src/host`, Phase 4+): owns the orchestration loop,
  spawns role sessions via `createAgentSession`, persists records, enforces cost
  caps. The only place in the engine layer that imports `@earendil-works/pi-coding-agent`.
- **Extension UX shell** (`extensions/conduct.ts` + `src/extension/`): thin
  handlers that resolve the manifest, build a production `Host` via
  `createProductionHost`, and forward to `startRun` / `resumeRun` / `listRuns`
  / `RunHandle.abort`. The extension layer may import pi (same posture as
  `src/host/`); the grep guard does NOT scan `src/extension/` or
  `extensions/`. The shell does NOT call `ctx.newSession()` /
  `ctx.fork()` — a grep guard on `extensions/**/*.ts` rejects those calls.

The core is imported by the host; the host is never imported by the core.

## Non-negotiable invariants

These exist for concrete reasons (see spec/plan). Do not violate them without an
explicit decision recorded in `docs/`.

1. **Host-agnostic core.** `src/core`, `src/manifest`, `src/seam`, `src/cost`,
   `src/persistence` must not import `@earendil-works/pi-coding-agent` (or any
   pi runtime). Enforced by the grep-guard test (`tests/grep-guard.test.ts`) —
   it scans source as text so a TS error can never mask an illegal import.
   `src/host`, `src/extension`, and `extensions/` may import pi (they are the
   three layers that bridge to the SDK).
2. **Reducer purity.** `reduce` / `reduceLifecycle` are pure functions of
   `(checkpoint, event, def, meta)` (modulo `meta.ts`). No ambient config, no
   I/O. Role set + caps come only from the pinned `MachineDefinition` (`def`),
   never from imports or globals.
3. **`def` is the pinned manifest snapshot.**
   `MachineDefinition.manifest_version` is stamped at run-start and never
   mutated mid-run (spec §10/§12).
4. **Every state change goes through `reduce`.** Cost-cap forced-close
   synthesizes a machine `end` event fed to `reduce`; never mutate the
   checkpoint to `done` directly (spec §11.7).
5. **Checkpoint is snapshot-appended, never mutated in place.** Resume reads the
   latest snapshot from the host-owned `run_id`-keyed log (spec §11.1). SDK
   branch scoping is **not** used.
6. **Single owner for `reduce` + persistence + spawning.** The `handoff`/`end`
   tools only validate + record intent into a capture buffer and return a
   terminating message; they do **not** call `reduce` and do **not** persist
   (spec §12.1).
7. **`meta.role === checkpoint.current_role` is asserted** inside `reduce` (and
   the lifecycle identity checks in `reduceLifecycle`). A mismatch is
   rejected/thrown, not silently trusted (spec §12).
8. **`MachineEvent.payload` is `unknown`** at the reducer level. Shape
   validation lives at the seam (host). The reducer never branches on payload
   content (§3/§4).
9. **One schema, TypeBox.** `handoff`/`end` tool param schemas are TypeBox; the
   same schema is the seam contract and derives the TS type via `Static<>`. No
   Zod. The runtime `typebox` package (pi bundles `typebox@1.1.38`) is the
   peer-dependency declaration in `package.json`; do not swap back to
   `@sinclair/typebox` (different package, would break tool-arg validation
   at runtime — the seam and the SDK would use distinct TypeBox instances).
10. **No `ctx.newSession()` / `ctx.fork()` in `extensions/`.** Role sessions
    are spawned by the production `Host` via the standalone `createAgentSession`
    only. The grep guard on `extensions/**/*.ts` rejects `ctx.newSession(` and
    `ctx.fork(` substrings. This is the §9.5 boundary — putting role sessions
    in pi's session tree would break the host-owned `run_id`-keyed log (§11.1).
    The extension pivot plan §1 documents why this is a delivery-shape change
    only, not a re-architecture.

## Code conventions

- **TypeScript strict**, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, ESM + `NodeNext`. No
  `any`. No `// @ts-ignore` without a one-line justification.
- **Module size: hard ~400 LOC ceiling.** Any source file approaching ~400 lines
  is a signal to split by responsibility (not mid-function). If a split would
  break a coherent concept, state why in a comment at the top of the file and
  keep it under 500. Prefer many small, named, single-purpose modules over few
  large ones.
- **Linter/formatter: Biome** (`biome.json`, v2). `pnpm lint` = `biome check .`
  (lint + format check); `pnpm lint:fix` writes. `pnpm format` / `format:check`
  for formatting only. No ESLint/Prettier — Biome replaces both. The grep-guard
  test (not a lint rule) enforces the no-pi-imports invariant, since Biome has
  no `no-restricted-imports` equivalent.
- **Readability over cleverness.** Boring, obvious code wins. If a staff
  engineer would ask "why didn't you just…", rewrite it. No premature
  abstraction.
- **Pure functions first.** Side-effecting code belongs in `src/host` and is
  explicitly marked. Core modules are deterministic and unit-testable in
  isolation.
- **Named exports only** (no `export default`). Keeps refactor greps honest.
- **JSDoc on public exports** in `src/`: one line on intent + a spec-section
  pointer when the contract is non-obvious (e.g. `// spec §11.2`). Don't restate
  types.
- **No silent fallbacks.** Ambiguity → throw a typed error or surface a warning;
  never pick an interpretation and hope.
- **Tests are table-driven where the spec enumerates cases** (e.g. §7.3
  rejections, §13 manifest checks). One assertion per behavior; name the case.

## Supply chain (pnpm)

We use **pnpm** (matches the pi ecosystem). Project config lives in
**`pnpm-workspace.yaml`** — pnpm 10's canonical config file (`.npmrc` is the
legacy fallback). Keys are **camelCase** in the YAML (unlike `.npmrc`'s
kebab-case); verified against pnpm 10.33.1 source (`getOptionsFromPnpmSettings`
reads the keys directly off the parsed YAML). Hardening settings:

- `minimumReleaseAge: 10080` — only resolve versions published ≥ 7 days ago
  (unit is **minutes**: `opts.minimumReleaseAge * 60 * 1e3` in pnpm.cjs).
  Mitigates dependency-confusion and freshly-published malicious packages.
- `strictDepBuilds: true` — fail the install if any dep runs a build script not
  on `onlyBuiltDependencies`. Postinstall/build scripts are the primary
  execution surface; the allowlist must stay explicit. Never set
  `dangerouslyAllowAllBuilds`.
- `verifyDepsBeforeRun: warn` locally; CI runs `--frozen-lockfile`.
- `excludeLinksFromLockfile: true` for cleaner lockfile diffs.

Rules:

- **`pnpm-lock.yaml` is committed.** CI installs with `--frozen-lockfile`.
- **Build-script allowlist:** `onlyBuiltDependencies` in `pnpm-workspace.yaml`
  lists `esbuild` (Vitest's native loader) and `lefthook` (whose postinstall
  runs `lefthook install -f` to write git hooks; it skips in CI). Adding a dep
  with an install/build script requires an allowlist entry with a one-line
  justification; prefer deps with no install scripts.
- **`pnpm audit`** is wired (`pnpm audit`). Review before any release.
- **No `npm` / `yarn`** in workflows. `package-lock.json` / `yarn.lock` are
  gitignored.
- **Add pnpm settings to `pnpm-workspace.yaml`, not `.npmrc`.** Keep `.npmrc`
  out of the repo; camelCase keys in the YAML.

## Repo layout

```
src/
  core/         # FSM types + (Phase 2) reducer + lifecycle + run-memory. Host-agnostic. No pi imports.
  manifest/     # Manifest types + parse + validate + toMachineDefinition (§8/§13)
  seam/         # (Phase 3) TypeBox emission schemas + validateEmission
  cost/         # (Phase 3) pure usage roll-up + cap-evaluation predicates
  persistence/  # RecordLog interface + InMemoryRecordLog
  host/         # (Phase 4+) SDK driver — engine. May import pi.
  extension/    # (Phase 7B) UX-shell helpers (manifest resolution, status poller, command handlers).
                # Mirrors src/host/ posture — may import pi; not scanned by the grep guard.
  bin/          # (Phase 7C.3) conduct CLI fallback (built to dist/bin/conduct.js)
  index.ts      # public barrel; host + extension + library consumers import only from here
extensions/
  conduct.ts    # (Phase 7B) pi extension entrypoint; loaded by pi via jiti
tests/
  *.test.ts              # unit + E2E (stub-provider-driven; no API key)
  grep-guard.test.ts     # asserts src/core + src/manifest (+seam/cost/+persistence) have zero pi imports
  package-metadata.test.ts # asserts pi extension manifest + peer-dependency posture (Phase 7C.2)
biome.json               # linter + formatter (replaces ESLint + Prettier)
lefthook.yml             # git hooks: pre-push runs lint + typecheck + tests
docs/
  orchestrator-fsm-spec.md            # the spec (authority)
  orchestrator-fsm-plan.md            # task index + checkpoints A–E
  orchestrator-fsm-plans/phase-*.md   # per-phase task detail
  extension-pivot-plan.md             # pivot delivery plan (parent of 7A/7B/7C)
  extension-pivot-plans/phase-7*.md   # per-pivot-phase task detail
  extension-usage.md                  # user-facing extension surface (/conduct, resume/list/abort, etc.)
  sdk-surface.md                      # pinned SDK primitives (Phase 4)
  dev-run-transcripts/                # manual real-model smoke transcripts
pnpm-workspace.yaml     # pnpm config + supply-chain hardening (camelCase keys)
```

## Verification

Phase gates are real gates — don't start the next phase until the current one is
green (verification below) and its plan checkboxes are ticked. **Per-phase
human review is not a gate.** The overseer owns specs and high-level direction
up front and gives feedback at the end of the loop, not between phases; see
*Operating model* under *Working in this repo* below. The one exception is a
spec review: a new spec must be acknowledged by the overseer before
implementation against it starts (specs are the overseer's concern).

- `pnpm typecheck` — clean (strict + `noUncheckedIndexedAccess`); uses
  `tsconfig.test.json` so tests are type-checked too. `tsconfig.test.json`
  overrides `exclude` to drop `"tests"` (inherited from the base
  `tsconfig.json`) — without this override, no test file enters the
  program and the gate is a false signal.
- `pnpm build` — emits `dist/` with `.d.ts`.
- `pnpm test` — all green; `tests/grep-guard.test.ts` passes.
- `pnpm lint` (`biome check .`) / `pnpm format:check` — clean.
- `pnpm audit` — no high/critical advisories unaddressed.

**Git hooks (Lefthook):** `pre-push` runs `pnpm lint`, `pnpm typecheck`,
`pnpm test` sequentially; any failure blocks the push. Hooks install
automatically on `pnpm install` (lefthook's postinstall, allowlisted under
`strict-dep-builds`) and skip in CI. CI runs the same three checks directly.

Every task in a phase sub-plan lists its own acceptance + verification; follow
those exactly. The grep guard is part of `pnpm test`, not an afterthought.

## Working in this repo

- **Start from a spec/plan, not a vibe.** If a task is non-trivial and no spec
  exists, write one (`spec-driven-development`). This repo already has a spec —
  reference the section you're implementing at the top of each file/PR.
- **Touch only what the task asks for.** No unsolicited refactors of adjacent
  code. If you spot a problem, file it as a note, don't fix it inline.
- **Surface assumptions before implementing.** State them; don't silently fill
  gaps.
- **One phase at a time.** Phases gate each other (Checkpoint A before reducer
  work, B before lifecycle/cost, C before the SDK host). Don't jump ahead.
- **Tick plan checkboxes as you go.** When a task has a plan artifact with
  Markdown checkboxes (`docs/**/phase-*.md` task lists, checkpoints, gates,
  exit-criteria blocks), tick `[x]` every box whose acceptance/verification
  step you actually performed in the same change that implements it — including
  parent-plan summary blocks that mirror the sub-plan. Leave a box `[ ]` only
  when its step is genuinely not done (e.g. a deferred manual run, an item
  owned by someone else). Do not tick a box for work you did not do, and do not
  leave a completed step unticked. This keeps the overseer from having to
  re-derive progress from commits.
- **Operating model — overseer + agent.** The human is an overseer: they own
  specs and high-level direction and give feedback at the **end of the loop**,
  not between phases. Do not block on per-phase human review; once a phase is
  green and its checkboxes are ticked, proceed to the next. The two things
  that *do* wait on the human: (1) a brand-new spec before implementation
  against it starts, and (2) the final end-of-loop review. Surface assumptions
  and open questions in plan docs so the overseer can spot them at a glance;
  don't silently resolve them.
- **No pi imports creep into the core.** If you reach for
  `@earendil-works/pi-coding-agent` in
  `src/core`/`src/manifest`/`src/seam`/`src/cost`, stop — that code belongs in
  `src/host`. The grep-guard test (`tests/grep-guard.test.ts`) will fail
  `pnpm test` and the pre-push hook; catch it before that.
