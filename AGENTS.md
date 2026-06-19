# AGENTS.md

> **Read this before any work in the repo.**
>
> **Step 0 — load the `using-agent-skills` skill first.** Its file is at
> `.agents/skills/using-agent-skills/SKILL.md`. Read it in full before touching
> anything. It defines the skill-discovery flow (which skill applies to which
> phase of work) and the **Core Operating Behaviors** that govern _all_ work
> here: surface assumptions, manage confusion actively, push back when
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
`docs/orchestrator-fsm-plan.md` + `docs/orchestrator-fsm-plans/*`.

## What this is

`pi-conductor` orchestrates multi-role LLM workflows on
[pi](https://github.com/earendil-works/pi-coding-agent) via a **guarded,
observable handoff state machine**. Two layers, kept strictly apart:

- **Pure core** (`src/core`, `src/manifest`, later `src/seam`, `src/cost`): a
  deterministic FSM reducer + manifest static checks. Zero pi imports. Zero I/O.
- **SDK host driver** (`src/host`, Phase 4+): owns the orchestration loop,
  spawns role sessions via `createAgentSession`, persists records, enforces cost
  caps. The only place that imports `@earendil-works/pi-coding-agent`.

The core is imported by the host; the host is never imported by the core.

## Non-negotiable invariants

These exist for concrete reasons (see spec/plan). Do not violate them without an
explicit decision recorded in `docs/`.

1. **Host-agnostic core.** `src/core`, `src/manifest`, `src/seam`, `src/cost`
   must not import `@earendil-works/pi-coding-agent` (or any pi runtime).
   Enforced by the grep-guard test (`tests/grep-guard.test.ts`) — it scans
   source as text so a TS error can never mask an illegal import. Only
   `src/host` may import pi.
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
   Zod.

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
  core/        # FSM types + (Phase 2) reducer. Host-agnostic. No pi imports.
  manifest/    # Manifest types + parse + validate + toMachineDefinition (§8/§13)
  seam/        # (Phase 3) TypeBox emission schemas + validateEmission
  cost/        # (Phase 3) pure usage roll-up + cap-evaluation predicates
  host/        # (Phase 4+) SDK driver — the ONLY place that imports pi
  index.ts     # public barrel; host imports only from here
tests/
  *.test.ts           # unit tests (table-driven where spec enumerates)
  grep-guard.test.ts  # asserts src/core + src/manifest (+seam/cost) have zero pi imports
biome.json           # linter + formatter (replaces ESLint + Prettier)
lefthook.yml         # git hooks: pre-push runs lint + typecheck + tests
docs/
  orchestrator-fsm-spec.md            # the spec (authority)
  orchestrator-fsm-plan.md            # task index + checkpoints A–E
  orchestrator-fsm-plans/phase-*.md   # per-phase task detail
  sdk-surface.md                      # pinned SDK primitives (Phase 4)
pnpm-workspace.yaml   # pnpm config + supply-chain hardening (camelCase keys)
biome.json            # linter + formatter (replaces ESLint + Prettier)
lefthook.yml          # git hooks: pre-push runs lint + typecheck + tests
```

## Verification

Phase gates are real gates — don't start the next phase until the current one is
green **and reviewed by a human**.

- `pnpm typecheck` — clean (strict + `noUncheckedIndexedAccess`); uses
  `tsconfig.test.json` so tests are type-checked too.
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
- **No pi imports creep into the core.** If you reach for
  `@earendil-works/pi-coding-agent` in
  `src/core`/`src/manifest`/`src/seam`/`src/cost`, stop — that code belongs in
  `src/host`. The grep-guard test (`tests/grep-guard.test.ts`) will fail
  `pnpm test` and the pre-push hook; catch it before that.

## Current status

Phase 1 (foundation) complete pending human review. Tasks 1–4 (scaffold + pnpm
supply-chain hardening, core FSM types, manifest parse/validate/derive) all landed
(commits `d87db12`→`6fda6d9`); all automated gates green. See
`docs/orchestrator-fsm-plans/phase-1-foundation.md` (Checkpoint A). Phase 2 (reducer)
opens after human sign-off.
