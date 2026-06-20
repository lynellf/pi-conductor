# Phase 4 — Degradation and docs

> Sub-plan of `docs/tui-bridge-plan.md`. Read the parent plan first for the
> overview, architecture decisions, dependency graph, risks, open questions, and
> whole-plan verification. Source spec: `docs/tui-bridge-spec.md` Boundaries and
> Resolved Questions.
>
> **Status:** Implementation complete including the Task 7 manual real-model
> CLI smoke (`docs/dev-run-transcripts/2026-06-20-cli-ask-user-smoke.md`);
> audit release gate remains blocked by pre-existing transitive advisories.
>
> **Scope:** Define non-TUI degradation for `ask_user`, update the pinned SDK
> surface documentation, document the user-facing streaming/input behavior, and
> fix the sample role tool allowlists called out by the parent plan.

## Gate

- [x] Phase 3 complete (green + checkboxes ticked).
- [x] Real-model smoke transcript from Task 6 filed or explicitly deferred with
      a reason.

## Tasks

- [x] **Task 7: CLI fallback degradation for `ask_user`**
  - Description: The CLI (`src/bin/conduct.ts`) is the only non-TUI conductor
    surface. When `ask_user` is called there, fall back to stdin readline
    (prompt printed to stdout; answer read from stdin). For any future
    rpc/json/print surface, `ask_user` throws `AskUserUnavailableError`.
    Implement the CLI readline by passing a stdin-backed
    `ExtensionUIContext`-shaped stub as `uiContext` (or through the Phase 1
    queue branch) so the tool code is unchanged.
  - Acceptance:
    - [x] `node dist/bin/conduct.js <manifest> <goal>` with an
          `ask_user`-calling role prints the prompt to stdout, reads the answer
          from stdin, and continues.
    - [x] Exit codes unchanged (0 terminal; 1 error; 3 missing manifest).
  - Verification:
    - [x] Manual CLI run with an `ask_user` role; answer via stdin.
          Transcript: [`docs/dev-run-transcripts/2026-06-20-cli-ask-user-smoke.md`](../dev-run-transcripts/2026-06-20-cli-ask-user-smoke.md).
    - [x] `pnpm build` emits `dist/bin/conduct.js`; existing CLI tests green.
  - Dependencies: Task 6.
  - Files likely touched:
    - `src/bin/conduct.ts`
    - `src/host/ask-user-tool.ts` (only if a shared stub/adapter type is needed)
  - Estimated scope: S

- [x] **Task 8: Docs + `sdk-surface.md` pinned surfaces**
  - Description: Update `docs/extension-usage.md` to document streaming +
    `ask_user` for users, and fix the `records.jsonl` layout diagram (Finding 3
    from the 2026-06-20 run: the file is a flat `<runId>.jsonl` sibling of the
    run directory, not `<runId>/records.jsonl` inside it). Update
    `docs/sdk-surface.md` with the newly pinned surfaces (`uiContext`,
    `ExtensionUIContext.input` / `confirm` / `select`,
    `ExtensionAPI["sendMessage"]`, `ToolDefinition.execute` ctx,
    `CustomMessageComponent` default markdown rendering). Fix the sample
    bundles' `tools:` lists in `scratch/sample-roles/` so reviewers/fixers
    actually have `read` / `edit` / `write` as appropriate.
  - Acceptance:
    - [x] `docs/extension-usage.md` has a Streaming section and an `ask_user`
          section; the run-log layout diagram matches on-disk reality.
    - [x] `docs/sdk-surface.md` records the four pinned surfaces from the TUI
          bridge spec.
    - [x] `scratch/sample-roles/code-review/` worker `tools:` lists include
          `read` / `edit` / `write` as appropriate.
  - Verification:
    - [x] Docs describe shipped streaming + `ask_user` behavior.
    - [x] `pnpm lint && pnpm format:check` clean.
  - Dependencies: Tasks 4 and 6, so the docs describe shipped behavior.
  - Files likely touched:
    - `docs/extension-usage.md`
    - `docs/sdk-surface.md`
    - `scratch/sample-roles/code-review/conductor.yaml`
  - Estimated scope: S

## Checkpoint — TUI bridge complete

- [x] CLI fallback either works through stdin readline or is explicitly
      documented as `AskUserUnavailableError` if readline proves too fiddly.
      Stdin readline works (Task 7 + 2026-06-20 smoke transcript).
- [x] User-facing docs describe streaming and `ask_user`.
- [x] `sdk-surface.md` records the pinned TUI bridge surfaces.
- [x] Sample role tool allowlists match the intended review/fix workflows.
- [x] Full suite green; grep guard green.
- [x] Ready for final review at loop close and the pre-push hook
      (`pnpm lint && pnpm typecheck && pnpm test`).

## Current verification notes

- `pnpm exec vitest run tests/bin/conduct.test.ts --maxWorkers=1
  --no-file-parallelism` green (10 tests), including stdin-backed CLI
  `uiContext` coverage for `ask_user`.
- `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm lint`, and
  `pnpm format:check` green. Full suite: 47 files / 446 tests.
- Built CLI missing-manifest smoke:
  `node dist/bin/conduct.js /tmp/pi-conductor-missing-manifest.yaml "goal"`
  exits `3`.
- **Task 7 manual real-model CLI smoke** (2026-06-20): the
  `scratch/phase-4-cli-ask-user-smoke/` 2-role manifest reaches
  `state=done` cleanly with the worker's `ask_user` round-tripping
  the stdin answer (`open sesame`) into the worker's `handoff`
  reason and the orchestrator's `end` reason. Full transcript with
  records.jsonl + per-session JSONL highlights:
  [`docs/dev-run-transcripts/2026-06-20-cli-ask-user-smoke.md`](../dev-run-transcripts/2026-06-20-cli-ask-user-smoke.md).
- `pnpm audit` fails on pre-existing transitive advisories:
  `undici >=8.0.0 <8.5.0` via `@earendil-works/pi-coding-agent` (3 high,
  2 moderate, 2 low) and `esbuild >=0.27.3 <0.28.1` via Vitest/Vite (1 low).
  Release requires dependency upgrade or explicit risk acceptance.
