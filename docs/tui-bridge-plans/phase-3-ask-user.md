# Phase 3 — Feature B: `ask_user`

> Sub-plan of `docs/tui-bridge-plan.md`. Read the parent plan first for the
> overview, architecture decisions, dependency graph, risks, open questions, and
> whole-plan verification. Source spec: `docs/tui-bridge-spec.md` Invariant B.
>
> **Status:** Draft — not started.
>
> **Scope:** Add `ask_user` as a normal, non-terminating host tool available to
> every role. It is FSM-orthogonal: it writes nothing to the `SessionSeam`
> capture buffer, emits no machine event, and does not change reducer behavior.

## Gate

- [x] Phase 2 complete (green + checkboxes ticked).
- [x] Phase 1 bridge path is stable enough for a role tool to reach the UI
      surface or queue. (Verified end-to-end by Phase 2's live streaming manual run — the bridge delivers `DisplayEvent`s through the same `uiContext` path a role tool would use.)

## Tasks

- [ ] **Task 5: `createAskUserTool`**
  - Description: New `defineTool` factory in `src/host/ask-user-tool.ts`
    (split from `tools.ts` to respect the ~400 LOC ceiling). Parameters
    (TypeBox): `kind` (`input` | `confirm` | `select`), `prompt`, and
    select-options when `kind === "select"`. `execute` calls
    `ui.input` / `ui.confirm` / `ui.select` and returns the answer as a normal
    (non-`terminate`) tool result. When no usable UI is present, throw a typed
    `AskUserUnavailableError` rather than silently no-oping. Writes nothing to
    the `SessionSeam` capture buffer.
  - Acceptance:
    - [ ] `ask_user` with `kind: "input"` returns the user's text.
    - [ ] `kind: "confirm"` returns a boolean-shaped result.
    - [ ] `kind: "select"` returns the chosen option.
    - [ ] With no UI, throws `AskUserUnavailableError`.
    - [ ] Calling `ask_user` writes nothing to a `SessionSeam` capture buffer
          (verified: buffer length unchanged after a call).
    - [ ] `ask_user` returns `terminate: false`; the turn continues.
  - Verification:
    - [ ] `pnpm test -- host/ask-user-tool` (NEW): stub UI with canned
          `input` / `confirm` / `select`; assert results, no-UI throw, and the
          capture-buffer-untouched invariant.
    - [ ] `pnpm typecheck && pnpm build && pnpm test && pnpm lint` green.
  - Dependencies: Phase 1 bridge (the tool reaches UI through direct
    `uiContext` or the contingency queue).
  - Files likely touched:
    - `src/host/ask-user-tool.ts` (NEW)
    - `src/host/errors.ts`
    - `tests/host/ask-user-tool.test.ts` (NEW)
  - Estimated scope: S

- [ ] **Task 6: Wire `ask_user` into `spawnRole`**
  - Description: In `ProductionHost.spawnRole`, add `askUserTool` to the
    `customTools` array alongside `handoff` / `end`, and add `"ask_user"` to the
    `tools` allowlist (force-injected like `handoff` / `end` via
    `buildToolsAllowlist`). The tool is available to every role regardless of
    manifest `tools:`. Verify a real `/conduct` run where a role calls
    `ask_user`, the user answers, and the run continues with the answer in the
    transcript.
  - Acceptance:
    - [ ] `buildToolsAllowlist` force-injects `"ask_user"` alongside
          `handoff` / `end`.
    - [ ] A role calling `ask_user` surfaces an `input` / `confirm` / `select`
          dialog in the host TUI; the run pauses; the answer returns to the
          role; the turn continues.
    - [ ] `ask_user`'s `reason` (the `prompt` parameter) surfaces in the
          Feature A stream alongside the dialog, attributable and
          role-prefixed, the same way handoff reasons already surface (relocated
          from Phase 2 Task 4 — it was a forward dependency there, since
          `ask_user` does not exist until this task lands it).
    - [ ] `ask_user` is available to workers as well as the orchestrator.
    - [ ] Abort during an `ask_user` dialog flows through the tool's
          `AbortSignal` -> session ends -> loop sees abort.
  - Verification:
    - [ ] `pnpm test -- host/build-tools-allowlist` (extend: assert
          `ask_user` force-injected) and `pnpm test -- extension/tui-bridge`
          (extend: end-to-end stub `ctx.ui.input` returns a canned answer).
    - [ ] Manual real-model smoke: a manifest whose role prompt instructs
          `ask_user` when uncertain; user answers; run reaches terminal with
          the answer in the session JSONL. File transcript in
          `docs/dev-run-transcripts/`.
    - [ ] `pnpm typecheck && pnpm build && pnpm test && pnpm lint && pnpm format:check`
          green; grep guard green.
  - Dependencies: Phase 1 bridge + Task 5.
  - Files likely touched:
    - `src/host/production-host-resolve.ts`
    - `src/host/production-host.ts`
    - `tests/host/build-tools-allowlist.test.ts`
    - `tests/extension/tui-bridge.test.ts`
    - `docs/dev-run-transcripts/<date>-tui-bridge-real-model-smoke.md` (NEW)
  - Estimated scope: S

## Checkpoint — Feature B end-to-end

- [ ] Tasks 5-6 green; manual run shows `ask_user` dialog + answer flow.
- [ ] Real-model smoke transcript filed.
- [ ] Full suite green; grep guard green.
