# Phase 2 — Feature A: streaming

> Sub-plan of `docs/tui-bridge-plan.md`. Read the parent plan first for the
> overview, architecture decisions, dependency graph, risks, open questions, and
> whole-plan verification. Source spec: `docs/tui-bridge-spec.md` Invariant A.
>
> **Status:** In progress — Task 3 is green; manual live TUI run verified; one Task 4 acceptance item is deferred to Task 6.
>
> **Scope:** Add a display-only tap to the existing host event handler and wire
> it to the extension factory's `sendMessage` action. This phase must not append
> streamed entries to the host log and must not move role sessions into pi's
> session tree.

## Gate

- [x] Phase 1 complete (green + checkboxes ticked).
- [x] Direct `uiContext` or host-routed queue branch is decided and documented.

## Tasks

- [x] **Task 3: `DisplaySink` + `onDisplay` in `attachSessionEventHandler`**
  - _Note: All acceptance + verification sub-boxes are green and remain so; no remediation outstanding for Task 3._
  - Description: Define a `DisplaySink` type (a callback receiving a typed
    `DisplayEvent`: role, kind, text). Extend `attachSessionEventHandler`'s
    args with an optional `onDisplay?`; in the subscriber, forward selected
    events to it: assistant text (`message_end` text content), tool calls + tool
    results (`tool_execution_*`), and terminal handoff output via the tool
    result text. Thinking is not forwarded by default (collapsed); it can be
    surfaced only by a later toggle task. Existing `message_end`
    usage/cap/model-error behavior is unchanged.
  - Acceptance:
    - [x] `DisplaySink` + `DisplayEvent` types defined and exported from
          `src/host/display-sink.ts`.
    - [x] `attachSessionEventHandler({ session, state, onDisplay? })` emits
          `DisplayEvent`s for text, tool calls, and tool results when
          `onDisplay` is provided; thinking omitted by default.
    - [x] When `onDisplay` is absent, behavior is byte-identical to today (the
          existing stub E2E / cost / fallback tests unaffected).
    - [x] No host session-tree mutation; forwarding is display-only and does not
          append to message history.
  - Verification:
    - [x] `pnpm test -- host/display-forwarding` (NEW): feed synthetic
          `AgentSessionEvent`s; assert sink receives expected events; assert no
          seam-capture writes and no reducer calls.
    - [x] Existing `session-event-handler` tests green.
    - [x] `pnpm typecheck && pnpm build && pnpm test` green.
  - Dependencies: None; Task 4 needs this and Phase 1 plumbing.
  - Files likely touched:
    - `src/host/display-sink.ts` (NEW)
    - `src/host/session-event-handler.ts`
    - `tests/host/display-forwarding.test.ts` (NEW)
  - Estimated scope: M

- [ ] **Task 4: Wire the display sink to factory `sendMessage` in the handlers**
  - _Remediation needed: one acceptance item (`ask_user`'s `reason` surfacing in the stream) is deferred to Task 6 (Phase 3). Task 4 cannot be closed — and therefore the Phase 2 checkpoint cannot be closed — until `createAskUserTool` lands and this item is re-verified. Handoff reasons already surface; `ask_user` reasons do not, because the tool does not yet exist._
  - Description: In `start.ts` and `resume.ts`, build a `DisplaySink` that
    converts each `DisplayEvent` into a factory `sendMessage` call with a
    conductor-owned `customType` (for example, `"conduct.role.text"` and
    `"conduct.role.tool"`) and `display: true`. Pass the sink and the Phase 1
    bridge into `createProductionHost`. Default `CustomMessageComponent`
    rendering (themed markdown) is used; no bespoke renderer. Role-prefixed
    labels are part of the `content` string, not a custom component.
  - Acceptance:
    - [x] A `/conduct` run streams role text + tool calls + tool results into
          the host TUI as attributable, role-prefixed markdown entries.
    - [x] The footer status line + terminal notification still fire unchanged.
    - [ ] `ask_user`'s `reason` surfaces in the stream after Task 6 lands;
          handoff reasons surface now.
    - [x] Streamed entries are not appended to `records.jsonl`.
  - Verification:
    - [x] `pnpm test -- extension/tui-bridge` (NEW, stub-driven): a stub
          factory `sendMessage` spy collects payloads; assert `customType`,
          content, role prefix, and `display: true`.
    - [x] Manual: `pi install -l ./` + `/conduct <goal>` with a multi-role
          manifest; eyeball role text + tool calls appearing live.
    - [x] `pnpm typecheck && pnpm build && pnpm test && pnpm lint` green.
  - Dependencies: Phase 1 bridge + Task 3.
  - Files likely touched:
    - `src/extension/commands/start.ts`
    - `src/extension/commands/resume.ts`
    - `src/extension/display-sink-wiring.ts` (NEW)
    - `tests/extension/tui-bridge.test.ts` (NEW)
  - Estimated scope: M

## Checkpoint — Feature A end-to-end

- [ ] Tasks 3-4 green; manual run shows live streaming.
- [x] Full suite green; grep guard green (no `ctx.newSession` / `ctx.fork`).
