# Dev-run transcripts

Manual real-model smoke transcripts. Per `docs/extension-pivot-plans/phase-7a-production-host.md` Task 7A.5:

> A real-model run against the developer's pi auth/config reaches a
> terminal state: orchestrator → worker → orchestrator → end.

This is a **manual** step that requires:
- `~/.pi/agent/auth.json` populated with a working provider (Anthropic,
  OpenAI, OpenRouter, etc.)
- ~5 minutes of wall time for the run + transcript
- A two-role manifest (see `tests/fixtures/default-conductor/` for a
  starting point)

When the smoke is run, the transcript goes here. The transcript
MUST NOT contain API keys, OAuth tokens, or any other provider
secrets. Recommended capture format:
- The exact `pnpm` / `node` command used to start the run.
- A scrubbed copy of the agent's `console.log` output (or the
  `pi` session's transcript export).
- A 1-paragraph "what worked, what surprised me" summary.

Status: **pending** — no transcript yet. Will be added when a
real-model run is performed.
