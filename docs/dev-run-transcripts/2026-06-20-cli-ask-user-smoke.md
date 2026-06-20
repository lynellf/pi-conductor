# Real-model smoke — `bin/conduct` CLI `ask_user` stdin fallback (2026-06-20)

> **Status:** Passed. The CLI's stdin readline reached the worker's
> `ask_user` tool as a normal dialog result, the worker used the
> answer as the `handoff` reason to the orchestrator, the orchestrator
> called `end`, and the run reached `done` cleanly with exit code 0.
>
> **Surface:** `node dist/bin/conduct.js <manifest> <goal>` (the CLI
> fallback from Task 7C.3), with `ask_user` falling back to a
> stdin-backed `ExtensionUIContext` stub wired in by the Phase 4
> Task 7 `createCliUiContext` helper (`src/bin/conduct.ts`). The
> extension's `/conduct` is the primary interactive surface; this
> CLI is the second launch surface for the same engine and the
> only non-TUI surface, so it needs a non-TUI degradation for
> `ask_user`.
>
> **Models used:** `openrouter:openrouter/fusion` for both roles
> (the only model configured in `~/.pi/agent/models.json` on the
> dev machine that ran this smoke). **No API keys, OAuth tokens,
> or provider secrets are included in this transcript** (none
> would be present in the run log anyway; auth lives in
> `~/.pi/agent/auth.json`, outside the conductor's per-run
> directory).

## Reproducing

From the repo root, after `pnpm install && pnpm build`:

```bash
cd scratch/phase-4-cli-ask-user-smoke
echo "open sesame" | node ../../dist/bin/conduct.js \
  conductor.yaml \
  "Smoke test the CLI ask_user stdin fallback"
```

The shell pipes the answer on stdin. The CLI's
`createCliUiContext(stdin, stdout)` helper constructs an
`ExtensionUIContext`-shaped stub whose `input()` method delegates
to `readline/promises#question`. When the worker calls `ask_user`
with `kind: "input"`, that stub prints the prompt to stdout and
reads a line from stdin. The tool returns the answer as a normal
non-terminating tool result; the worker then calls `handoff` with
`reason` = the user's exact answer.

## Observed output

The CLI prints the prompt (and the readline-echoed input) on one
line, then the final run-state line:

```
CLI ask_user smoke — type a short answer:: open sesame
pi-conductor: run_id=7f9234a1-38a1-41aa-9885-464fcab38b47 reached state=done reason=done
```

Exit code: **0**.

> **Note on the prompt's double colon.** The worker.md prompt ends
> with `:` (`"CLI ask_user smoke — type a short answer:"`); the
> CLI's `input()` helper appends another `: ` (its own prompt
> suffix). Readline echoes the user's input on the same line, so
> what lands on stdout is `<prompt>:: <answer>`. That is a
> cosmetic detail of the smoke manifest, not a bug.

> **Note on the `state=done reason=done` line.** The `reason` here
> is the run's `exitReason` (`"done" | "session_failed" | "aborted"`
> — the FSM's overall execution status), not the `end` tool's
> payload reason. The end tool's reason (`"cli ask_user round-trip
> complete"`) lives in the orchestrator's per-session JSONL, not
> in the final stdout line. The smoke README's "What success looks
> like" expected `reason=cli ask_user round-trip complete` on the
> stdout line; that wording is slightly off — it is the `end`
> tool's reason, not the run's `exitReason`.

## Observed result

- Run id: `7f9234a1-38a1-41aa-9885-464fcab38b47`
- Terminal state: `done`
- Exit code: 0
- Wall time: ~41s (records.jsonl first `updated_at` 1781968291712
  → last `updated_at` 1781968332335)
- Total usage (sum across all 3 sessions):
  - input: 36230 tokens
  - output: 402 tokens
  - cache_read: 0, cache_write: 0
  - cost: $0 (openrouter/fusion is a free-tier model on
    openrouter)
- Role path traversed:
  `orchestrator → worker → orchestrator → done`
- `ask_user` answer recorded in the worker's handoff reason:
  `open sesame` (verbatim, exactly the string the user typed
  into stdin)

## Scrubbed run-log highlights

### records.jsonl (18 lines, full transition table)

Path:
`/var/folders/.../pi-conductor-run-19IBaK/7f9234a1-38a1-41aa-9885-464fcab38b47.jsonl`
(the CLI defaults to `mkdtemp` for `FileRecordLog.baseDir` when
no `baseDir` is passed to `startRun`; the per-role session files
land under `<cwd>/.pi-conductor/runs/<runId>/sessions/` because
`ProductionHost.sessionDir` defaults to that path. The two
locations are by design — see "What surprised me" below.)

