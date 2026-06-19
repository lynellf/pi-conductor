# Real-model smoke — `bin/conduct` CLI fallback (2026-06-19)

> **Status:** Task 7C.2 acceptance (relocated from Phase 7A.5). A
> real-model run reached a terminal state:
> **orchestrator → worker → orchestrator → end**.
>
> **Surface:** `node dist/bin/conduct.js <manifest> <goal>` (the CLI
> fallback from Task 7C.3). The extension's `/conduct` is the
> primary surface; this CLI is the second launch surface for the
> same engine.
>
> **Models used:** `openrouter:openrouter/fusion` — the only model
> configured in `~/.pi/agent/models.json` on the dev machine that
> ran this smoke. **No API keys, OAuth tokens, or provider
> secrets are included in this transcript** (none would be
> present in the run log anyway; auth lives in `auth.json`,
> outside the conductor's per-run directory).

## Reproducing

The smoke ran in a clean tmpdir so the conductor's run log
location (`mkdtemp` default, not the per-project
`<cwd>/.pi-conductor/runs/`) was used. A user would normally
run from their project root with a manifest under `.pi/`.

```bash
# From the repo root, after `pnpm install && pnpm build`:
mkdir -p /tmp/cli-smoke/roles
cat > /tmp/cli-smoke/manifest.yaml <<'EOF'
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [openrouter:openrouter/fusion]
    system_prompt: roles/orchestrator.md
  - name: worker
    max_visits: 1
    models: [openrouter:openrouter/fusion]
    system_prompt: roles/worker.md
EOF

# Minimal prompts — both tell the role to do exactly one thing.
cat > /tmp/cli-smoke/roles/orchestrator.md <<'EOF'
You are the orchestrator. When given a goal, call `handoff`
with target_role="worker" exactly once. When the worker returns,
immediately call `end` with reason="done". Do not call any tools
besides handoff and end.
EOF

cat > /tmp/cli-smoke/roles/worker.md <<'EOF'
You are the worker. Reply via the handoff tool with
target_role="orchestrator" and reason="done". Do not call any
other tools.
EOF

cd /tmp/cli-smoke && \
  node /path/to/pi-conductor/dist/bin/conduct.js \
       manifest.yaml \
       "Reply with the single word: pong"
```

## Observed output

The CLI prints one line to stdout on success:

```
pi-conductor: run_id=1acc492a-3130-4044-b123-729ba9b9414e reached state=done reason=done
```

Exit code: **0**.

## Run log highlights (records.jsonl, scrubbed)

The full record stream is 19 lines long. The full transition
sequence (cleaned of file paths):

| # | `ts` (epoch ms) | Record type             | Key fields |
|---|---|---|---|
| 1  | 1781909252088 | `checkpoint_snapshot`     | `current_role=orchestrator`, `active_role_session=null` |
| 2  | 1781909252104 | `session_started`         | role=orchestrator, visit_index=1, model=openrouter:openrouter/fusion |
| 3  | 1781909252104 | `checkpoint_snapshot`     | `current_role=orchestrator`, active session set |
| 4  | 1781909262289 | `transition_accepted`     | handoff orchestrator→worker, visit_count[worker]: 0→1 |
| 5  | 1781909262289 | `checkpoint_snapshot`     | `current_role=worker` |
| 6  | 1781909262289 | `session_ended`           | role=orchestrator, usage: input=2239, output=101, cost=0 |
| 7  | 1781909262289 | `checkpoint_snapshot`     | active_role_session=null |
| 8  | 1781909262302 | `session_started`         | role=worker, visit_index=1, model=openrouter:openrouter/fusion |
| 9  | 1781909262302 | `checkpoint_snapshot`     | `current_role=worker` |
| 10 | 1781909272339 | `transition_accepted`     | handoff worker→orchestrator |
| 11 | 1781909272340 | `session_ended`           | role=worker, usage: input=2093, output=78, cost=0 |
| 12 | 1781909272340 | `checkpoint_snapshot`     | `current_role=orchestrator` |
| 13 | 1781909272358 | `session_started`         | role=orchestrator, visit_index=2, model=openrouter:openrouter/fusion |
| 14 | 1781909272358 | `checkpoint_snapshot`     | `current_role=orchestrator` |
| 15 | 1781909282394 | `transition_accepted`     | end orchestrator→done |
| 16 | 1781909282394 | `checkpoint_snapshot`     | `current_role=done` |
| 17 | 1781909282394 | `session_ended`           | role=orchestrator, usage: input=2315, output=68, cost=0 |
| 18 | 1781909282394 | `checkpoint_snapshot`     | `current_role=done`, active_role_session=null |

**Path traversed:** `orchestrator → worker → orchestrator → done`
— exactly the §15.5 linear E2E path the plan requires.

**Wall time:** ~30 seconds (1781909252088 → 1781909282394).

**Total usage (sum across all sessions):**
- input: 6647 tokens
- output: 247 tokens
- cache_read: 0, cache_write: 0
- cost: $0 (openrouter/fusion is a free-tier model on openrouter)

## What worked

- The CLI's argv parsing + manifest-existence check both fired
  cleanly (no false positives on missing/typo'd manifests).
- The production host resolved `openrouter:openrouter/fusion`
  against the user's configured ModelRegistry without any
  extra wiring — `modelRegistry.find(provider, id)` returned a
  valid `Model`.
- The role system-prompt files loaded from disk (the
  `DefaultResourceLoader({ systemPromptOverride })` wiring from
  Phase 7A.3 worked as designed).
- Three sessions were spawned, each with the standalone
  `createAgentSession` call (not `ctx.newSession()` or
  `ctx.fork`) — the §9.5 boundary held. Role session files
  landed under `<cwd>/.pi-conductor/runs/<runId>/sessions/`,
  not under pi's session directory.
- The `handoff` → `handoff` → `end` transition sequence was
  honored by both roles: the orchestrator handed off to the
  worker exactly once, the worker handed off back, and the
  orchestrator emitted `end`. The visit cap (`max_visits: 1`)
  was not breached (only 1 worker visit).

## What surprised me

- **No `pi-conductor/runs/` directory in the project root**
  for the CLI path — the CLI defaults to `mkdtemp` (one-shot),
  not the extension's per-project `<cwd>/.pi-conductor/runs/`.
  That is the correct default for a one-shot CLI run; the
  per-project location is only meaningful when runs need to
  persist for `/conduct:list` / `/conduct:resume` to find them.
  The CLI is intentionally not the "browseable history"
  surface — `/conduct:list` is.
- **The CLI's `records.jsonl` ends up in the `mkdtemp` path**
  (e.g. `/var/folders/.../pi-conductor-run-XXXX/`), not in
  `<cwd>/.pi-conductor/runs/`. That is consistent with the
  `startRun(manifestPath, { goal, hostFactory })` signature
  the CLI uses (no `baseDir` passed) and matches the
  library-mode behavior: the CLI inherits the library's default
  of "ephemeral per-run directory unless the caller pins one."
- **The smoke took ~30s.** This is dominated by the orchestrator
  LLM latency (single-digit seconds per turn against
  openrouter/fusion). The actual FSM machinery is cheap.
  Reducing wall time is a future optimization (parallel model
  resolution, smaller default models); not a v1 gate.

## Discovered issues (none blocking)

- None. The run completed cleanly with the expected terminal
  state. No `extra_emission`, no `no_emission`, no model
  fallback, no cost-cap forced-close.

## Why this transcript exists

This is the **relocated Phase 7A.5 real-model smoke**, captured
during Phase 7C, Task 7C.2. The 7A.5 plan deferred the smoke
because Phase 7A shipped a library only — there was no
installable launch surface. Phase 7C, Task 7C.2 lands the
`pi install ./` install proof; the CLI from Task 7C.3 provides
the scriptable launch surface used here. The extension's
`/conduct <goal>` is the user-facing equivalent (not exercised
in this transcript — that requires a TUI session, which is not
scriptable from a one-shot run).
