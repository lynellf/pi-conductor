# Dev-run transcripts

Manual real-model smoke transcripts. Per
`docs/extension-pivot-plans/phase-7c-packaging-distribution-docs.md` Task 7C.2
(relocated from `phase-7a-production-host.md` Task 7A.5):

> A real-model run against the developer's pi auth/config reaches a
> terminal state: orchestrator → worker → orchestrator → end.

## Captured

| Date | Surface | Transcript |
|---|---|---|
| 2026-06-19 | `bin/conduct` (Task 7C.3 CLI fallback) | [`2026-06-19-cli-real-model-smoke.md`](2026-06-19-cli-real-model-smoke.md) |
| 2026-06-20 | `/conduct` (`ask_user` smoke) | [`2026-06-20-tui-bridge-ask-user-smoke.md`](2026-06-20-tui-bridge-ask-user-smoke.md) |
| 2026-06-20 | `bin/conduct` (`ask_user` stdin readline fallback, Phase 4 Task 7) | [`2026-06-20-cli-ask-user-smoke.md`](2026-06-20-cli-ask-user-smoke.md) |

The first transcript ran the CLI against `openrouter:openrouter/fusion`
against the developer's configured `~/.pi/agent/auth.json`. Three sessions
(orchestrator → worker → orchestrator → done) in ~30s, $0 cost. The full
transition table is in the transcript file.

## What the smoke needs

This is a **manual** step that requires:
- `~/.pi/agent/auth.json` populated with a working provider (Anthropic,
  OpenAI, OpenRouter, etc.)
- ~5 minutes of wall time for the run + transcript
- A two-role manifest (see `tests/fixtures/default-conductor/` for a
  starting point)

When the smoke is run, the transcript goes here. The transcript
MUST NOT contain API keys, OAuth tokens, or any other provider secrets.
Recommended capture format:
- The exact `pnpm` / `node` / `pi install` command used to start the run.
- A scrubbed copy of the agent's `console.log` output (or the
  `pi` session's transcript export).
- A 1-paragraph "what worked, what surprised me" summary.

## Status

✅ **Phase 7C.2 smoke captured** (`2026-06-19-cli-real-model-smoke.md`).
✅ **Phase 3 ask_user smoke captured** (`2026-06-20-tui-bridge-ask-user-smoke.md`).
✅ **Phase 4 Task 7 CLI ask_user stdin fallback smoke captured** (`2026-06-20-cli-ask-user-smoke.md`).
The CLI fallback surface from Task 7C.3 was used for the first transcript;
the extension's `/conduct` is the user-facing equivalent for interactive
runs (exercised separately during `pi install -l ./` install proof in the
Task 7C.2 commit). The third transcript verifies the CLI's stdin readline
degradation for `ask_user` (Phase 4 Task 7) — the only non-TUI surface
needs a non-TUI degradation for the dialog, and this transcript proves it
works end-to-end against the real model.