| # | `ts` (epoch ms) | Record type             | Key fields |
|---|---|---|---|
| 1  | 1781968291712 | `checkpoint_snapshot`     | `current_role=orchestrator`, `active_role_session=null` |
| 2  | 1781968291735 | `session_started`         | role=orchestrator, visit_index=1, model=openrouter:openrouter/fusion |
| 3  | 1781968291735 | `checkpoint_snapshot`     | `current_role=orchestrator`, active session set |
| 4  | 1781968302024 | `transition_accepted`     | handoff orchestrator→worker, guard `visit_count[worker] < max_visits[worker]`, effect `visit_count[worker] += 1` |
| 5  | 1781968302024 | `checkpoint_snapshot`     | `current_role=worker`, `visit_count[worker]: 1` |
| 6  | 1781968302024 | `session_ended`           | role=orchestrator, usage: input=9039, output=132, cost=0 |
| 7  | 1781968302024 | `checkpoint_snapshot`     | active_role_session=null |
| 8  | 1781968302037 | `session_started`         | role=worker, visit_index=1 |
| 9  | 1781968302037 | `checkpoint_snapshot`     | `current_role=worker`, active session set |
| 10 | 1781968322256 | `transition_accepted`     | handoff worker→orchestrator (effect: `[]` — the reducer emitted no visit-count mutation) |
| 11 | 1781968322256 | `checkpoint_snapshot`     | `current_role=orchestrator` |
| 12 | 1781968322257 | `session_ended`           | role=worker, usage: input=18076, output=213, cost=0 |
| 13 | 1781968322257 | `checkpoint_snapshot`     | active_role_session=null |
| 14 | 1781968322277 | `session_started`         | role=orchestrator, visit_index=2 |
| 15 | 1781968322277 | `checkpoint_snapshot`     | `current_role=orchestrator`, active session set |
| 16 | 1781968332335 | `transition_accepted`     | end orchestrator→done |
| 17 | 1781968332335 | `checkpoint_snapshot`     | `current_role=done` |
| 18 | 1781968332335 | `session_ended`           | role=orchestrator, usage: input=9115, output=57, cost=0 |

> **Note on `transition_accepted` and the `reason` field.** The
> host-owned records.jsonl `transition_accepted` records do not
> carry a `reason` field directly — they have
> `payload_summary: { field_names: [] }`. The handoff reason
> (`"open sesame"`) lives in the worker's per-session JSONL as
> the `handoff` tool-call arguments. That is by design: the
> reducer never branches on payload content (§3/§4), and the
> per-session JSONL is the durable record of what the model
> actually emitted. To prove the round-trip, look at the worker
> session log (next subsection), not the records.jsonl.

### Worker session JSONL (the `ask_user` round-trip proof)

Path:
`scratch/phase-4-cli-ask-user-smoke/.pi-conductor/runs/7f9234a1-38a1-41aa-9885-464fcab38b47/sessions/2026-06-20T15-11-42-036Z_019ee596-6fd4-7383-88a0-89f02857dd04.jsonl`

| Step | Role | Type | Key content |
|---|---|---|---|
| 1 | user (system) | text | `[handoff → worker]` user-prompt header |
| 2 | assistant | text | "I'll start by asking the user for input as instructed." |
| 3 | assistant | toolCall | `ask_user({ kind: "input", prompt: "CLI ask_user smoke — type a short answer:" })` |
| 4 | toolResult | text | "open sesame" |
| 5 | assistant | text | "The user answered 'open sesame'. Now handing off to the orchestrator with their exact answer." |
| 6 | assistant | toolCall | `handoff({ target_role: "orchestrator", reason: "open sesame" })` |
| 7 | toolResult | text | "emission recorded: handoff → orchestrator. Do not call further tools; the loop will end this session." |

The `reason: "open sesame"` on step 6 is the literal string the
user typed into the CLI's stdin — verbatim, byte-for-byte. That
is the proof the CLI's `createCliUiContext.input()` stub
reached the tool's execute ctx and the answer round-tripped
through the worker's `handoff` payload.

## What worked

- The CLI's `createCliUiContext(stdin, stdout)` helper (in
  `src/bin/conduct.ts`) constructed an `ExtensionUIContext`-shaped
  stub whose `input()` delegates to
  `readline/promises#question`. The stub passed type-validation
  when wired into `createProductionHost({ extension: { uiContext } })`
  — the `ProductionHost` accepts the same `uiContext` shape the
  TUI passes.
- The `ProductionHost` threaded that `uiContext` into
  `AgentSession.bindExtensions({ uiContext })` exactly as the
  TUI does. The `ask_user` tool's execute ctx received the same
  `ctx.ui` shape, so the tool code is unchanged from the TUI
  path.
