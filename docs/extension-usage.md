# Extension usage — `/conduct` and friends

> User-facing surface for the pi extension (`extensions/conduct.ts`).
> The engine is the SDK host driver in `src/host/`; the extension
> is the UX shell that calls it. Spec authority:
> `docs/orchestrator-fsm-spec.md` (§11.1, §11.8, §11.9). Pivot
> plan: `docs/extension-pivot-plan.md`.

## Install

```bash
# From the pi-conductor checkout (dev):
pi install -l ./         # project-local (recommended for testing)

# Once published:
pi install npm:pi-conductor
pi install git:github.com/you/pi-conductor
```

After install, `pi list` shows the package:

```text
Project packages:
  ..
    /Users/you/Code/pi-conductor
```

## Commands

| Command | What it does |
|---|---|
| `/conduct <goal>` | Start a run for `<goal>` using the manifest resolved per the rule below. |
| `/conduct:resume <run_id>` | Resume a previously-started run by `run_id`. |
| `/conduct:list` | List known runs in the conductor's per-project log directory. |
| `/conduct:abort` | Abort the active run in this extension process. |

All four commands are thin handlers around `startRun` / `resumeRun` /
`listRuns` / `RunHandle.abort()` (the library API in
`src/host/api.ts`). They never call `ctx.newSession()` or `ctx.fork()`;
role sessions are spawned by the production `Host` via the standalone
`createAgentSession` (the §9.5 boundary). A grep guard on
`extensions/**/*.ts` rejects those two calls.

## Flags

| Flag | Effect |
|---|---|
| `--conduct-manifest <path>` | Override the default manifest path. Default: `<cwd>/.pi/conductor.yaml`. |

The flag is read at command time (not at extension-factory time), so a
`--flag` set on the pi CLI line flows into the handler invocation:

```bash
pi --conduct-manifest ./experiments/quick-fix.yaml
# then inside pi:
/conduct ship the quick fix
```

## Manifest path resolution

The manifest path is resolved by `src/extension/manifest.ts`:

1. If `--conduct-manifest <path>` is set on the pi CLI line, that path
   is used (resolved against `ctx.cwd`).
2. Otherwise, `<ctx.cwd>/.pi/conductor.yaml` is used.
3. If neither resolves to a file on disk, the handler notifies a
   warning with both tried paths and returns without touching the
   active-run tracker. **No run is started.**

## Status surface

While a run is active, the extension renders a status line in the pi
TUI footer via `ctx.ui.setStatus("conduct", "<text>")`. The line
updates on every status-poller tick (250 ms) and clears on terminal
completion or on handler failure (the poller's `stop()` clears the
line in addition to clearing the interval timer — guaranteed clean
teardown regardless of which tick last ran).

The status text is a one-line summary of `RunHandle.runStats()`:
current role, visits remaining per worker, cost spent, budget
remaining, terminal flag. The format is owned by
`formatConductStatus` in `src/extension/status.ts`.

When `/conduct` reaches a terminal state, the handler notifies
`pi-conductor run_id=<id> reached terminal state=<role> reason=<reason>`
to `ctx.ui.notify`. On failure, the notification is the typed error
message (`ModelNotFoundError`, `SystemPromptNotFoundError`, …).

## Run log location

Role session files land under `<cwd>/.pi-conductor/runs/<runId>/sessions/`,
not under pi's session directory. The conductor's run-keyed log is
written to the same directory:

```
<cwd>/.pi-conductor/
  runs/
    <run-id-1>/
      records.jsonl        # host-owned run log (one file per run)
      sessions/            # per-role session files (the SDK's JSONL)
        <timestamp>_<session-id>.jsonl
    <run-id-2>/
      ...
```

This convention matches the production host's session-dir default
(Phase 7A.3). The directory is `mkdirSync`'d on the first
`/conduct` invocation; it is idempotent.

`/conduct:list` enumerates the `run_id`s known to this directory.
`/conduct:resume <run_id>` resumes a run by reading the latest
checkpoint snapshot for `<run_id>` from `records.jsonl` and
re-entering the loop at `current_role`.

## Worker role sessions are NOT `/switch` targets

The orchestrator's worker role sessions are **independent SDK
sessions**, not part of pi's session tree:

- Each worker invocation is a fresh `createAgentSession` call,
  with a file-backed `SessionManager` rooted in the conductor's
  per-run directory.
- The conductor's `run_id`-keyed log is the host-owned append-only
  record; role session files are the SDK's own JSONL files. Neither
  is in pi's session tree.
- **You cannot `/switch` to a worker role session.** The session id
  exists in the conductor's per-run directory but is invisible to
  pi's session switcher. `/switch` shows pi sessions only.
- The `parent_session` field on `session_started` records (§11.4)
  links the role sessions into a tree within a single run, but the
  tree is the conductor's bookkeeping, not pi's.

If you want to inspect a worker's transcript after a run, look at
`<cwd>/.pi-conductor/runs/<run_id>/sessions/<timestamp>_<session-id>.jsonl`
directly. There is no `/tree` (yet) — the conductor owns its own
log navigation.

This is by design (spec §9.5; pivot plan §1). Putting role sessions
in pi's session tree would reopen §9.5 and break the host-owned
`run_id`-keyed log (§11.1).

## CLI fallback (non-pi surface)

The package also ships a thin CLI for non-pi consumers:

```bash
node dist/bin/conduct.js <manifestPath> <goal...>
```

Same engine (`startRun` + production `Host`); no TUI wiring. Exit
codes:

- `0` — terminal state reached
- `1` — orchestration error (model not found, manifest parse error, …)
- `2` — usage error (missing argv)
- `3` — manifest file does not exist on disk

See `src/bin/conduct.ts` for the 100-line implementation.

## Library use (advanced)

The extension and CLI are thin wrappers. The same engine is
importable directly:

```ts
import {
  startRun,
  resumeRun,
  listRuns,
  createProductionHost,
} from "pi-conductor";

const handle = await startRun(".pi/conductor.yaml", {
  goal: "ship a fix",
  hostFactory: (ctx) =>
    createProductionHost({
      extension: { modelRegistry: /* pi's ModelRegistry */, cwd: process.cwd() },
      run: { log: ctx.log, loadedManifest: ctx.loadedManifest, runId: ctx.runId },
    }),
});

const { finalCheckpoint, exitReason } = await handle.completion();
```

You can also implement a custom `Host` against the interface in
`src/host/host.ts` if you need different session / persistence
semantics.
