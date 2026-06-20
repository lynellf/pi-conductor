# Phase 2 — Feature A: streaming

> Sub-plan of `docs/tui-bridge-plan.md`. Read the parent plan first for the
> overview, architecture decisions, dependency graph, risks, open questions, and
> whole-plan verification. Source spec: `docs/tui-bridge-spec.md` Invariant A.
>
> **Status:** Draft — not started.
>
> **Scope:** Add a display-only tap to the existing host event handler and wire
> it to the extension's `ctx.ui.sendMessage` surface. This phase must not append
> streamed entries to the host log and must not move role sessions into pi's
> session tree.

## Gate

- [ ] Phase 1 complete (green + checkboxes ticked).
- [ ] Direct `uiContext` or host-routed queue branch is decided and documented.

## Tasks

- [ ] **Task 3: `DisplaySink` + `onDisplay` in `attachSessionEventHandler`**
  - Description: Define a `DisplaySink` type (a callback receiving a typed
    `DisplayEvent`: role, kind, text). Extend `attachSessionEventHandler`'s
    args with an optional `onDisplay?`; in the subscriber, forward selected
    events to it: assistant text (`message_end` text content), tool calls + tool
    results (`tool_execution_*`), and handoff/`ask_user` reasons (read from the
    seam capture buffer at terminal). Thinking is not forwarded by default
    (collapsed); it can be surfaced only by a later toggle task. Existing
    `message_end` usage/cap/model-error behavior is unchanged.
  - Acceptance:
    - [ ] `DisplaySink` + `DisplayEvent` types defined and exported from
          `src/host/display-sink.ts`.
    - [ ] `attachSessionEventHandler({ session, state, onDisplay? })` emits
          `DisplayEvent`s for text, tool calls, and tool results when
          `onDisplay` is provided; thinking omitted by default.
    - [ ] When `onDisplay` is absent, behavior is byte-identical to today (the
          existing stub E2E / cost / fallback tests unaffected).
    - [ ] No host session-tree mutation; forwarding is display-only and does not
          append to message history.
  - Verification:
    - [ ] `pnpm test -- host/display-forwarding` (NEW): feed synthetic
          `AgentSessionEvent`s; assert sink receives expected events; assert no
          seam-capture writes and no reducer calls.
    - [ ] Existing `session-event-handler` tests green.
    - [ ] `pnpm typecheck && pnpm build && pnpm test` green.
  - Dependencies: None; Task 4 needs this and Phase 1 plumbing.
  - Files likely touched:
    - `src/host/display-sink.ts` (NEW)
    - `src/host/session-event-handler.ts`
    - `tests/host/display-forwarding.test.ts` (NEW)
  - Estimated scope: M

- [ ] **Task 4: Wire the display sink to `ctx.ui.sendMessage` in the handlers**
  - Description: In `start.ts` and `resume.ts`, build a `DisplaySink` that
    converts each `DisplayEvent` into a `ctx.ui.sendMessage` call with a
    conductor-owned `customType` (for example, `"conduct.role.text"` and
    `"conduct.role.tool"`) and `display: true`. Pass the sink and the Phase 1
    bridge into `createProductionHost`. Default `CustomMessageComponent`
    rendering (themed markdown) is used; no bespoke renderer. Role-prefixed
    labels are part of the `content` string, not a custom component.
  - Acceptance:
    - [ ] A `/conduct` run streams role text + tool calls + tool results into
          the host TUI as attributable, role-prefixed markdown entries.
    - [ ] The footer status line + terminal notification still fire unchanged.
    - [ ] `ask_user`'s `reason` surfaces in the stream after Task 6 lands;
          handoff reasons surface now.
    - [ ] Streamed entries are not appended to `records.jsonl`.
  - Verification:
    - [ ] `pnpm test -- extension/tui-bridge` (NEW, stub-driven): a stub
          `ctx.ui.sendMessage` spy collects payloads; assert `customType`,
          content, role prefix, and `display: true`.
    - [ ] Manual: `pi install -l ./` + `/conduct <goal>` with a multi-role
          manifest; eyeball role text + tool calls appearing live.
    - [ ] `pnpm typecheck && pnpm build && pnpm test && pnpm lint` green.
  - Dependencies: Phase 1 bridge + Task 3.
  - Files likely touched:
    - `src/extension/commands/start.ts`
    - `src/extension/commands/resume.ts`
    - `src/extension/display-sink-wiring.ts` (NEW)
    - `tests/extension/tui-bridge.test.ts` (NEW)
  - Estimated scope: M

## Checkpoint — Feature A end-to-end

- [ ] Tasks 3-4 green; manual run shows live streaming.
- [ ] Full suite green; grep guard green (no `ctx.newSession` / `ctx.fork`).