- The `readline.question` call wrote the prompt to `process.stdout`
  and read "open sesame\n" from the piped stdin, returning
  "open sesame" (no trailing newline). Readline's default echo
  is on (because `output === process.stdout` is a TTY, so
  `terminal: true` defaults), so the user sees the answer
  echoed back on the same line.
- The worker's `handoff` tool-call arguments captured the
  answer verbatim as `reason: "open sesame"`. The reducer
  recorded the `transition_accepted` for `worker → orchestrator`
  with `payload_summary: { field_names: [] }` (the reducer never
  branches on payload content — the records.jsonl shape is
  stable, the rich payload is in the per-session JSONL).
- The orchestrator's second visit saw `next_candidates: empty`
  (the worker is at `visit_count = max_visits = 1`) and called
  `end` with `reason: "cli ask_user round-trip complete"` —
  exactly as the smoke manifest prescribed.
- The CLI's existing argv parsing + manifest-existence check
  fired cleanly (no false positives). The final stdout line
  matches the established `pi-conductor: run_id=… reached
  state=… reason=…` shape. Exit code 0.
- The `pnpm test` run stays at 47 files / 446 tests, all green,
  including the dedicated `tests/bin/conduct.test.ts` case
  (`"threads a stdin-backed UI context into the CLI production
  host for ask_user"`) that asserts `uiContext?.input(...)` on
  the constructed `ProductionHost` reads a known string from a
  piped stdin. The smoke confirms the test in production.

## What surprised me

- **The smoke README's expected stdout line was slightly
  misleading.** The README said the line would end with
  `state=done reason=cli ask_user round-trip complete`, but the
  final stdout line uses the run's `exitReason` (`"done"` or
  `"session_failed"`), not the `end` tool's payload reason.
  The `end` tool's reason (`"cli ask_user round-trip complete"`)
  is recorded in the orchestrator's per-session JSONL, not on
  the final stdout line. The README's "What success looks like"
  section should be tightened on a future pass — the right
  proof is in the worker session's handoff reason and the
  orchestrator session's `end` reason, not on the CLI's final
  log line.
- **`transition_accepted` records don't carry a `reason` field.**
  The smoke README's success criteria #3 said the records.jsonl
  would contain a `transition_accepted` for `worker → orchestrator`
  whose `reason` field is "open sesame". That's not how
  `transition_accepted` is shaped — the field is
  `payload_summary: { field_names: [] }` because the reducer
  never branches on payload content (§3/§4). The handoff reason
  is durable in the worker's per-session JSONL, not in
  records.jsonl. The smoke README's success-criteria list
  could be tightened to point at the right artifact.
- **The CLI splits storage across two paths by design.** The
  per-role session JSONLs land in
  `<cwd>/.pi-conductor/runs/<runId>/sessions/` (driven by
  `ProductionHost.sessionDir`'s default), while the host-owned
  records.jsonl lands in `mkdtemp(join(tmpdir(),
  "pi-conductor-run-XXXX"))` (driven by `startRun`'s default
  `baseDir` resolution when the CLI passes none). This is
  consistent with the 2026-06-19 CLI smoke's "What surprised
  me" note: the CLI is intentionally a one-shot, ephemeral
  surface, so its records.jsonl is in `mkdtemp` (and the
  filesystem may reclaim it on reboot). The per-project
  `<cwd>/.pi-conductor/runs/<runId>/sessions/` is where
  `/conduct:list` / `/conduct:resume` look, but `/conduct`'s
  CLI is not that surface. That split is fine for the smoke
  (it has the run_id from the stdout line and can re-derive
  the run directory), but it means a future CLI ergonomics
  improvement might want to pin `baseDir` to the same
  project-relative path for one-shot runs. Not a v1 gate.

## Discovered issues (none blocking)

- None. The run completed cleanly with the expected terminal
  state. No `extra_emission`, no `no_emission`, no model
  fallback, no cost-cap forced-close, no `AskUserUnavailableError`.
  The CLI's stdin readline fallback works end-to-end.

## Why this transcript exists

This is the **Phase 4 Task 7 manual smoke**, captured in
`scratch/phase-4-cli-ask-user-smoke/`. The TUI bridge spec
(§"Pinned SDK surfaces") lists the CLI as the only non-TUI
surface and the Phase 4 sub-plan Task 7 is the
`ask_user` degradation for that surface. The Phase 3 TUI
`ask_user` smoke (`2026-06-20-tui-bridge-ask-user-smoke.md`)
covered the dialog path; this transcript covers the stdin
readline fallback so the bridge is verified against both
launch surfaces.
