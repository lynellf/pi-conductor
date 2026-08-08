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

---

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

---

## Two layers, kept strictly apart

- **Pure core** (`src/core`, `src/manifest`, `src/seam`, `src/cost`,
  `src/persistence`) — the deterministic FSM reducer + manifest static checks +
  TypeBox emission schemas + cost roll-up. **Zero pi imports.** Enforced by a
  grep-guard test that scans source as text.
- **SDK host driver** (`src/host`) — owns the orchestration loop, spawns role
  sessions via `createAgentSession`, persists records, enforces caps. **The only
  place that imports `@earendil-works/pi-coding-agent`.**

The extension layer (`extensions/conduct.ts` + `src/extension/`) is the UX shell
that wraps the engine. It does not become the engine: worker role sessions are
still spawned by the production `Host` via the standalone `createAgentSession`,
not via `ctx.newSession()` / `ctx.fork()`. A grep guard on `extensions/**/*.ts`
rejects those two calls — the §9.5 boundary holds. While a conduct run is
active in the TUI, press `Esc` and confirm to abort it; the standalone `conduct`
CLI does not add that Escape interrupt.

For the full architecture rationale, see
[`docs/orchestrator-fsm-spec.md`](docs/archive/orchestrator-fsm-spec.md) (the
authority).

---

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

### `RoleConfig` fields

