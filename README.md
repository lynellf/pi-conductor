# pi-conductor

Multi-role LLM orchestration via a **guarded, observable handoff state machine** —
a pure TypeScript FSM core plus a [pi](https://github.com/earendil-works/pi-coding-agent)
SDK host driver that runs it.

> **Status:** pre-release. The pure core (reducer, lifecycle, seam, cost,
> persistence, run-memory) and a stub-provider-driven end-to-end loop are complete
> and green. **Real-model runs are not yet possible** — the production `Host`
> (real model resolution + system-prompt loading) is the remaining work. See
> [Status & what's left](#status--whats-left) before planning any user test.

---

## What this is — and isn't

pi-conductor orchestrates multi-role LLM workflows as a deterministic
**hub-and-spoke** state machine: one orchestrator role dispatches to one or more
worker roles, every transition is validated against a pinned manifest snapshot,
every state change is reduced through a pure reducer, and every record is
appended to a run-keyed log. Caps (per-session, per-run, per-worker visit count)
are enforced as host guards that synthesize machine events through the reducer —
never by mutating the checkpoint.

Two layers, kept strictly apart:

- **Pure core** (`src/core`, `src/manifest`, `src/seam`, `src/cost`,
  `src/persistence`) — the deterministic FSM reducer + manifest static checks +
  TypeBox emission schemas + cost roll-up. **Zero pi imports.** Enforced by a
  grep-guard test that scans source as text.
- **SDK host driver** (`src/host`) — owns the orchestration loop, spawns role
  sessions via `createAgentSession`, persists records, enforces caps. **The only
  place that imports `@earendil-works/pi-coding-agent`.**

### It is a library, not a pi extension

pi-conductor is **not** an installable pi extension and does not register a
`pi conductor` command. The extension path was considered and **explicitly
rejected** (spec §9.5): the tool-handler `ExtensionContext` lacks `newSession`,
which makes the orchestration loop untestable. Instead, pi-conductor is a
library you import and drive programmatically:

```ts
import { startRun } from "pi-conductor";
```

You call `startRun(manifestPath, { goal, hostFactory })`, supplying a factory
that builds the `Host` for the run. See [Running a run](#running-a-run).

### Roles are declared in YAML, not frontmatter

There is **no agent role frontmatter**. Roles are declared entirely in a single
manifest file, `.pi/conductor.yaml`. Per-role frontmatter was considered and
**explicitly rejected for v1** (the cross-file version-agreement problem). The
`.pi/roles/*.md` files referenced by the manifest are **plain-prose system
prompts**, loaded by path — not frontmatter-bearing agent definitions and not a
recognition mechanism.

Roles are recognized **solely by the manifest's `roles:` list**: `name` is the
identity, `is_orchestrator: true` marks the hub (exactly one), and the rest are
workers. The reducer has no implicit knowledge of any "default" role — every role
must be declared.

---

## Declaring roles (the manifest)

The manifest is `.pi/conductor.yaml`. The repo ships an example at
`.pi/conductor.yaml` (mirrors spec §8):

```yaml
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [anthropic:claude-sonnet-4-5]
    max_run_cost_usd: 25.0
    system_prompt: .pi/roles/orchestrator.md
    tools: [read, bash, handoff, end]

  - name: implementer
    max_visits: 3
    max_session_cost_usd: 5.0
    models: [anthropic:claude-opus-4-5, openai:gpt-4o]   # primary + fallbacks
    system_prompt: .pi/roles/implementer.md
    tools: [read, edit, write, bash, handoff, end]

  - name: reviewer
    max_visits: 3
    system_prompt: .pi/roles/reviewer.md
    tools: [read, grep, handoff, end]
```

### `RoleConfig` fields

| Field | Applies to | Meaning |
|---|---|---|
| `name` | all roles | Role identity (the `Role` the reducer keys on). |
| `is_orchestrator` | exactly one role | Marks the hub. Workers hand back to it; only it may emit `end`. |
| `max_visits` | workers | Per-worker visit cap (finite). **Uncapped workers are a hard manifest error (§13).** |
| `models` | any role | Ordered `[primary, ...fallbacks]`, each `provider:id`. Bare aliases are rejected (§13). Fallbacks are tried on `session_failed(model_error)`. |
| `max_session_cost_usd` | any role | Per-invocation cap, **shared across model fallbacks** within that invocation (§8.1, §11.7). |
| `max_run_cost_usd` | orchestrator only | Run-level cap. Rejected on workers (§13). |
| `system_prompt` | any role | Path to a per-role system-prompt file the host loads. Plain prose, not frontmatter. |
| `tools` | any role | Declared tool allowlist. `handoff` and `end` are **force-injected by the host regardless**; omitting them emits a §13 warning. |

`version` is a human-bumped integer, **pinned at run-start and never mutated
mid-run** (spec §10). `resumeRun` rejects a manifest whose version disagrees with
the snapshot's pinned version.

### The role system-prompt files

The `.md` files are plain prose. See the shipped defaults at
`tests/fixtures/default-conductor/.pi/roles/orchestrator.md` and
`worker.md`. Each prompt tells the role which tools it has (`handoff`, and — for
the orchestrator only — `end`), what its legal handoff targets are, and when to
end. A worker prompt says "you do NOT end the run" and "worker → worker is
illegal"; the orchestrator prompt says how to read the run-memory artifact and
the legal-target list the reducer surfaces on rejection.

A minimal starter bundle is available programmatically:

```ts
import { getDefaultBundle } from "pi-conductor";
const { yaml, prompts } = getDefaultBundle(); // default conductor.yaml + orchestrator/worker prompts
```

---

## Running a run

The public lifecycle API (spec §11.1, §11.9):

```ts
import { startRun, resumeRun, listRuns, type Host, type HostFactoryContext } from "pi-conductor";

const handle = await startRun(".pi/conductor.yaml", {
  goal: "Ship a changelog for the auth refactor.",
  hostFactory: (ctx: HostFactoryContext) => buildHost(ctx), // you provide the Host
});

const { finalCheckpoint, exitReason } = await handle.completion();
```

- **`startRun(manifestPath, opts)`** — loads the manifest, mints a `run_id`,
  opens the file-backed log, persists the initial checkpoint snapshot, and
  enters the loop. Returns a `RunHandle`.
- **`resumeRun(manifestPath, runId, opts)`** — re-loads the manifest, verifies
  the version pin, reconciles a crash-mid-session (a snapshot whose
  `active_role_session` never reached a terminal → `session_failed("crashed")`),
  and re-enters the loop at `current_role`.
- **`listRuns(baseDir)`** — enumerates known `run_id`s from a log directory.

`RunHandle` exposes `completion()` (final checkpoint + exit reason) and a
`runConfig()` override surface for adjusting the run cap live. `hostFactory`
receives `{ runId, def, log, loadedManifest }` so you can wire the `Host`
before the loop begins; the host is **not** reused across resumes.

### What you have to provide: the `Host`

`Host` is the seam between the pure loop and the pi SDK. It owns session
creation, event subscription + usage accumulation, the run-keyed log, and
per-session state. You implement it against the `Host` interface in
`src/host/host.ts` (six methods: `spawnRole`, `captureUsage`, `persistRecord`,
`seedRunMemory`, `abortSession`, `sealSession`, plus `nextVisitIndex`,
`sessionTerminalReason`, `getNextModel`, `runCostSoFar`).

---

## Status & what's left

### Done and green (329 tests / 27 files; `typecheck` / `build` / `lint` / `format:check` clean)

- Pure FSM core: `reduce` + `reduceLifecycle`, cap-aware legal targets, visit
  caps, two-reducer composition.
- Manifest parse / validate / derive (`toMachineDefinition`), every §13 check.
- Seam: TypeBox `handoff`/`end` schemas + `validateEmission` (single source of
  truth — same schema is the `defineTool` param schema and derives the TS type).
- Pure cost: usage roll-up + `sessionCapExceeded` / `runCapExceeded` predicates.
- Persistence: `RecordLog` interface + `InMemoryRecordLog` (core) +
  `FileRecordLog` (host), snapshot-appended checkpoints, crash reconciliation.
- Run-memory artifact (`buildRunMemory`) seeded into each orchestrator turn.
- Host loop: legal handoff spawn + seed, illegal-handoff rejection with
  `legal_targets` surfaced, post-emission sealing (no side effects after a role
  declares exit intent), resume from a file-backed log, cost-cap forced-`end`
  deferred to the orchestrator (§11.7), model-fallback escalation (§9.4).
- Default v1 bundle (one orchestrator + one worker) exercised end-to-end via a
  **stub provider** in CI — no API key required.

### Not yet built — blocks real-model user testing

The only `Host` implementation that exists is **`StubHost`**, which drives the
real `createAgentSession` against a **canned stub provider**. To run against real
models you need a **production `Host`** (the "Task 15 sibling" the code comments
call out as not yet built). Concretely, three gaps:

1. **Model resolution.** `StubHost` always uses the stub model; it reads
   `role.models[]` only to count fallback exhaustion. A production host must call
   `modelRegistry.find(provider, id)` to resolve each `provider:id` entry to a
   real provider-backed `Model`, and use a real/file-backed `SessionManager`.
2. **System-prompt loading.** `StubHost.spawnRole` does **not** wire a
   `resourceLoader`/`systemPromptOverride` and never reads `role.system_prompt`.
   A production host must load the `.md` file at the declared path and pass it
   via `DefaultResourceLoader({ systemPromptOverride: () => rolePrompt })`
   (the plan's resolved wiring). Until this lands, the role prompts are
   referenced by the manifest but **not actually fed to sessions**.
3. **A runnable entrypoint.** There is no CLI today; usage is programmatic. A
   thin runner script (or future `pi`-adjacent command) is needed for non-developer
   user testing.

Until those land, real-model runs are not possible. The stub-driven E2E proves
the loop mechanics (reducer ordering, sealing, caps, resume, fallback) but does
not exercise a real LLM.

### Out of v1 scope (Phase 6)

See `docs/orchestrator-fsm-plans/phase-6-out-of-scope.md`.

---

## Architecture in brief

```
checkpoint + event + def (pinned manifest snapshot)
            │
            ▼
        reduce()  ── pure, deterministic, host-agnostic (src/core)
            │
            ▼
   transition record + new checkpoint
            │
            ▼
   host persists record + snapshot, spawns next role (src/host)
```

- **`def: MachineDefinition`** is the pinned manifest snapshot. `reduce` /
  `reduceLifecycle` are pure functions of `(checkpoint, event, def, meta)` — no
  ambient config, no I/O. `meta.role === checkpoint.current_role` is asserted
  inside `reduce`; a mismatch is thrown, not trusted.
- **Every state change goes through `reduce`.** Cost-cap forced-close
  synthesizes a machine `end` event fed to `reduce`; the checkpoint is never
  mutated to `done` directly.
- **Checkpoint is snapshot-appended, never mutated in place.** Resume reads the
  latest snapshot from the host-owned `run_id`-keyed log. SDK branch scoping is
  not used.
- **`handoff`/`end` tools only validate + record intent** into a capture buffer
  and return a terminating message; they do **not** call `reduce` and do **not**
  persist. The loop owns `reduce` + persistence + spawning.
- **Post-emission sealing:** once a role's first valid `handoff`/`end` capture is
  recorded, the session is sealed — wrapped tools refuse to execute, so
  work-after-handoff cannot mutate the workspace.

The full authority is `docs/orchestrator-fsm-spec.md`; sequencing is in
`docs/orchestrator-fsm-plan.md` + `docs/orchestrator-fsm-plans/phase-*.md`.

---

## Contributing

### Prerequisites

- Node.js ≥ 20, pnpm (matches the pi ecosystem). No npm/yarn.
- Install: `pnpm install` (also installs Lefthook git hooks via an allowlisted
  postinstall).

### Verification commands

```bash
pnpm typecheck        # tsc --noEmit (strict + noUncheckedIndexedAccess), incl. tests
pnpm build            # emits dist/ with .d.ts
pnpm test             # vitest run (incl. the grep-guard test)
pnpm lint             # biome check .  (lint + format check)
pnpm format:check     # biome format .
pnpm audit --prod     # supply-chain audit
```

`pre-push` (Lefthook) runs `pnpm lint`, `pnpm typecheck`, `pnpm test`
sequentially; any failure blocks the push. CI runs the same three directly.

### Invariants you must not break

- **No pi imports in the core.** `src/core`, `src/manifest`, `src/seam`,
  `src/cost`, `src/persistence` must not import `@earendil-works/pi-coding-agent`.
  `tests/grep-guard.test.ts` scans source as text and will fail `pnpm test` (and
  the pre-push hook) on a violation — a TS error can never mask it. Only
  `src/host` may import pi. If you reach for the SDK in the core, stop; that code
  belongs in `src/host`.
- **Reducer purity.** `reduce` / `reduceLifecycle` take `def` and read roles +
  caps only from it — never from imports or globals.
- **One schema, TypeBox.** No Zod. The `handoff`/`end` TypeBox schemas are the
  single source of truth for tool args, seam validation, and the derived TS type.
- **TypeScript strict**, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`, ESM + NodeNext. No `any`. Named exports only.
- **Module size ~400 LOC ceiling.** Split by responsibility before a file gets
  large. Readability over cleverness.
- **No silent fallbacks.** Ambiguity → throw a typed error or surface a warning.

### Phases gate each other

Work is sequenced in phases (A–E checkpoints); don't start the next phase until
the current one is green **and reviewed by a human**. Touch only what your task
asks for; surface assumptions before implementing; if a task is non-trivial and
no spec exists, write one. See `AGENTS.md` for the full working agreement.

### Supply chain (pnpm)

Project config lives in `pnpm-workspace.yaml` (camelCase keys, pnpm 10
canonical). Hardening: `minimumReleaseAge: 10080` (only versions ≥ 7 days old),
`strictDepBuilds: true` (build scripts must be allowlisted under
`onlyBuiltDependencies`), `excludeLinksFromLockfile: true`. `pnpm-lock.yaml` is
committed; CI installs with `--frozen-lockfile`. Never set
`dangerouslyAllowAllBuilds`; adding a dep with a build script requires an
allowlist entry with a one-line justification.

---

## Repo layout

```
src/
  core/        FSM types + reducer + lifecycle + targets + run-memory (no pi)
  manifest/    manifest types + parse + validate + toMachineDefinition
  seam/        TypeBox emission schemas + validateEmission
  cost/        pure usage roll-up + cap predicates
  persistence/ RecordLog interface + InMemoryRecordLog
  host/        SDK driver — the ONLY place that imports pi
  index.ts     public barrel
tests/         unit + E2E (stub-provider-driven; no API key)
docs/          spec, plan, per-phase sub-plans, sdk-surface
```

## License

MIT — see `LICENSE`.
```
