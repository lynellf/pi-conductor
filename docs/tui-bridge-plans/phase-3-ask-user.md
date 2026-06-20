# Phase 3 — Feature B: `ask_user`

> Sub-plan of `docs/tui-bridge-plan.md`. Read the parent plan first for the
> overview, architecture decisions, dependency graph, risks, open questions, and
> whole-plan verification. Source spec: `docs/tui-bridge-spec.md` Invariant B.
>
> **Status:** Complete — Tasks 5-6 green; manual TUI run verified
> `ask_user` prompt, answer flow, and dialog-level cancel behavior.
>
> **Scope:** Add `ask_user` as a normal, non-terminating host tool available to
> every role. It is FSM-orthogonal: it writes nothing to the `SessionSeam`
> capture buffer, emits no machine event, and does not change reducer behavior.

## Gate

- [x] Phase 2 complete (green + checkboxes ticked).
- [x] Phase 1 bridge path is stable enough for a role tool to reach the UI
      surface or queue. (Verified end-to-end by Phase 2's live streaming manual run — the bridge delivers `DisplayEvent`s through the same `uiContext` path a role tool would use.)

## Review feedback — resolved

Current review stance: **complete for Phase 3**. Task 5 and Task 6 are
implemented and verified. The earlier abort/cancel concern was resolved by
re-scoping `docs/tui-bridge-spec.md` Invariant B.5 to match observed pi TUI
behavior: `Esc`/`Ctrl+C` cancels the dialog and returns no answer/selection as a
normal, non-terminating tool result; process-level run abort remains host-owned
run cancellation, not an `ask_user` machine event.

Resolved remediation:

1. **Dialog cancel during `ask_user` is accepted Phase 3 behavior.**
   The filed real-model smoke and follow-up manual test show `Ctrl+C`/cancel
   dismisses the dialog and returns `(no answer)`. The role then decides whether
   to ask again, hand off, or end. That matches the updated spec contract for
   dialog-level cancellation and keeps `ask_user` FSM-orthogonal.

2. **Align the test/documentation claim for the TUI bridge.**
   The verification wording below is narrowed so
   `tests/extension/tui-bridge.test.ts` is credited for `ctx.ui` passthrough and
   display-sink wrapping, while `tests/host/production-host-spawn.test.ts`
   carries force-injection/spawned-role availability.

3. **Keep checkbox state mechanically accurate.**
   Task 5 and Task 6 parent boxes are ticked because their acceptance and
   verification are complete under the updated spec contract.

Out-of-band release note: `pnpm audit` currently reports high-severity
transitive advisories in `undici@8.3.0` via
`@earendil-works/pi-coding-agent@0.79.1`. This does not appear introduced by the
Phase 3 `ask_user` change, but it must be handled or explicitly risk-accepted
before a release gate that includes audit.

## Tasks

- [x] **Task 5: `createAskUserTool`**
  - Description: New `defineTool` factory in `src/host/ask-user-tool.ts`
    (split from `tools.ts` to respect the ~400 LOC ceiling). Parameters
    (TypeBox): `kind` (`input` | `confirm` | `select`), `prompt`, and
    select-options when `kind === "select"`. `execute` calls
    `ui.input` / `ui.confirm` / `ui.select` and returns the answer as a normal
    (non-`terminate`) tool result. When no usable UI is present, throw a typed
    `AskUserUnavailableError` rather than silently no-oping. Writes nothing to
    the `SessionSeam` capture buffer.
  - Acceptance:
    - [x] `ask_user` with `kind: "input"` returns the user's text.
    - [x] `kind: "confirm"` returns a boolean-shaped result.
    - [x] `kind: "select"` returns the chosen option.
    - [x] With no UI, throws `AskUserUnavailableError`.
    - [x] Calling `ask_user` writes nothing to a `SessionSeam` capture buffer
          (verified: buffer length unchanged after a call).
    - [x] `ask_user` returns `terminate: false`; the turn continues.
  - Verification:
    - [x] `pnpm exec vitest run tests/host/ask-user-tool.test.ts --maxWorkers=1
          --no-file-parallelism` (NEW): stub UI with canned `input` / `confirm`
          / `select`; assert results, no-UI throw, and the
          capture-buffer-untouched invariant.
    - [x] `pnpm typecheck && pnpm build && pnpm test && pnpm lint &&
          pnpm format:check` green.
  - Dependencies: Phase 1 bridge (the tool reaches UI through direct
    `uiContext` or the contingency queue).
  - Files likely touched:
    - `src/host/ask-user-tool.ts` (NEW)
    - `src/host/errors.ts`
    - `tests/host/ask-user-tool.test.ts` (NEW)
  - Estimated scope: S

- [x] **Task 6: Wire `ask_user` into `spawnRole`**
  - _Remediation status: complete. Dialog-level cancel returns no
    answer/selection as a normal tool result; process-level run abort is outside
    the `ask_user` Phase 3 contract._
  - Description: In `ProductionHost.spawnRole`, add `askUserTool` to the
    `customTools` array alongside `handoff` / `end`, and add `"ask_user"` to the
    `tools` allowlist (force-injected like `handoff` / `end` via
    `buildToolsAllowlist`). The tool is available to every role regardless of
    manifest `tools:`. Verify a real `/conduct` run where a role calls
    `ask_user`, the user answers, and the run continues with the answer in the
    transcript.
  - Acceptance:
    - [x] `buildToolsAllowlist` force-injects `"ask_user"` alongside
          `handoff` / `end`.
    - [x] A role calling `ask_user` surfaces an `input` / `confirm` / `select`
          dialog in the host TUI; the run pauses; the answer returns to the
          role; the turn continues.
    - [x] `ask_user`'s `reason` (the `prompt` parameter) surfaces in the
          Feature A stream alongside the dialog, attributable and
          role-prefixed, the same way handoff reasons already surface (relocated
          from Phase 2 Task 4 — it was a forward dependency there, since
          `ask_user` does not exist until this task lands it).
    - [x] `ask_user` is available to workers as well as the orchestrator.
    - [x] Dialog-level cancel during an `ask_user` prompt returns no
          answer/selection as a normal, non-terminating tool result; the role
          can ask again, hand off, or end.
  - Verification:
    - [x] `pnpm exec vitest run tests/host/ask-user-tool.test.ts
          tests/host/production-host-spawn.test.ts tests/extension/tui-bridge.test.ts
          --maxWorkers=1 --no-file-parallelism` (coverage: `ask_user` tool
          behavior in `ask-user-tool.test.ts`; force-injection and spawned-role
          availability in `production-host-spawn.test.ts`; existing
          `ctx.ui`/display-sink bridge coverage in `extension/tui-bridge.test.ts`).
    - [x] Manual real-model smoke: a manifest whose role prompt instructs
          `ask_user` when uncertain; user answers; run reaches terminal with
          the answer in the session JSONL. File transcript in
          `docs/dev-run-transcripts/`.
    - [x] Manual cancel smoke: cancel while the `ask_user` dialog is open;
          confirm the TUI dismisses the prompt and returns no answer without
          corrupting the run, then update the smoke transcript.
    - [x] `pnpm typecheck && pnpm build && pnpm test && pnpm lint && pnpm
          format:check` green; grep guard green.
  - Dependencies: Phase 1 bridge + Task 5.
  - Files likely touched:
    - `src/host/production-host-resolve.ts`
    - `src/host/production-host.ts`
    - `tests/host/build-tools-allowlist.test.ts`
    - `tests/extension/tui-bridge.test.ts`
    - `docs/dev-run-transcripts/<date>-tui-bridge-real-model-smoke.md` (NEW)
  - Estimated scope: S

## Checkpoint — Feature B end-to-end

- [x] Tasks 5-6 green; manual run shows `ask_user` dialog + answer flow.
- [x] Happy-path real-model smoke transcript filed.
- [x] Dialog-cancel smoke transcript filed and aligned with spec Invariant B.5.
- [x] Full suite green for the current happy-path implementation; grep guard
      green.
