# Implementation Plan: TUI bridge (streaming + `ask_user`)

> **Spec authority:** `docs/tui-bridge-spec.md` (human-reviewed 2026-06-20).
> This plan derives from it; the FSM spec
> (`docs/orchestrator-fsm-spec.md`) is **not modified** — the bridge is
> purely additive (spec Invariants A/B/C).
>
> **Status:** Human-reviewed 2026-06-20; `docs/tui-bridge-spec.md` carries
> the same status. The spec and this plan agree.
>
> **Skill:** `planning-and-task-breakdown` (Phase 2 → 3 of
> `spec-driven-development`). Read-only planning; no code in this doc.

## Overview

Deliver the two user-facing capabilities the spec locks in, through a
single shared bridge: **thread the extension's `ExtensionUIContext`
(`ctx.ui`) into spawned role sessions via `AgentSession.bindExtensions`**
(`ExtensionBindings.uiContext`). That bridge unlocks:

- **A — streaming:** the host's existing event handler forwards
  selected role-session events (text, tool calls, tool results,
  handoff/`ask_user` reasons) to a display sink backed by the
  extension factory's `sendMessage` action. Default `CustomMessage`
  rendering is themed markdown via pi's existing
  `CustomMessageComponent` — no renderer code, no reinvention.
- **B — `ask_user`:** a new `defineTool` whose `execute` calls
  `ctx.ui.input/confirm/select` and returns the answer as a normal
  (non-terminating) tool result. FSM-orthogonal: writes nothing to the
  `SessionSeam` capture buffer, emits no machine event, available to
  every role.

§9.5 untouched — `uiContext` is a UI-capability handle, not
session-tree membership. Role sessions stay standalone
`createAgentSession` calls; the grep guard still rejects
`ctx.newSession(`/`ctx.fork(`.

## Architecture decisions

1. **One bridge, two features.** `uiContext` threading delivers both A
   and B. No second mechanism. (Spec "Pinned SDK surfaces" §4.)
2. **Display forwarding is an *output* on the existing handler, not a
   new subscription.** `attachSessionEventHandler` gains an optional
   `onDisplay` callback; it already has the `event` in scope. No second
   control flow. (Spec Invariant A3.)
3. **`ask_user` is a tool, not a Host method.** It mirrors
   `createHandoffTool`/`createEndTool` shape but returns a normal
   (non-`terminate`) result. The `Host` interface is unchanged; the
   reducer is unchanged. (Spec Invariant B1.)
4. **Default markdown rendering, no bespoke renderer in v1.** Verified:
   `CustomMessageComponent` renders `content: string` as themed
   markdown by default. A bespoke renderer (collapsible role sections)
   is a documented follow-up, not this feature. (Spec Resolved Q4.)
5. **Streamed entries are display-only, not persisted.** The per-role
   session JSONL is the durable record. (Spec Resolved Q3.)
6. **`ask_user` available to every role** via `customTools` + the
   `tools` allowlist (force-injected like `handoff`/`end`). Role prompts
   decide when to call it. (Spec Invariant B2.)
7. **Q5 risk de-risked first.** The one unresolved risk — whether
   passing `uiContext` to a spawned session disturbs pi's interactive
   mode (dialog focus, status-line conflicts) — is the first task: a
   throwaway spike. Contingency: host-routed callback queue instead of
   direct `uiContext` passing.

## Dependency graph

