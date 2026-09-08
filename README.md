# pi-conductor

> **Portable agent orchestration for long-horizon coding work.** pi-conductor
> brings Roo/Zoo-style multi-role workflows to `pi` without tying orchestration
> to an editor. Run cost-controlled workflows across budget and frontier models,
> local or remote providers, and terminal-native environments like SSH and
> `tmux`.

> **Status:** pre-release. pi-conductor ships as a **pi extension** — install it
> with `pi install`, type `/conduct <goal>`, and it orchestrates a multi-role
> LLM workflow on top of a guarded, observable handoff state machine. The pure
> FSM core + SDK host driver are the engine; the extension is the UX shell
> around it.

## Contents

- [What this is](#what-this-is)
- [Quick start](#quick-start)
- [Documentation](#documentation)
- [Status & what's left](#status--whats-left)
- [Architecture in brief](#architecture-in-brief)
- [Repo layout](#repo-layout)
- [License](#license)

## What this is

pi-conductor orchestrates multi-role LLM workflows as a deterministic
**hub-and-spoke** state machine: one orchestrator role dispatches to one or more
worker roles, every transition is validated against a pinned manifest snapshot,
every state change is reduced through a pure reducer, and every record is
appended to a run-keyed log. Caps (per-session, per-run, per-worker visit count)
are enforced as host guards that synthesize machine events through the reducer —
never by mutating the checkpoint.

It ships as a [pi](https://github.com/earendil-works/pi) package:

```bash
pi install ./           # from this checkout (dev)
# or, once published:
pi install npm:pi-conductor
pi install git:github.com/lynellf/pi-conductor
```

After install, seven slash commands are available inside any pi session:

```text
/conduct <goal>          Start a run for <goal> using .pi/conductor.yaml
/conduct:resume <run_id> Resume a previously-started run by run_id
/conduct:list            List known runs in the conductor log
/conduct:abort           Abort the active run
/conduct:steer <message> Guide the active role before its next model call
/conduct:followup <message> Queue guidance for the next conductor prompt boundary
/conduct:copy            Copy the latest completed role response
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

The CLI also provides a machine-safe mode for benchmark adapters and other
noninteractive callers:

```bash
conduct \
  --non-interactive \
  --log-dir /tmp/pi-conductor/run-123 \
  --json \
  .pi/conductor.yaml \
  "Implement the requested repository change."
```

`--non-interactive` makes `ask_user` fail immediately instead of reading
stdin. `--log-dir <path>` selects the persistent run-log directory and creates
missing parents. `--json` reserves stdout for one versioned terminal JSON
document; prompts, warnings, and diagnostics use stderr. Normal conductor
terminal outcomes (`done`, `session_failed`, and `aborted`) retain exit code 0
and are distinguished by `exit_reason`; setup and unexpected runtime errors
remain nonzero. While a run is active, the first `SIGINT` or `SIGTERM` requests
a graceful abort so terminal state can be persisted; a second signal exits
immediately.

The engine is the same in all three surfaces — extension, CLI, and library.

### Two layers, kept strictly apart

- **Pure core** (`src/core`, `src/manifest`, `src/seam`, `src/cost`,
  `src/persistence`) — the deterministic FSM reducer + manifest static checks +
  TypeBox emission schemas + cost roll-up. **Zero pi imports.** Enforced by a
  grep-guard test that scans source as text.
- **SDK host driver** (`src/host`) — owns the orchestration loop, persists
  records, and enforces caps. Shared roles use the in-process SDK
  `createAgentSession` path; isolated `worktree` and `copy` roles use a
  host-owned package-local `pi --mode rpc` Node process whose current working
  directory is the provisioned role workspace.

The extension layer (`extensions/conduct.ts` + `src/extension/`) is the UX shell
that wraps the engine. It does not become the engine: the production `Host`
launches every worker role through the shared SDK or isolated RPC path, never
via `ctx.newSession()` / `ctx.fork()`. A grep guard on `extensions/**/*.ts`
rejects those two calls — the §9.5 boundary holds. While a conduct run is
active in the TUI, press `Esc` and confirm to abort it; the standalone `conduct`
CLI does not add that Escape interrupt.

For the full architecture rationale, see
[`docs/archive/orchestrator-fsm-spec.md`](docs/archive/orchestrator-fsm-spec.md)
(the authority).

## Quick start

### 1. Install

```bash
pi install ./                       # from the checkout, dev install
pi list                             # verify: pi-conductor should appear
```

### 2. Declare roles

Roles live in a single YAML manifest, `.pi/conductor.yaml`. The repo ships an
example:

```yaml
version: 1
end_request_roles: [reviewer]
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
    models:
      - model: anthropic:claude-opus-4-5
        effort: high                       # explicit; effort defaults to "medium" when omitted
      - openai:gpt-4o                     # legacy shorthand → { model, effort: "medium" }
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
`DefaultResourceLoader({ systemPromptOverride })` and feeds it to the role's
session. See the shipped defaults at
`tests/fixtures/default-conductor/.pi/roles/`. A role prompt tells the role
which tools it has, what its legal handoff target is, and whether it may request
completion. The host force-injects both `handoff` and `end` into every role;
workers return through `handoff`, while only the orchestrator can finalize a run.

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

You'll see the conductor's status line update as the orchestrator dispatches to
workers; while a role session is active, the footer also shows
`model=<provider:id> · effort=<level>` (or `model=<default> · effort=medium` on
the system/default model path) for the current worker. The run reaches a
terminal state and notifies with the run_id, and `/conduct:list` shows the same
model and effort tokens for active runs. While the run is active, `Esc` opens a
confirmation dialog; confirming aborts the run just like `/conduct:abort`.
Use `/conduct:steer` to redirect the addressable active role, or
`/conduct:followup` to carry guidance across the next handoff. `/conduct:copy`
copies the latest completed assistant response without tool summaries and remains
available for the most recently completed run in the current pi process.

## Documentation

The reference material is split into focused pages:

- [`RoleConfig` fields](docs/role-config.md) — manifest fields, gated completion,
  and versioning.
- [Tools available to roles](docs/role-tools.md) — machine tools, SDK tools, and
  the explicit `tools:` allowlist.
- [Worktree subagent delegation](docs/delegation.md) — child profiles,
  projections, artifacts, and branch integration.
- [Per-role isolated workspaces](docs/workspaces.md) — workspace backends,
  artifacts, mounts, and progressive disclosure.
- [Advanced: library use](docs/library.md) — embedding the engine in a library
  or application.
- [Hooking into the record stream](docs/record-stream.md) — the emitter,
  consumer extension, and durable-log contract.
- [Architecture in brief](docs/architecture.md) — the full architecture
  overview and invariants.
- [Contributing](CONTRIBUTING.md) — prerequisites and verification.

## Status & what's left

Full status is tracked in the authoritative specs:

- [`docs/archive/orchestrator-fsm-spec.md`](docs/archive/orchestrator-fsm-spec.md)
  — the FSM engine.
- [`src/host/record-emitter.ts`](src/host/record-emitter.ts) — the
  typed in-process emitter (`subscribeToRecords`) and its consumer contract.

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

The full architecture rationale and invariants are in
[`docs/architecture.md`](docs/architecture.md) and the authoritative
[`docs/archive/orchestrator-fsm-spec.md`](docs/archive/orchestrator-fsm-spec.md).

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
  archive/orchestrator-fsm-spec.md    the spec (authority)
biome.json            # linter + formatter (replaces ESLint + Prettier)
lefthook.yml          # git hooks: pre-push runs lint + typecheck + tests
pnpm-workspace.yaml   # pnpm config + supply-chain hardening (camelCase keys)
```

## License

MIT — see `LICENSE`.