| Field                  | Applies to        | Meaning                                                                                                                                                                                                                                                   |
| ---------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                 | all roles         | Role identity (the `Role` the reducer keys on).                                                                                                                                                                                                           |
| `is_orchestrator`      | exactly one role  | Marks the hub. Workers hand back to it; only it may emit `end`.                                                                                                                                                                                           |
| `max_visits`           | workers           | Per-worker visit cap (finite). **Uncapped workers are a hard manifest error (§13).**                                                                                                                                                                      |
| `models`               | any role          | Ordered `[primary, ...fallbacks]`. Each entry is a `provider:id` string (shorthand for `{ model, effort: "medium" }`) or an object `{ model, effort }`. Bare aliases are rejected (§13). Effort values: `off | minimal | low | medium | high | xhigh | max` (maps to pi's `thinkingLevel`; `max` is available on models such as GPT-5.6 that support it). Omitted effort defaults to `medium`, including the system/default model path. Fallbacks are tried on `session_failed(model_error)`. |
| `max_session_cost_usd` | any role          | Per-invocation cap, **shared across model fallbacks** within that invocation (§8.1, §11.7).                                                                                                                                                               |
| `max_run_cost_usd`     | orchestrator only | Run-level cap. Rejected on workers (§13).                                                                                                                                                                                                                 |
| `system_prompt`        | any role          | Path to a per-role system-prompt file the host loads. Plain prose, not frontmatter.                                                                                                                                                                       |
| `tools`                | any role          | Declared tool allowlist. `handoff` and `end` are **force-injected by the host regardless**; omitting them emits a §13 warning. `delegate` is available only when it is listed here **and** the role declares `delegation`. See [Tools available to roles](#tools-available-to-roles) below for the full tool model and the `tools:`-omission footgun. |
| `delegation`           | parent roles only | Enables bounded worktree subagents for this role. Requires `tools: [..., delegate]`; see [Worktree subagent delegation](#worktree-subagent-delegation) below. |

The optional top-level `end_request_roles` list enables gated completion. It
must contain one or more unique declared worker roles—never the orchestrator.
When omitted, legacy behavior is preserved: the orchestrator may call `end`
without a pending request. When configured, an authorized worker must first
handoff to the orchestrator with `status: complete` and `request_end: true`.
That approval is single-use: it is consumed by `end` and cleared if the
orchestrator dispatches more work. Run-cost-cap forced closure remains legal
without a request and still passes through the reducer.

`version` is a human-bumped integer, **pinned at run-start and never mutated
mid-run** (spec §10). `resumeRun` rejects a manifest whose version disagrees
with the snapshot's pinned version.

### Tools available to roles

Each role session gets tools from **two sources**, and the manifest's `tools:`
field is an **explicit allowlist**, not an extension of pi's defaults:

**1. Conductor-defined machine-event tools — always on, force-injected.**

`handoff` and `end` are defined by pi-conductor (TypeBox schemas in `src/seam/`,
factories in `src/host/tools.ts`) and registered as `customTools` on every role
session. They are added to the allowlist **regardless of what `tools:`
declares** (§8.1); omitting them from `tools:` emits a §13 warning but does not
disable them.

- **`handoff`** — terminate this role's session and route to another declared
  role. Workers may only hand off to the orchestrator; the orchestrator may hand
  off to any declared worker (subject to visit caps, §7.3). Every
  model-emitted handoff must include a non-empty actionable envelope:
  `status` (`ready`, `blocked`, or `complete`), `objective`, `summary`, and
  `requested_action`, alongside `target_role: Role`. `reason` and
  `suggests_next: Role` remain optional (the latter is workers-only and
  non-binding). `request_end?: boolean` defaults to `false`; it is valid only
  for a role named in `end_request_roles` handing back to the orchestrator with
  `status: complete`. An incomplete or unauthorized envelope returns an
  actionable error without advancing, persisting an accepted transition, or
  sealing the role session, so the role can correct it immediately.
- **`end`** — terminate this role's session and declare the run complete. Legal
  only from the orchestrator (§7.2). With `end_request_roles` configured, a
  normal `end` additionally requires a pending authorized request. A worker
  calling `end` produces a `transition_rejected` record with `legal_targets`
  surfaced. Args: optional `reason: string`.

Both tools only **validate and record intent** into a per-session capture buffer
and return a terminating message after a valid capture; they do **not** call
`reduce` and do **not** persist — the loop owns those exclusively (§12.1). An
incomplete handoff is the exception: it records a host-observable validation
failure and returns a non-terminating correction prompt. After a role's first
valid `handoff`/`end` capture, the session is **sealed**: every other tool
short-circuits, so work-after-handoff cannot mutate the workspace.

**2. Built-in + custom tools — pass-through to pi's tool registry.**

Every other name in `tools:` is resolved by pi's SDK, not pi-conductor.
pi-conductor does not construct or restrict these — it passes the declared names
straight through to `createAgentSession({ tools: [...] })`.

pi's built-in tool set (the authoritative reference is **pi's own
documentation** — see the links below; pi-conductor does not redefine it) is, as
of pi 0.79.x:

- **On by default (4):** `read`, `write`, `edit`, `bash`.
- **Additional built-in read-only tools, opt-in via `tools:` (3):** `grep`,
  `find`, `ls`.

Extension-registered or custom tool names the host pi session makes available
may also be named in `tools:`.

> **Note the interaction with the `tools:`-allowlist footgun below:** because
> pi-conductor treats `tools:` as an explicit allowlist (not an extension of
> pi's defaults), a role that wants the standard file/shell access must **name**
> `read`/`write`/`edit`/`bash` explicitly — they are not inherited just because
> pi enables them by default in a plain `pi` session. `grep`/`find`/`ls`
> likewise must be named to be available.

**Reference — pi's tool documentation (the authority on the built-in set;
pi-conductor is a pass-through consumer):**

- [pi Quickstart — tools](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/quickstart.md)
  (the "By default, pi gives the model four tools" statement + the opt-in
  read-only tools).
- [pi SDK reference — tools](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
  (the `createReadTool` / `createWriteTool` / `createEditTool` /
  `createBashTool` / `createGrepTool` / `createFindTool` / `createLsTool`
  factories, the `tools` / `excludeTools` / `noTools` options, and custom-tool
  registration via `customTools` / `pi.registerTool`).

The same files ship inside the installed `@earendil-works/pi` package at
`packages/coding-agent/docs/quickstart.md` and `packages/coding-agent/docs/sdk.md`.

**Footgun — `tools:` is an explicit allowlist, not a default-extension.** A role
receives **exactly** the names it declares plus `handoff`+`end` — not pi's
four-tool default (`read`/`write`/`edit`/`bash`) on top. **Omitting `tools:`
entirely gives the role only `handoff`+`end`** — no file or shell access, and no
§13 warning fires (the §13 check only triggers when `tools:` is present but
missing `handoff`/`end`). Such a role can emit machine events but cannot do
work. Declare every tool a role actually needs.

---

## Worktree subagent delegation

Yes: `delegate` is a host-provided tool, but **only a role that explicitly opts
in receives it**. It is not an FSM transition and subagents are not conductor
roles: the parent remains responsible for reviewing the result and deciding
whether to integrate a child branch.

### Configure a parent and profiles

Add `delegate` and a `delegation` policy to the parent role, then define the
named child profiles at top level:

```yaml
version: 1
roles:
  - name: implementer
    max_visits: 3
    models: [anthropic:claude-sonnet-4-5]
    system_prompt: .pi/roles/implementer.md
    tools: [read, grep, edit, write, bash, handoff, end, delegate]
    delegation:
      allowed_subagents: [api-implementer, test-writer]
      max_children_per_session: 6
      max_parallel: 2

subagents:
  - name: api-implementer
    models:
      - model: anthropic:claude-sonnet-4-5
        effort: high
    max_session_cost_usd: 2.00
    system_prompt: .pi/subagents/api-implementer.md

  - name: test-writer
    models: [anthropic:claude-sonnet-4-5]
    max_session_cost_usd: 1.00
    system_prompt: .pi/subagents/test-writer.md
```

`allowed_subagents` must name declared profiles without duplicates.
`max_children_per_session` is the total child-task allowance for one parent
session; completed children do not free a slot. `max_parallel` bounds concurrent
children and cannot exceed that allowance. Profile names cannot collide with
FSM role names. Bump `version` when changing this policy or a profile.

The child profile's `system_prompt` is a normal prompt file. Tell it to make a
focused change, run appropriate verification, commit a clean result in its
worktree, and call `report_result`. The host supplies the child task and its
worktree path; do not put parent transcripts or FSM routing instructions in the
child prompt.

### Ask the parent to delegate

The enabled parent calls `delegate` with one or more independent tasks:

```json
{
  "tasks": [
    {
      "id": "api",
      "subagent": "api-implementer",
      "objective": "Add the endpoint validation described in issue 42.",
      "expected_output": "A committed implementation and relevant unit tests."
    },
    {
      "id": "tests",
      "subagent": "test-writer",
      "objective": "Add edge-case coverage for the endpoint contract.",
      "expected_output": "Committed tests and the test command used."
    }
  ]
}
```

Task IDs match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; `objective` and
`expected_output` must each be 1–8,192 characters. The entire batch is
validated before any worktree is created. Delegation requires a clean primary
checkout (`git status --porcelain=v1 --untracked-files=all`) and a resolvable
`HEAD`; commit or stash ordinary and untracked changes first.

The tool waits for all children and returns results in input order. Each result
contains its authoritative status, branch, worktree path, base/head commits,
session file, usage, summary, and any failure reason. `completed` requires
verified uncommitted changes in the child worktree; `no_changes` requires a
clean worktree at the batch base. A `completed` report without changes becomes
`no_changes`; an unexpected commit or invalid Git state becomes `failed`.

### Child boundary and branch integration

Each child receives only `read`, `grep`, `find`, `ls`, `edit`, `write`, and
`report_result`, rooted in its generated worktree. Every child file tool
rejects absolute paths, `..` traversal, and paths that resolve through a symlink
outside that worktree; this is path confinement, not an OS or credential
sandbox. Children cannot call `run`, `bash`, `handoff`, `end`, `ask_user`, or
`delegate`.

The parent receives the worktree path and branch, then owns testing, formatting,
builds, Git inspection, commits, and integration. For example, it may run
`pnpm --dir <worktree_path> test`, inspect `git -C <worktree_path> diff`, and
commit accepted changes. The conductor never performs those actions automatically.

The host creates `conductor/<runId>/<childId>` and keeps both branch and
worktree under the run state directory. It **never** merges, cherry-picks,
resets, deletes, or automatically cleans up a child branch. After reviewing a
successful result, the parent or operator explicitly verifies, commits, and
integrates it, for example:

```bash
pnpm --dir <worktree_path> test
git -C <worktree_path> diff
git -C <worktree_path> add --all
git -C <worktree_path> commit -m "Implement delegated task"
git cherry-pick conductor/<runId>/<childId>
```

Worktree confinement is a path-control boundary, not an OS, network,
credential, or process sandbox. Child failures do not cancel siblings. A run
abort cancels active children and then the parent; resume marks in-flight
children as cancelled (`recovered_child_lost`) rather than relaunching them.

---

## Advanced: library use

The pure FSM core + SDK host driver are importable as a library. The public API:

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

While the run is live, library consumers can use the same control state as the
extension:

```ts
await handle.steer("Check the migration rollback path before continuing.");
await handle.followUp("Include the final verification commands in the response.");

const latest = handle.latestResponse();
console.log(latest?.role, latest?.text);
```

`steer` targets an addressable active role or queues at a role boundary.
`followUp` always queues for the next conductor prompt, so it follows a handoff.
`latestResponse()` returns assistant text and readable displayed reasoning while
excluding tool summaries. Clipboard access remains a UI concern.

`Host` is the seam between the pure loop and the pi SDK. It owns session
creation, event subscription + usage accumulation, the run-keyed log, and
per-session state. You can also implement a custom `Host` against the interface
in `src/host/host.ts` (six methods: `spawnRole`, `captureUsage`,
`persistRecord`, `seedRunMemory`, `abortSession`, `sealSession`, plus
`nextVisitIndex`, `sessionTerminalReason`, `getNextModel`, `runCostSoFar`).

The CLI is a thin example of this: `src/bin/conduct.ts` calls `startRun` with a
`hostFactory` that builds a `ProductionHost` from a fresh `ModelRegistry`. Read
it for a self-contained integration example.

---

## Hooking into the record stream

pi-conductor persists every machine event, lifecycle event, and checkpoint
snapshot to a per-run JSONL log on disk — the durable system of record. It
also exposes a typed, **in-process emitter** that fans out the same records
to *separately installed* extensions in the same `pi` process. The emitter
is a read-side extension point: `pi-conductor` ships zero upload code, zero
network code, zero server config — just a public function a consumer can
call to register a listener and receive every record the host persists.

The intended consumer is a *separately installed* pi extension living in
`~/.pi/agent/extensions/` (per the pi extensions spec, "Extensions" — auto-
discovery). It is not part of `pi-conductor` and is not published alongside
it. The consumer owns auth, retry, batching, backpressure, and the durable
replay of anything the listener missed. The spec's only contract is
`subscribeToRecords` and the durable log.

### The public API

A single module-level function exported from `pi-conductor`'s public barrel:

```ts
import {
  subscribeToRecords,
  type PersistedRecord,
} from "pi-conductor";

const unsubscribe = subscribeToRecords((record: PersistedRecord) => {
  // Do whatever you want with the record. The host fires listeners
  // fire-and-forget — async listeners are NOT awaited. Errors thrown
  // from a listener (sync or async) are isolated and do not affect
  // the engine or other listeners.
});
```

`PersistedRecord` is the union from `src/persistence/log.ts`:
`transition_accepted`, `transition_rejected`, `session_started` /
`session_ended` / `session_failed`, `model_fallback`, `checkpoint_snapshot`,
and delegation's `subagent_started`, `subagent_completed`, and
`subagent_failed` records. The emitter is a transparent fan-out of what the
host persists.

The contract — FIFO subscription order, fire-and-forget async delivery,
sync-throw and async-rejection isolation, re-entrant subscribe /
unsubscribe (effects take place on the next record), idempotent unsubscribe,
and the durable backstop pattern — is in
[`src/host/record-emitter.ts`](src/host/record-emitter.ts) (the authority).

### A consumer extension

A minimal separately-installed extension at
`~/.pi/agent/extensions/conductor-uploader.ts`:

```ts
import {
  subscribeToRecords,
  type PersistedRecord,
} from "pi-conductor";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const serverUrl = process.env.CONDUCTOR_UPLOAD_URL;
  if (serverUrl === undefined) {
    pi.events.once("session_start", (_e, ctx) => {
      ctx.ui.notify(
        "conductor-uploader: CONDUCTOR_UPLOAD_URL not set; extension disabled",
        "warning",
      );
    });
    return;
  }

  // Live delivery: every record the host persists goes to the server.
  subscribeToRecords(async (record: PersistedRecord) => {
    const res = await fetch(serverUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(record),
    });
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  });

  // Backstop: on session_start, walk the log dir to ship records the
  // listener might have missed (consumer's watermark strategy lives in
  // this extension's own state file; the durable log is read via the
  // FileRecordLog implementation in pi-conductor's persistence module).
  pi.events.on("session_start", async () => {
    /* replayMissedRecords(serverUrl) — consumer-private */
  });
}
```

This sketch is informative only. The full consumer concern — auth, retry,
batching, watermark, and error policy — is the consumer's responsibility.
The spec's only commitment is that `subscribeToRecords` and the durable log
are sufficient to recover any record the emitter might have missed.

### The optional `pi.events` bridge

The `pi-conductor` extension additionally re-emits every record to pi's
documented event bus:

```ts
pi.events.on("conductor:record", (record) => { /* ... */ });
```

This is a thin wrapper over `subscribeToRecords` in `extensions/conduct.ts`
for consumers that prefer the `pi.events` API. Consumers that import
`subscribeToRecords` directly do not need the bridge. See the spec §8.5
note in [`src/host/record-emitter.ts`](src/host/record-emitter.ts) for
the rationale.

### What this is not

- **No upload code in `pi-conductor`.** No HTTP, no fetch, no network
  primitives. The grep-guard test
  (`tests/grep-guard.test.ts`) scans `src/host/` for the
  `@earendil-works/pi-coding-agent` import allowlist; the emitter does
  not change that surface.
- **No server config, no auth, no URL.** The consumer owns all of that.
- **No batching, no debouncing, no rate-limiting in the host.** The host
  fires every record to every listener. The consumer is free to batch on
  its side.
- **No promise of guaranteed delivery.** The emitter is best-effort; the
  durable JSONL log is the system of record for missed-record recovery.
- **No cross-process or cross-host coordination.** Each `pi` process has
  its own registry. The consumer is responsible for cross-process
  de-duplication (typically by record index or hash, using the per-run
  JSONL file as the source).
- **No emitter-specific record types.** The emitter is a transparent fan-out
  of the existing `PersistedRecord` union, including delegation records when
  delegation is enabled.
- **No change to the orchestration loop.** The host's `persistRecord` is
  the chokepoint; the loop does not need to know the emitter exists.

---

## Status & what's left

Full status is tracked in the authoritative specs:

- [`docs/orchestrator-fsm-spec.md`](docs/archive/orchestrator-fsm-spec.md) — the
  FSM engine.
- [`src/host/record-emitter.ts`](src/host/record-emitter.ts) — the
  typed in-process emitter (`subscribeToRecords`) and its consumer
  contract.

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

- **`def: MachineDefinition`** is the pinned manifest snapshot. `reduce` /
  `reduceLifecycle` are pure functions of `(checkpoint,
  event, def, meta)` —
  no ambient config, no I/O. `meta.role ===
  checkpoint.current_role` is
  asserted inside `reduce`; a mismatch is thrown, not trusted.
- **Every state change goes through `reduce`.** Cost-cap forced-close
  synthesizes a machine `end` event fed to `reduce`; the checkpoint is never
  mutated to `done` directly.
- **Checkpoint is snapshot-appended, never mutated in place.** Resume reads the
  latest snapshot from the host-owned `run_id`-keyed log. SDK branch scoping is
  not used.
- **`handoff`/`end` tools only validate + record intent** into a capture buffer
  and return a terminating message; they do **not** call `reduce` and do **not**
  persist. The loop owns `reduce` + persistence + spawning.
- **Post-emission sealing:** once a role's first valid `handoff`/`end` capture
  is recorded, the session is sealed — wrapped tools refuse to execute, so
  work-after-handoff cannot mutate the workspace.

The full authority is
[`docs/orchestrator-fsm-spec.md`](docs/archive/orchestrator-fsm-spec.md).

---

## Contributing

### Prerequisites

- Node.js ≥ 22.19.0, pnpm (matches the pi ecosystem). No npm/yarn.
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
  `src/cost`, `src/persistence` must not import
  `@earendil-works/pi-coding-agent`. `tests/grep-guard.test.ts` scans source as
  text and will fail `pnpm test` (and the pre-push hook) on a violation — a TS
  error can never mask it. `src/host`, `src/extension`, and `extensions/` may
  import pi (they're the only layers that bridge to the SDK). If you reach for
  the SDK in the core, stop; that code belongs in `src/host`.
- **Reducer purity.** `reduce` / `reduceLifecycle` take `def` and read roles +
  caps only from it — never from imports or globals.
- **One schema, TypeBox.** No Zod. The `handoff`/`end` TypeBox schemas are the
  single source of truth for tool args, seam validation, and the derived TS
  type. The peer-dependency declaration for `typebox` in `package.json` matches
  the name pi bundles — don't swap back to `@sinclair/typebox` (different
  package, would break tool-arg validation at runtime).
- **TypeScript strict**, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, ESM + NodeNext. No
  `any`. Named exports only.
- **Module size ~400 LOC ceiling.** Split by responsibility before a file gets
  large. Readability over cleverness.
- **No silent fallbacks.** Ambiguity → throw a typed error or surface a warning.
- **No `ctx.newSession()` / `ctx.fork` in `extensions/`.** Role sessions are
  spawned via the standalone `createAgentSession` only.
  `tests/extension/no-role-spawn-via-session-tree.test.ts` greps for these
  calls.

### Phases gate each other

Work is sequenced in phases; don't start the next phase until the current one is
green and its plan checkboxes are ticked. Per-phase human review is not a gate —
the overseer reviews specs up front and gives feedback at the end of the loop
(see _Operating model_ in `AGENTS.md`). Touch only what your task asks for;
surface assumptions before implementing; if a task is non-trivial and no spec
exists, write one. See `AGENTS.md` for the full working agreement.

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
biome.json            # linter + formatter (replaces ESLint + Prettier)
lefthook.yml          # git hooks: pre-push runs lint + typecheck + tests
pnpm-workspace.yaml   # pnpm config + supply-chain hardening (camelCase keys)
```

## License

MIT — see `LICENSE`.