```
Task 1: Spike (ctx.ui → spawned session; observe)        [de-risks Q5]
   │
   ├──(no-issues branch)── Task 2: thread uiContext through
   │                          factory → ProductionHost → AgentSession.bindExtensions
   │                              │
   │                              ├── Task 3: DisplaySink type + onDisplay
   │                              │   in attachSessionEventHandler (forward
   │                              │   text/tool/tool-result; thinking collapsed)
   │                              │       │
   │                              │       └── Task 4: wire displaySink in
   │                              │           start.ts/resume.ts → factory sendMessage
   │                              │               (Feature A end-to-end)
   │                              │
   │                              └── Task 5: createAskUserTool (input/confirm/select;
   │                                  returns dialog result; throws AskUserUnavailableError
   │                                  when no ui)
   │                                      │
   │                                      └── Task 6: wire ask_user into spawnRole
   │                                          (customTools + allowlist); uiContext reaches
   │                                          the tool's execute ctx
   │                                              (Feature B end-to-end)
   │
   └──(issues branch)── Task 2': host-routed callback queue
                          (contingency; replaces direct uiContext passing)
                              │
                              └── (same Tasks 3–6 against the queue)

Task 7: CLI fallback degradation (stdin readline for ask_user)   [after Task 6]
   │
   └── Task 8: docs (extension-usage.md streaming+ask_user + records.jsonl
       layout fix; sdk-surface.md pinned surfaces) + real-model smoke transcript
            │
            └── Task 9: conductor-owned MessageRenderer for conduct.role.{text,tool}
                (replaces the default CustomMessageComponent's flattened markdown
                 rendering with structural role label + properly-themed markdown
                 body; pinned in spec Resolved Q4 as the documented follow-up)
```

The no-issues branch is the expected path; the issues branch is the
documented contingency. Tasks 3–6 are the same against either.

## Implementation sub-plans

Task details now live in phase sub-plans so each implementation slice has its
own acceptance criteria, verification, dependency notes, and likely files
touched. This parent remains the canonical overview, dependency graph, risk
register, and gate index.

### Phase 1 — Foundation bridge

