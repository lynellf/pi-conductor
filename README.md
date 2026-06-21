# pi-conductor

> **Status:** pre-release. pi-conductor ships as a **pi extension** — install
> it with `pi install`, type `/conduct <goal>`, and it orchestrates a
> multi-role LLM workflow on top of a guarded, observable handoff state
> machine. The pure FSM core + SDK host driver are the engine; the
> extension is the UX shell around it.

---

## What this is

pi-conductor orchestrates multi-role LLM workflows as a deterministic
**hub-and-spoke** state machine: one orchestrator role dispatches to one or
more worker roles, every transition is validated against a pinned manifest
snapshot, every state change is reduced through a pure reducer, and every
record is appended to a run-keyed log. Caps (per-session, per-run, per-worker
visit count) are enforced as host guards that synthesize machine events
through the reducer — never by mutating the checkpoint.

It ships as a [pi](https://github.com/earendil-works/pi-coding-agent) package:

```bash
pi install ./           # from this checkout (dev)
# or, once published:
pi install npm:pi-conductor
pi install git:github.com/you/pi-conductor
```

After install, four slash commands are available inside any pi session:

```text
/conduct <goal>          Start a run for <goal> using .pi/conductor.yaml
/conduct:resume <run_id> Resume a previously-started run by run_id
/conduct:list            List known runs in the conductor log
/conduct:abort           Abort the active run
```

Plus a flag:

```text
--conduct-manifest <path>  Override the default manifest path
```

A thin CLI fallback (`bin/conduct`) also ships, for non-pi consumers and
scripted runs:

```bash
node dist/bin/conduct.js .pi/conductor.yaml "ship the changelog"
```

The engine is the same in all three surfaces — extension, CLI, and library.

---

## Two layers, kept strictly apart

- **Pure core** (`src/core`, `src/manifest`, `src/seam`, `src/cost`,
  `src/persistence`) — the deterministic FSM reducer + manifest static
  checks + TypeBox emission schemas + cost roll-up. **Zero pi imports.**
  Enforced by a grep-guard test that scans source as text.
- **SDK host driver** (`src/host`) — owns the orchestration loop, spawns
  role sessions via `createAgentSession`, persists records, enforces caps.
  **The only place that imports `@earendil-works/pi-coding-agent`.**

The extension layer (`extensions/conduct.ts` + `src/extension/`) is the
UX shell that wraps the engine. It does not become the engine: worker
role sessions are still spawned by the production `Host` via the
standalone `createAgentSession`, not via `ctx.newSession()` /
`ctx.fork()`. A grep guard on `extensions/**/*.ts` rejects those two
calls — the §9.5 boundary holds.

For the full architecture rationale, see
[`docs/orchestrator-fsm-spec.md`](docs/orchestrator-fsm-spec.md) (the
authority) and [`docs/extension-pivot-plan.md`](docs/extension-pivot-plan.md)
(the pivot delivery plan). `docs/extension-usage.md` walks through the
extension surface end-to-end.

---

## Quick start

### 1. Install

```bash
pi install ./                       # from the checkout, dev install
pi list                             # verify: pi-conductor should appear
```

### 2. Declare roles

Roles live in a single YAML manifest, `.pi/conductor.yaml`. The repo ships
an example:

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

### 3. Write role prompts

Each role's system prompt is a plain-prose `.md` file at the declared
`system_prompt` path. The host loads it via
`DefaultResourceLoader({ systemPromptOverride })` and feeds it to the
role's session. See the shipped defaults at
`tests/fixtures/default-conductor/.pi/roles/`. A role prompt tells the
role which tools it has (`handoff`, and — for the orchestrator only —
`end`), what its legal handoff targets are, and when to end.

A minimal starter bundle is available programmatically:

```ts
import { getDefaultBundle } from "pi-conductor";
const { yaml, prompts } = getDefaultBundle(); // default conductor.yaml + orchestrator/worker prompts
```

### 4. Run

Inside any pi session in a project with `.pi/conductor.yaml`:

```text
/conduct ship the changelog for the auth refactor
```

You'll see the conductor's status line update as the orchestrator
dispatches to workers; while a role session is active, the footer may
also show `model=<provider:id>` or `model=<default>` for the current
worker. The run reaches a terminal state and notifies with the
run_id, and `/conduct:list` shows the same model token for active runs.

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
| `tools` | any role | Declared tool allowlist. `handoff` and `end` are **force-injected by the host regardless**; omitting them emits a §13 warning. See [Tools available to roles](#tools-available-to-roles) below for the full tool model and the `tools:`-omission footgun. |

`version` is a human-bumped integer, **pinned at run-start and never
mutated mid-run** (spec §10). `resumeRun` rejects a manifest whose
version disagrees with the snapshot's pinned version.

### Tools available to roles

Each role session gets tools from **two sources**, and the manifest's
`tools:` field is an **explicit allowlist**, not an extension of pi's
defaults:

**1. Conductor-defined machine-event tools — always on, force-injected.**

`handoff` and `end` are defined by pi-conductor (TypeBox schemas in
`src/seam/`, factories in `src/host/tools.ts`) and registered as
`customTools` on every role session. They are added to the allowlist
**regardless of what `tools:` declares** (§8.1); omitting them from
`tools:` emits a §13 warning but does not disable them.

- **`handoff`** — terminate this role's session and route to another
  declared role. Workers may only hand off to the orchestrator; the
  orchestrator may hand off to any declared worker (subject to visit
  caps, §7.3). Args: `target_role: Role` (required, non-empty), plus
  optional `reason: string` and `suggests_next: Role` (workers only,
  non-binding — the orchestrator still emits its own legal handoff).
- **`end`** — terminate this role's session and declare the run
  complete. Legal only from the orchestrator (§7.2); a worker calling
  `end` produces a `transition_rejected` record with `legal_targets`
  surfaced. Args: optional `reason: string`.

Both tools only **validate and record intent** into a per-session capture
buffer and return a terminating message; they do **not** call `reduce`
and do **not** persist — the loop owns those exclusively (§12.1).
After a role's first valid `handoff`/`end` capture, the session is
**sealed**: every other tool short-circuits, so work-after-handoff
cannot mutate the workspace.

**2. Built-in + custom tools — pass-through to pi's tool registry.**

Every other name in `tools:` is resolved by pi's SDK, not pi-conductor.
pi-conductor does not construct or restrict these — it passes the
declared names straight through to `createAgentSession({ tools: [...] })`.

pi's built-in tool set (the authoritative reference is **pi's own
documentation** — see the links below; pi-conductor does not redefine
it) is, as of pi 0.79.x:

- **On by default (4):** `read`, `write`, `edit`, `bash`.
- **Additional built-in read-only tools, opt-in via `tools:` (3):**
  `grep`, `find`, `ls`.

Extension-registered or custom tool names the host pi session makes
available may also be named in `tools:`.

> **Note the interaction with the `tools:`-allowlist footgun below:**
> because pi-conductor treats `tools:` as an explicit allowlist (not an
> extension of pi's defaults), a role that wants the standard file/shell
> access must **name** `read`/`write`/`edit`/`bash` explicitly — they are
> not inherited just because pi enables them by default in a plain
> `pi` session. `grep`/`find`/`ls` likewise must be named to be available.

**Reference — pi's tool documentation (the authority on the built-in
set; pi-conductor is a pass-through consumer):**

- [pi Quickstart — tools](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/quickstart.md)
  (the "By default, pi gives the model four tools" statement + the
  opt-in read-only tools).
- [pi SDK reference — tools](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/sdk.md)
  (the `createReadTool` / `createWriteTool` / `createEditTool` /
  `createBashTool` / `createGrepTool` / `createFindTool` /
  `createLsTool` factories, the `tools` / `excludeTools` / `noTools`
  options, and custom-tool registration via `customTools` /
  `pi.registerTool`).

If those links 404 (pi's repo may be a monorepo at
`earendil-works/pi` under `packages/coding-agent/docs/`), the same files
ship inside the installed `@earendil-works/pi-coding-agent` package at
`docs/quickstart.md` and `docs/sdk.md`.

**Footgun — `tools:` is an explicit allowlist, not a default-extension.**
A role receives **exactly** the names it declares plus `handoff`+`end` —
not pi's four-tool default (`read`/`write`/`edit`/`bash`) on top.
**Omitting `tools:` entirely gives the role only `handoff`+`end`** — no
file or shell access, and no §13 warning fires (the §13 check only
triggers when `tools:` is present but missing `handoff`/`end`). Such a
role can emit machine events but cannot do work. Declare every tool a
role actually needs.

---

## Advanced: library use

The pure FSM core + SDK host driver are importable as a library. The
public API:

```ts
import {
  startRun,
  resumeRun,
  listRuns,
  createProductionHost,
  type Host,
  type HostFactoryContext,
  getDefaultBundle,
} from "pi-conductor";

const handle = await startRun(".pi/conductor.yaml", {
  goal: "Ship a changelog for the auth refactor.",
  hostFactory: (ctx: HostFactoryContext) =>
    createProductionHost({
      extension: { modelRegistry: /* pi's ModelRegistry */, cwd: process.cwd() },
      run: { log: ctx.log, loadedManifest: ctx.loadedManifest, runId: ctx.runId },
    }),
});

const { finalCheckpoint, exitReason } = await handle.completion();
```

`Host` is the seam between the pure loop and the pi SDK. It owns
session creation, event subscription + usage accumulation, the
run-keyed log, and per-session state. You can also implement a custom
`Host` against the interface in `src/host/host.ts` (six methods:
`spawnRole`, `captureUsage`, `persistRecord`, `seedRunMemory`,
`abortSession`, `sealSession`, plus `nextVisitIndex`,
`sessionTerminalReason`, `getNextModel`, `runCostSoFar`).

The CLI is a thin example of this: `src/bin/conduct.ts` calls
`startRun` with a `hostFactory` that builds a `ProductionHost` from a
fresh `ModelRegistry`. Read it for a self-contained 100-line
integration example.

---

## Status & what's left

### Done and green (432 tests / 43 files; `typecheck` / `build` / `lint` / `format:check` clean)

- Pure FSM core: `reduce` + `reduceLifecycle`, cap-aware legal targets,
  visit caps, two-reducer composition.
- Manifest parse / validate / derive (`toMachineDefinition`), every
  §13 check.
- Seam: TypeBox `handoff`/`end` schemas + `validateEmission` (single
  source of truth — same schema is the `defineTool` param schema and
  derives the TS type).
- Pure cost: usage roll-up + `sessionCapExceeded` / `runCapExceeded`
  predicates.
- Persistence: `RecordLog` interface + `InMemoryRecordLog` (core) +
  `FileRecordLog` (host), snapshot-appended checkpoints, crash
  reconciliation.
- Run-memory artifact (`buildRunMemory`) seeded into each orchestrator
  turn.
- Host loop: legal handoff spawn + seed, illegal-handoff rejection with
  `legal_targets` surfaced, post-emission sealing (no side effects
  after a role declares exit intent), resume from a file-backed log,
  cost-cap forced-`end` deferred to the orchestrator (§11.7),
  model-fallback escalation (§9.4).
- Default v1 bundle (one orchestrator + one worker) exercised
  end-to-end via a **stub provider** in CI — no API key required.
- Production `Host`: resolves `provider:id` models via
  `ModelRegistry.find`, loads role prompts, wires
  `DefaultResourceLoader({ systemPromptOverride })`, spawns real role
  sessions with a file-backed `SessionManager` rooted under the
  conductor's run directory.
- Extension shell: `/conduct`, `/conduct:resume`, `/conduct:list`,
  `/conduct:abort`, `--conduct-manifest`. The extension is the primary
  user surface; it registers in `pi` via the standard package
  convention (`package.json#pi.extensions`).
- CLI fallback: `bin/conduct` — non-pi surface that exercises the
  same production `Host`. Scriptable; useful for tests, CI, and
  non-pi consumers.
- A real-model smoke ran end-to-end against a developer's
  `~/.pi/agent/auth.json` on 2026-06-19; transcript at
  `docs/dev-run-transcripts/2026-06-19-cli-real-model-smoke.md`.

### Not yet built (deferred / out of v1 scope)

- **TUI run viewer** (`ctx.ui.custom()` widget with keyboard nav for
  browsing live run status) — v1.1.
- **Public npm publish** — v1 is local-path and git installs; npm
  publishing is a separate decision after user testing.
- See `docs/orchestrator-fsm-plans/phase-6-out-of-scope.md`.

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
            │
            ▼
   ┌────────┴────────┐
   ▼                 ▼
   bin/conduct    extensions/conduct.ts
   (CLI)          (pi extension /commands)
```

- **`def: MachineDefinition`** is the pinned manifest snapshot.
  `reduce` / `reduceLifecycle` are pure functions of `(checkpoint,
  event, def, meta)` — no ambient config, no I/O. `meta.role ===
  checkpoint.current_role` is asserted inside `reduce`; a mismatch is
  thrown, not trusted.
- **Every state change goes through `reduce`.** Cost-cap forced-close
  synthesizes a machine `end` event fed to `reduce`; the checkpoint is
  never mutated to `done` directly.
- **Checkpoint is snapshot-appended, never mutated in place.** Resume
  reads the latest snapshot from the host-owned `run_id`-keyed log.
  SDK branch scoping is not used.
- **`handoff`/`end` tools only validate + record intent** into a
  capture buffer and return a terminating message; they do **not**
  call `reduce` and do **not** persist. The loop owns `reduce` +
  persistence + spawning.
- **Post-emission sealing:** once a role's first valid `handoff`/`end`
  capture is recorded, the session is sealed — wrapped tools refuse to
  execute, so work-after-handoff cannot mutate the workspace.

The full authority is [`docs/orchestrator-fsm-spec.md`](docs/orchestrator-fsm-spec.md);
sequencing is in
[`docs/orchestrator-fsm-plan.md`](docs/orchestrator-fsm-plan.md) +
[`docs/orchestrator-fsm-plans/phase-*.md`](docs/orchestrator-fsm-plans/).
The pivot delivery plan is
[`docs/extension-pivot-plan.md`](docs/extension-pivot-plan.md) +
[`docs/extension-pivot-plans/phase-7*.md`](docs/extension-pivot-plans/).
The extension user surface is documented at
[`docs/extension-usage.md`](docs/extension-usage.md).

---

## Contributing

### Prerequisites

- Node.js ≥ 20, pnpm (matches the pi ecosystem). No npm/yarn.
- Install: `pnpm install` (also installs Lefthook git hooks via an
  allowlisted postinstall).

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
sequentially; any failure blocks the push. CI runs the same three
directly.

### Invariants you must not break

- **No pi imports in the core.** `src/core`, `src/manifest`, `src/seam`,
  `src/cost`, `src/persistence` must not import
  `@earendil-works/pi-coding-agent`. `tests/grep-guard.test.ts` scans
  source as text and will fail `pnpm test` (and the pre-push hook) on a
  violation — a TS error can never mask it. `src/host`,
  `src/extension`, and `extensions/` may import pi (they're the only
  layers that bridge to the SDK). If you reach for the SDK in the core,
  stop; that code belongs in `src/host`.
- **Reducer purity.** `reduce` / `reduceLifecycle` take `def` and read
  roles + caps only from it — never from imports or globals.
- **One schema, TypeBox.** No Zod. The `handoff`/`end` TypeBox schemas
  are the single source of truth for tool args, seam validation, and
  the derived TS type. The peer-dependency declaration for `typebox`
  in `package.json` matches the name pi bundles — don't swap back to
  `@sinclair/typebox` (different package, would break tool-arg
  validation at runtime).
- **TypeScript strict**, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, ESM +
  NodeNext. No `any`. Named exports only.
- **Module size ~400 LOC ceiling.** Split by responsibility before a
  file gets large. Readability over cleverness.
- **No silent fallbacks.** Ambiguity → throw a typed error or surface a
  warning.
- **No `ctx.newSession()` / `ctx.fork` in `extensions/`.** Role
  sessions are spawned via the standalone `createAgentSession` only.
  `tests/extension/no-role-spawn-via-session-tree.test.ts` greps for
  these calls.

### Phases gate each other

Work is sequenced in phases; don't start the next phase until the
current one is green and its plan checkboxes are ticked. Per-phase human
review is not a gate — the overseer reviews specs up front and gives
feedback at the end of the loop (see *Operating model* in `AGENTS.md`).
Touch only what your
task asks for; surface assumptions before implementing; if a task is
non-trivial and no spec exists, write one. See `AGENTS.md` for the
full working agreement.

### Supply chain (pnpm)

Project config lives in `pnpm-workspace.yaml` (camelCase keys, pnpm 10
canonical). Hardening: `minimumReleaseAge: 10080` (only versions ≥ 7
days old), `strictDepBuilds: true` (build scripts must be allowlisted
under `onlyBuiltDependencies`), `excludeLinksFromLockfile: true`.
`pnpm-lock.yaml` is committed; CI installs with `--frozen-lockfile`.
Never set `dangerouslyAllowAllBuilds`; adding a dep with a build script
requires an allowlist entry with a one-line justification.

---

## Repo layout

```
src/
  core/         FSM types + reducer + lifecycle + targets + run-memory (no pi)
  manifest/     manifest types + parse + validate + toMachineDefinition
  seam/         TypeBox emission schemas + validateEmission
  cost/         pure usage roll-up + cap predicates
  persistence/  RecordLog interface + InMemoryRecordLog
  host/         SDK driver — the ONLY place that imports pi (engine)
  extension/    UX shell helpers — wraps src/host for the extension
                (may import pi; mirrors src/host/ posture)
  bin/          conduct CLI fallback (built to dist/bin/conduct.js)
  index.ts      public barrel
extensions/
  conduct.ts    pi extension entrypoint (loaded by pi via jiti)
tests/
  *.test.ts              unit + E2E (stub-provider-driven; no API key)
  grep-guard.test.ts     asserts src/core + src/manifest (+seam/cost) have zero pi imports
  package-metadata.test.ts asserts pi extension manifest + peer-dependency posture
docs/
  orchestrator-fsm-spec.md            the spec (authority)
  orchestrator-fsm-plan.md            task index + checkpoints A–E
  orchestrator-fsm-plans/phase-*.md   per-phase task detail
  extension-pivot-plan.md             pivot delivery plan (parent of 7A/7B/7C)
  extension-pivot-plans/phase-7*.md   per-pivot-phase task detail
  extension-usage.md                  user-facing extension surface (/conduct etc.)
  sdk-surface.md                      pinned SDK primitives (Phase 4)
  dev-run-transcripts/                manual real-model smoke transcripts
biome.json            # linter + formatter (replaces ESLint + Prettier)
lefthook.yml          # git hooks: pre-push runs lint + typecheck + tests
pnpm-workspace.yaml   # pnpm config + supply-chain hardening (camelCase keys)
```

## License

MIT — see `LICENSE`.
