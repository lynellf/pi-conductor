# Dev-run transcripts

Manual real-model smoke transcripts. Per
`docs/extension-pivot-plans/phase-7c-packaging-distribution-docs.md` Task 7C.2
(relocated from `phase-7a-production-host.md` Task 7A.5):

> A real-model run against the developer's pi auth/config reaches a
> terminal state: orchestrator → worker → orchestrator → end.

## When this is runnable

This step is **structurally deferred** until Phase 7C, Task 7C.2 lands.
Phase 7A ships a library only — there is no `bin`, no `extensions/`
entrypoint, and no installable launch surface, so a real-model run cannot be
started from the shell until `/conduct` is available after `pi install ./`.
Phase 7B's `pi -e ./extensions/conduct.ts` is a dev/subprocess mode, not an
install; the user-facing install arrives in 7C.2. Do **not** attempt the smoke
before 7C.2 — there is nothing to invoke.

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

**Pending — blocked on Phase 7C, Task 7C.2** (`pi install ./` exposes
`/conduct`). No transcript yet. Will be added when a real-model run is
performed after install is available.