➡️ Sub-plan:
[`docs/tui-bridge-plans/phase-1-foundation.md`](tui-bridge-plans/phase-1-foundation.md)
(Tasks 1, 2, and contingency Task 2')

Gate: spec/plan status reconciled and the first implementation choice de-risked.

Exit criteria:
- [x] Task 1 spike decision recorded.
- [x] Exactly one foundation branch is complete: Task 2 (direct `uiContext`).
- [x] Full suite green; grep guard green (437 tests).

### Phase 2 — Feature A: streaming

➡️ Sub-plan:
[`docs/tui-bridge-plans/phase-2-streaming.md`](tui-bridge-plans/phase-2-streaming.md)
(Tasks 3-4)

Gate: Phase 1 complete (green + checkboxes ticked). The bridge path is known
before display forwarding is wired into the extension handlers.

Exit criteria:
- [x] Tasks 3-4 green; manual run shows live streaming.
- [x] Full suite green; grep guard green (no `ctx.newSession` / `ctx.fork`).

### Phase 3 — Feature B: `ask_user`

➡️ Sub-plan:
[`docs/tui-bridge-plans/phase-3-ask-user.md`](tui-bridge-plans/phase-3-ask-user.md)
(Tasks 5-6)

Gate: Phase 2 complete (green + checkboxes ticked). The tool reaches the chosen bridge path
without touching the FSM reducer or `SessionSeam` capture buffer.

Exit criteria:
- [x] Tasks 5-6 green; manual run shows `ask_user` dialog + answer flow.
- [x] Real-model smoke transcript filed.
- [x] Full suite green; grep guard green.

### Phase 4 — Degradation and docs

➡️ Sub-plan:
[`docs/tui-bridge-plans/phase-4-degradation-docs.md`](tui-bridge-plans/phase-4-degradation-docs.md)
(Tasks 7-8)

Gate: Phase 3 complete (green + checkboxes ticked). User-facing behavior exists before docs
claim it.

Exit criteria:
- [x] CLI fallback either works through stdin readline or is explicitly
      documented as `AskUserUnavailableError` if readline proves too fiddly.
      Stdin readline works (Task 7 + 2026-06-20 smoke transcript).
- [x] User-facing docs describe streaming and `ask_user`.
- [x] `sdk-surface.md` records the pinned TUI bridge surfaces.
- [x] Sample role tool allowlists match the intended review/fix workflows.
- [x] Full suite green; grep guard green (446 tests, 47 files).
- [x] Ready for final review at loop close and the pre-push hook
      (`pnpm lint && pnpm typecheck && pnpm test`).

### Phase 5 — TUI renderer polish

➡️ Sub-plan:
[`docs/tui-bridge-plans/phase-5-renderer-polish.md`](tui-bridge-plans/phase-5-renderer-polish.md)
(Task 9)

Gate: Phase 4 complete (green + checkboxes ticked). The two
`conduct.role.{text,tool}` `customType`s are stable, and the existing
`{ role, kind }` `details` payload from the display sink is the
authoritative input the new renderer will read.

Exit criteria:
- [x] Task 9 green; manual TUI run shows properly-styled markdown
      (headings and code blocks distinguished by the markdown theme,
      not flattened to `customMessageText`).
- [x] `pnpm typecheck && pnpm build && pnpm test && pnpm lint &&
      pnpm format:check` green; grep guard green.
- [x] `docs/sdk-surface.md` records the new pinned surfaces
      (`registerMessageRenderer`, `MessageRenderer`, `MessageRenderOptions`,
      `Theme`, `ThemeColor`, `getMarkdownTheme`, `Component`).
- [x] Real-model smoke transcript filed in
      `docs/dev-run-transcripts/`. _(Template with the acceptance
      criteria + reproduction steps; the eyeball-TUI observed-result
      section is the overseer-owned step.)_
- [x] Ready for review at the overseer's end-of-loop pass.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **Q5 — `uiContext` to spawned session disturbs pi's interactive mode** (dialog focus, status-line conflict) | High | Task 1 spike fails-fast; contingency is host-routed callback queue (Task 2') replacing direct `uiContext` passing. Tasks 3–6 are identical against either. |
| `ask_user` accidentally writes to the capture buffer, breaking single-emission | High | Explicit unit test (Task 5): assert `SessionSeam` buffer length unchanged after an `ask_user` call. |
| Streaming reopens §9.5 (role messages enter host session history) | High | `sendMessage` produces display-only `CustomMessage`s, not message-history appends; grep guard still rejects `ctx.newSession`/`ctx.fork`; unit test (Task 4) asserts no history mutation. |
| `tools.ts` exceeds ~400 LOC after adding `ask_user` | Low | Split to `ask-user-tool.ts` (planned in Task 5). |
| Thinking blobs (encrypted `gpt-5.4-mini` reasoning) flood the TUI | Med | Thinking omitted from the default stream (Task 3); surfaced only behind a later toggle. |
| CLI readline for `ask_user` is fiddly (TTY detection, piped stdin) | Low | Task 7 stubs a stdin-backed UI; if fiddly, degrade to `AskUserUnavailableError` in the CLI too (documented; not a blocker — the extension is the primary surface). |
| Stub-host parity drift (ProductionHost gains uiContext/sink) | Low | Stub-host needs neither (tests inject stub UI via the tool directly); the shared `attachSessionEventHandler` is the parity seam and it gets the optional `onDisplay` (additive). |

## Open questions for the human

- **Resolved in Phase 1.** Branch A was chosen for Task 1, Task 2'
  remains documentation-only, and the bridge now runs through
  `AgentSession.bindExtensions({ uiContext })`. No Phase 1 fork remains
  open unless Phase 2 surfaces Q5 for real.

## Checkpoints (summary)

1. **After Phase 1 (Task 2):** plumbing green; proceed to Phase 2.
2. **After Phase 2 (Task 4):** Feature A end-to-end, manual streaming
   observed; proceed to Phase 3.
3. **After Phase 3 (Task 6):** Feature B end-to-end, real-model smoke
   transcript filed; proceed to Phase 4.
4. **After Phase 4 (Task 8):** docs + sample fixes, ready for final review
   at loop close + the pre-push hook (`pnpm lint && pnpm typecheck && pnpm test`).
5. **After Phase 5 (Task 9):** TUI renderer polish end-to-end, manual
   TUI run shows properly-styled markdown; ready for the overseer's
   end-of-loop pass.

## Out of scope (explicit)

- Persisting streamed entries to `records.jsonl` (display-only, per
  spec Resolved Q3).
- `open_concerns` / findings-relay through the orchestrator (separate
  v1 limit, noted in the 2026-06-20 session; not this feature).
- Any change to the FSM spec, the reducer, or `src/core`/`src/manifest`/
  `src/seam`/`src/cost`/`src/persistence` (spec Invariant C).
