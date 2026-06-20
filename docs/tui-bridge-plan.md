# Implementation Plan: TUI bridge (streaming + `ask_user`)

> **Spec authority:** `docs/tui-bridge-spec.md` (human-reviewed 2026-06-20).
> This plan derives from it; the FSM spec
> (`docs/orchestrator-fsm-spec.md`) is **not modified** — the bridge is
> purely additive (spec Invariants A/B/C).
>
> **Skill:** `planning-and-task-breakdown` (Phase 2 → 3 of
> `spec-driven-development`). Read-only planning; no code in this doc.

## Overview

Deliver the two user-facing capabilities the spec locks in, through a
single shared bridge: **thread the extension's `ExtensionUIContext`
(`ctx.ui`) into spawned role sessions as `createAgentSession`'s
`uiContext`.** That bridge unlocks:

- **A — streaming:** the host's existing event handler forwards
  selected role-session events (text, tool calls, tool results,
  handoff/`ask_user` reasons) to a display sink backed by
  `ctx.ui.sendMessage`. Default `CustomMessage` rendering is themed
  markdown via pi's existing `CustomMessageComponent` — no renderer
  code, no reinvention.
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
   │                          factory → ProductionHost → createAgentSession
   │                              │
   │                              ├── Task 3: DisplaySink type + onDisplay
   │                              │   in attachSessionEventHandler (forward
   │                              │   text/tool/tool-result; thinking collapsed)
   │                              │       │
   │                              │       └── Task 4: wire displaySink in
   │                              │           start.ts/resume.ts → ctx.ui.sendMessage
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
```

The no-issues branch is the expected path; the issues branch is the
documented contingency. Tasks 3–6 are the same against either.

## Task list

### Phase 1: Foundation (the bridge)

#### Task 1: Spike — `ctx.ui` to one spawned role session

**Description:** A throwaway, non-merged spike that passes `ctx.ui`
from a `/conduct` handler into one spawned role session via
`createAgentSession`'s `uiContext`, and observes whether pi's
interactive mode behaves normally (no dialog-focus theft, no
status-line conflict, no crash). Resolves spec Open Risk Q5. Branch
outcome A (no issues) → proceed to Task 2; outcome B (issues) →
Task 2' (host-routed callback queue).

**Acceptance criteria:**
- [ ] A spawned role session received `uiContext` (verified by a
      probe tool calling `ctx.ui.notify` or `ctx.ui.setStatus`).
- [ ] Observed behavior recorded in a short note: did the host TUI
      remain usable while the role session ran? Any focus/status
      conflict?
- [ ] Decision recorded: branch A or branch B.

**Verification:**
- [ ] Manual run via `pi install -l ./` + `/conduct <goal>` with a
      one-role manifest; eyeball the TUI.
- [ ] No automated test (spike is throwaway; the wiring it proves is
      tested in Task 2).

**Dependencies:** None (the spec is approved; the spike precedes all
wiring).

**Files likely touched:**
- `scratch/spike-uicontext/` (gitignored throwaway manifest + role)
- `src/host/production-host.ts` (temporary `uiContext` passthrough —
  reverted or formalized in Task 2)

**Estimated scope:** XS (spike; not committed as-is)

---

#### Task 2: Thread `uiContext` through the factory → host → `createAgentSession`

**Description:** Formalize the spike. Add `uiContext?: ExtensionUIContext`
to `CreateProductionHostInputs.extension` and
`ProductionHostOptions`; pass it through `createProductionHost` →
`ProductionHost` constructor → `spawnRole`'s `createAgentSession`
`createOpts`. No behavior change yet (no `ask_user`, no streaming) —
this is pure plumbing, verified by a unit test asserting the option
flows to the session factory.

**Acceptance criteria:**
- [ ] `createProductionHost({ extension: { modelRegistry, cwd, uiContext } })`
      reaches `createAgentSession`'s `uiContext` option in `spawnRole`.
- [ ] When `uiContext` is omitted (CLI fallback, library consumers),
      behavior is byte-identical to today (`noOpUIContext` default —
      the SDK handles this).
- [ ] `pnpm typecheck && pnpm build && pnpm test && pnpm lint && pnpm format:check` green; grep-guard passes.

**Verification:**
- [ ] `pnpm test -- host/production-host` (new unit test: spy on
      `createAgentSession`, assert `uiContext` is passed).
- [ ] `pnpm typecheck` clean (the new optional field types).
- [ ] Existing 432 tests green (no regression — the option is additive).

**Dependencies:** Task 1 (branch decision).

**Files likely touched:**
- `src/host/production-host-factory.ts` (add `uiContext` to `ExtensionContextInputs` + passthrough)
- `src/host/production-host.ts` (add field + forward in `spawnRole`)
- `tests/host/production-host-ui-context.test.ts` (NEW)

**Estimated scope:** S

---

### Checkpoint: Foundation
- [ ] Task 1 spike decision recorded
- [ ] Task 2 plumbing tests green
- [ ] Full suite green; grep guard green
- [ ] **Human review before Phase 2**

### Phase 2: Feature A — streaming

#### Task 3: `DisplaySink` + `onDisplay` in `attachSessionEventHandler`

**Description:** Define a `DisplaySink` type (a callback receiving a
typed `DisplayEvent` — role, kind, text). Extend
`attachSessionEventHandler`'s args with an optional `onDisplay?`; in
the subscriber, forward selected events to it: assistant text
(`message_end` text content), tool calls + tool results
(`tool_execution_*`), and handoff/`ask_user` reasons (read from the
seam capture buffer at terminal). Thinking is **not** forwarded by
default (collapsed) — surfaced only if a later toggle task adds it.
The existing `message_end` usage/cap/model-error behavior is
unchanged.

**Acceptance criteria:**
- [ ] `DisplaySink` + `DisplayEvent` types defined and exported from
      `src/host/display-sink.ts` (new small module).
- [ ] `attachSessionEventHandler({ session, state, onDisplay? })` —
      when `onDisplay` is provided, emits `DisplayEvent`s for text,
      tool calls, tool results; thinking omitted by default.
- [ ] When `onDisplay` is absent, behavior is byte-identical to today
      (the existing stub E2E / cost / fallback tests unaffected).
- [ ] No host session-tree mutation (forwarding is display-only; the
      sink is the extension's `sendMessage`, not a message-history append).

**Verification:**
- [ ] `pnpm test -- host/display-forwarding` (NEW: feed synthetic
      `AgentSessionEvent`s; assert sink receives expected events;
      assert no seam-capture writes, no reduce calls).
- [ ] Existing `session-event-handler` tests green (the optional
      callback is additive).
- [ ] `pnpm typecheck && pnpm build && pnpm test` green.

**Dependencies:** None (independent of Task 2; the sink is a callback,
not the uiContext plumbing — but wiring in Task 4 needs both).

**Files likely touched:**
- `src/host/display-sink.ts` (NEW — types + maybe a formatter)
- `src/host/session-event-handler.ts` (add `onDisplay`, forward)
- `tests/host/display-forwarding.test.ts` (NEW)

**Estimated scope:** M

---

#### Task 4: Wire the display sink to `ctx.ui.sendMessage` in the handlers

**Description:** In `start.ts` and `resume.ts`, build a `DisplaySink`
that converts each `DisplayEvent` into a `ctx.ui.sendMessage` call
with a conductor-owned `customType` (e.g. `"conduct.role.text"`,
`"conduct.role.tool"`) and `display: true`. Pass the sink (and
`ctx.ui` as `uiContext`, from Task 2) into `createProductionHost`.
Default `CustomMessageComponent` rendering (themed markdown) is used —
no bespoke renderer. Role-prefixed labels are part of the `content`
string, not a custom component.

**Acceptance criteria:**
- [ ] A `/conduct` run streams role text + tool calls + tool results
      into the host TUI as attributable, role-prefixed markdown entries.
- [ ] The footer status line + terminal notification still fire
      (unchanged from v1).
- [ ] `ask_user`'s `reason` (once Task 6 lands) surfaces in the stream;
      handoff reasons surface.
- [ ] Streamed entries are NOT appended to `records.jsonl` (display-only).

**Verification:**
- [ ] `pnpm test -- extension/tui-bridge` (NEW, stub-driven: a stub
      `ctx.ui.sendMessage` spy collects payloads; assert customType,
      content, role prefix, display:true).
- [ ] Manual: `pi install -l ./` + `/conduct <goal>` with a multi-role
      manifest — eyeball role text + tool calls appearing live.
- [ ] `pnpm typecheck && pnpm build && pnpm test && pnpm lint` green.

**Dependencies:** Task 2 (uiContext plumbing) + Task 3 (DisplaySink).

**Files likely touched:**
- `src/extension/commands/start.ts` (build sink, pass uiContext + sink)
- `src/extension/commands/resume.ts` (same)
- `src/extension/display-sink-wiring.ts` (NEW — the sink→sendMessage formatter, shared by start/resume)
- `tests/extension/tui-bridge.test.ts` (NEW)

**Estimated scope:** M

---

### Checkpoint: Feature A end-to-end
- [ ] Tasks 3–4 green; manual run shows live streaming
- [ ] Full suite green; grep guard green (no `ctx.newSession`/`ctx.fork`)
- [ ] **Human review before Phase 3**

### Phase 3: Feature B — `ask_user`

#### Task 5: `createAskUserTool`

**Description:** New `defineTool` factory in `src/host/ask-user-tool.ts`
(split from `tools.ts` to respect the ~400 LOC ceiling). Parameters
(TypeBox): `kind` (`input`|`confirm`|`select`), `prompt`, and
select-options when `kind === "select"`. `execute` calls
`ui.input`/`ui.confirm`/`ui.select` and returns the answer as a normal
(non-`terminate`) tool result. When `ui` is a no-op / absent (no
`uiContext`), throws a typed `AskUserUnavailableError` (no silent
no-op — AGENTS.md). Writes **nothing** to the `SessionSeam` capture
buffer (FSM-orthogonality, Invariant B1 — there's an explicit unit
test for this).

**Acceptance criteria:**
- [ ] `ask_user` with `kind: "input"` returns the user's text.
- [ ] `kind: "confirm"` returns a boolean-shaped result.
- [ ] `kind: "select"` returns the chosen option.
- [ ] With no UI, throws `AskUserUnavailableError` (not a silent return).
- [ ] Calling `ask_user` writes nothing to a `SessionSeam` capture
      buffer (verified: buffer length unchanged after a call).
- [ ] `ask_user` returns `terminate: false` (the turn continues, unlike
      `handoff`/`end`).

**Verification:**
- [ ] `pnpm test -- host/ask-user-tool` (NEW: stub `ui` with canned
      `input`/`confirm`/`select`; assert results + the no-UI throw +
      the capture-buffer-untouched invariant).
- [ ] `pnpm typecheck && pnpm build && pnpm test && pnpm lint` green.

**Dependencies:** Task 2 (the tool's `execute` `ctx.ui` is populated
only via the uiContext threading).

**Files likely touched:**
- `src/host/ask-user-tool.ts` (NEW)
- `src/host/errors.ts` (add `AskUserUnavailableError`)
- `tests/host/ask-user-tool.test.ts` (NEW)

**Estimated scope:** S

---

#### Task 6: Wire `ask_user` into `spawnRole`

**Description:** In `ProductionHost.spawnRole`, add `askUserTool` to the
`customTools` array (alongside `handoff`/`end`) and `"ask_user"` to the
`tools` allowlist (force-injected, like `handoff`/`end`, via
`buildToolsAllowlist` — so `ask_user` is available to every role
regardless of manifest `tools:`). The tool closes over the host's
`uiContext` (or, branch B, a host-routed callback). Verify a real
`/conduct` run where a role calls `ask_user`, the user answers, and
the run continues with the answer in the transcript.

**Acceptance criteria:**
- [ ] `buildToolsAllowlist` force-injects `"ask_user"` alongside
      `handoff`/`end`.
- [ ] A role calling `ask_user` surfaces an `input`/`confirm`/`select`
      dialog in the host TUI; the run pauses; the answer returns to
      the role; the turn continues.
- [ ] `ask_user` is available to workers as well as the orchestrator
      (not gated by `is_orchestrator`).
- [ ] Abort during an `ask_user` dialog flows through the tool's
      `AbortSignal` → session ends → loop sees abort (existing plumbing).

**Verification:**
- [ ] `pnpm test -- host/build-tools-allowlist` (extend: assert
      `ask_user` force-injected) + `extension/tui-bridge` (extend:
      end-to-end stub `ctx.ui.input` returns a canned answer).
- [ ] Manual real-model smoke: a manifest whose role prompt instructs
      `ask_user` when uncertain; user answers; run reaches terminal
      with the answer in the session JSONL. File transcript in
      `docs/dev-run-transcripts/`.
- [ ] `pnpm typecheck && pnpm build && pnpm test && pnpm lint && pnpm format:check` green; grep guard green.

**Dependencies:** Task 2 (uiContext) + Task 5 (the tool).

**Files likely touched:**
- `src/host/production-host-resolve.ts` (extend `buildToolsAllowlist`)
- `src/host/production-host.ts` (add `askUserTool` to customTools)
- `tests/host/build-tools-allowlist.test.ts` (extend)
- `tests/extension/tui-bridge.test.ts` (extend — end-to-end ask_user)

**Estimated scope:** S

---

### Checkpoint: Feature B end-to-end
- [ ] Tasks 5–6 green; manual run shows ask_user dialog + answer flow
- [ ] Real-model smoke transcript filed
- [ ] Full suite green; grep guard green
- [ ] **Human review before Phase 4**

### Phase 4: Degradation + docs

#### Task 7: CLI fallback degradation for `ask_user`

**Description:** The CLI (`src/bin/conduct.ts`) is the only non-TUI
conductor surface. When `ask_user` is called there, fall back to
stdin readline (prompt printed to stdout; answer read from stdin).
For any future rpc/json/print surface (not currently conductor
surfaces), `ask_user` throws `AskUserUnavailableError`. Implement
the CLI readline by passing a stdin-backed `ExtensionUIContext`-shaped
stub as `uiContext` (so the tool code is unchanged — only the UI
implementation differs).

**Acceptance criteria:**
- [ ] `node dist/bin/conduct.js <manifest> <goal>` with an `ask_user`-
      calling role prints the prompt to stdout, reads the answer from
      stdin, and continues.
- [ ] Exit codes unchanged (0 terminal; 1 error; 3 missing manifest).

**Verification:**
- [ ] Manual CLI run with an `ask_user` role; answer via stdin.
- [ ] `pnpm build` emits `dist/bin/conduct.js`; existing CLI tests green.

**Dependencies:** Task 6.

**Files likely touched:**
- `src/bin/conduct.ts` (stdin-backed uiContext stub)
- possibly `src/host/ask-user-tool.ts` (if the stub shape needs a shared interface)

**Estimated scope:** S

---

#### Task 8: Docs + `sdk-surface.md` pinned surfaces

**Description:** Update `docs/extension-usage.md` to document streaming
+ `ask_user` (user-facing), and **fix the `records.jsonl` layout
diagram** (Finding 3 from the 2026-06-20 run: the file is a flat
`<runId>.jsonl` sibling of the run directory, not
`<runId>/records.jsonl` inside it). Update `docs/sdk-surface.md` with
the newly pinned surfaces (`uiContext`, `ExtensionUIContext.input/
confirm/select/sendMessage`, `ToolDefinition.execute` ctx,
`CustomMessageComponent` default markdown rendering) so the next phase
isn't re-deriving them. Fix the sample bundles' `tools:` lists in
`scratch/sample-roles/` so reviewers/fixers actually have `read`/`edit`
(verified source-level bug, separate from this feature but cheap to fix here).

**Acceptance criteria:**
- [ ] `docs/extension-usage.md` has a Streaming section + an `ask_user` section; the run-log layout diagram matches on-disk reality.
- [ ] `docs/sdk-surface.md` records the four pinned surfaces from this spec.
- [ ] `scratch/sample-roles/code-review/` worker `tools:` lists include `read`/`edit`/`write` as appropriate.

**Verification:**
- [ ] Docs review (human).
- [ ] `pnpm lint && pnpm format:check` clean (docs + scratch are not linted by biome for .md, but yaml is).

**Dependencies:** Tasks 4 + 6 (so the docs describe shipped behavior).

**Files likely touched:**
- `docs/extension-usage.md`
- `docs/sdk-surface.md`
- `scratch/sample-roles/code-review/conductor.yaml`

**Estimated scope:** S

---

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

- **Branch decision after Task 1.** If the spike surfaces issues, do you
  want the host-routed callback queue (Task 2'), or to revisit the
  design before committing? (This is the only plan-level fork; the
  rest follows the spec's resolved questions.)

## Checkpoints (summary)

1. **After Phase 1 (Task 2):** plumbing green, human review.
2. **After Phase 2 (Task 4):** Feature A end-to-end, manual streaming
   observed, human review.
3. **After Phase 3 (Task 6):** Feature B end-to-end, real-model smoke
   transcript filed, human review.
4. **After Phase 4 (Task 8):** docs + sample fixes, ready for full
   review + the pre-push hook (`pnpm lint && pnpm typecheck && pnpm test`).

## Out of scope (explicit)

- Bespoke message renderer / collapsible role sections (follow-up).
- Persisting streamed entries to `records.jsonl` (display-only, per
  spec Resolved Q3).
- `open_concerns` / findings-relay through the orchestrator (separate
  v1 limit, noted in the 2026-06-20 session; not this feature).
- Any change to the FSM spec, the reducer, or `src/core`/`src/manifest`/
  `src/seam`/`src/cost`/`src/persistence` (spec Invariant C).