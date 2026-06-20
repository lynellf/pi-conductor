# Spec: TUI bridge — role output streaming + human-in-the-loop (`ask_user`)

> **Status:** Human-reviewed 2026-06-20 (Phase 1 Specify of
> `spec-driven-development`). Authority for behavior; the FSM spec
> (`docs/orchestrator-fsm-spec.md`) remains authority for the reducer /
> lifecycle / cost machinery, which this spec does **not** modify.
>
> **Scope name:** the "TUI bridge." Two user-facing capabilities (A: stream
> role output into the host TUI; B: any role can request user input via an
> `ask_user` tool) delivered through a single shared mechanism: threading
> the extension's `ExtensionUIContext` into spawned role sessions.

## Objective

### Problem

v1 `/conduct` is functionally correct but observationally opaque. A run
reaches a terminal state and the user sees only:

1. a footer status line (`conduct: <role> · running · $<cost>`, 250 ms ticks), and
2. one terminal notification (`pi-conductor run_id=… reached terminal
   state=done reason=done`).

The orchestrator's and workers' reasoning, text, tool calls, and handoff
reasons are written to per-role JSONL files under
`<cwd>/.pi-conductor/runs/<runId>/sessions/` and are **invisible in the
TUI**. A user cannot follow the run as it happens, nor intervene when a
role needs clarification. Evidence: the 2026-06-19 real-model smoke
(`docs/dev-run-transcripts/2026-06-19-cli-real-model-smoke.md`) and the
2026-06-20 extension run `81374d83…`, where the model's own decrypted
thinking observed that `end` "will likely terminate the run without
showing any user-facing text."

A second, related gap: roles cannot ask the user for clarification. Real
workflows are conversational — an orchestrator drafting a plan, or a
worker pushing back on an ambiguous task, needs to query the user before
acting. Without that capability the only options are guess or abort.

### User stories

- As a user running `/conduct`, I want to see each role's reasoning
  (text + tool calls + handoff/ask reasons) appear in the host TUI as the
  run progresses, so I can follow the workflow without reading JSONL.
- As a user running `/conduct`, I want any role to be able to ask me a
  clarifying question (free-text, confirm, or select) when its
  instructions tell it to, and have the run continue with my answer — so
  conversational back-and-forth is possible, not just fire-and-forget.
- As a user, I do **not** want role sessions to become pi session-tree
  members (§9.5) as a side effect of either capability.

### Success criteria

1. During a `/conduct` run, an orchestrator or worker emitting assistant
   text, a tool call, or a tool result produces a visible, attributable
   entry in the host TUI (role-prefixed), in addition to the existing
   footer status line.
2. A role calling the `ask_user` tool surfaces an `input`/`confirm`/`select`
   dialog in the host TUI; the run pauses until the user responds (or
   aborts); the user's answer is returned to the role as the tool result,
   and the role's turn continues.
3. `ask_user` is available to **every** role (orchestrator + any worker),
   not gated by role kind. Role prompts decide when to call it.
4. The grep-guard invariants in `AGENTS.md` hold: `extensions/**/*.ts`
   still contains no `ctx.newSession(` / `ctx.fork(`; `src/core`,
   `src/manifest`, `src/seam`, `src/cost`, `src/persistence` still
   contain zero pi imports.
5. `pnpm typecheck && pnpm build && pnpm test && pnpm lint && pnpm
   format:check` are green; the grep-guard test passes; the existing
   432-test suite is not regressed.
6. A real-model smoke (relocated 7A.5 pattern) shows a run where a role
   asks the user a question, the user answers, and the run reaches a
   terminal state with the answer reflected in the transcript; transcript
   is filed under `docs/dev-run-transcripts/`.

## Tech stack

Unchanged from the project: TypeScript strict, ESM + NodeNext, TypeBox,
Biome, Vitest, pnpm. The only new dependency surface is the existing
`ExtensionUIContext` from `@earendil-works/pi-coding-agent` (already a
project dep) — **no new packages.**

## Pinned SDK surfaces (verified against SDK dist 2026-06-20)

These are the load-bearing SDK facts this spec's technical approach rests
on. Each was verified against
`node_modules/@earendil-works/pi-coding-agent/dist`, not doc-reading.

1. **`ToolDefinition.execute` receives `ctx: ExtensionContext`**
   (`core/extensions/types.d.ts` L357). `ExtensionContext.ui` is a
   getter (`core/extensions/runner.js` L413) resolving to
   `runner.uiContext`.
2. **`runner.uiContext` is `createAgentSession`'s `uiContext` option**,
   defaulting to `noOpUIContext` when omitted
   (`core/agent-session.js` L1634→L1697; `core/extensions/runner.js`
   L151, L238–239). **Today the conductor omits it**, so role-session
   tools get a no-op UI — `ctx.ui.input()` returns `undefined`, no
   dialog. This is why B is impossible in v1.
3. **`ExtensionUIContext` exposes `input`, `confirm`, `select`, `notify`,
   `setStatus`, `sendMessage`**
   (`core/extensions/types.d.ts` L71–73, L290). `input`/`confirm`/
   `select` return Promises (dialog-bearing in TUI mode); `sendMessage`
   injects a `CustomMessage` entry into the host session view
   (`core/extensions/types.d.ts` L290, rendered in
   `modes/interactive/interactive-mode.js` L2525 via a registered
   message renderer).
4. **`ExtensionCommandContext` (the `ctx` a `/conduct` handler receives)
   extends `ExtensionContext`**, so it carries `ctx.ui:
   ExtensionUIContext` (`core/extensions/types.d.ts` L246, L3).

The bridge is therefore: **pass `ctx.ui` from the `/conduct` handler
through `createProductionHost` → `ProductionHost` → `createAgentSession`
as `uiContext`.** No new SDK surface is required.

## Commands

Unchanged from the project:

```
pnpm typecheck        # tsc --noEmit (strict + noUncheckedIndexedAccess); uses tsconfig.test.json
pnpm build            # emit dist/ with .d.ts
pnpm test             # vitest run (includes grep-guard + package-metadata tests)
pnpm lint             # biome check .
pnpm format:check     # biome format --check .
pnpm audit            # review before release
```

Manual / real-model smoke (post-implementation):

```
pi install -l ./
pi --conduct-manifest <manifest>
/conduct <goal>                # exercise A (streaming) + B (ask_user)
node dist/bin/conduct.js <manifest> <goal>   # CLI fallback: A degrades to stdout; B degrades to stdin readline (see Boundaries)
```

## Project structure (touched files)

New / modified — implementation phase will refine; this is the shape:

```
src/host/
  production-host.ts          # MODIFIED: accept + forward uiContext to createAgentSession
  production-host-factory.ts  # MODIFIED: thread extension.uiContext through CreateProductionHostInputs
  production-host-resolve.ts  # MODIFIED (possibly): nothing if uiContext stays on the host
  tools.ts                    # MODIFIED: add createAskUserTool (new defineTool)
  session-event-handler.ts    # MODIFIED: forward selected events to a display sink
src/extension/
  commands/start.ts           # MODIFIED: pass ctx.ui into createProductionHost; wire display sink to ctx.ui.sendMessage
  commands/resume.ts          # MODIFIED: same wiring for resume
src/core/                     # UNCHANGED. ask_user is FSM-orthogonal (see Invariants).
src/manifest/ src/seam/ src/cost/ src/persistence/  # UNCHANGED.
extensions/conduct.ts         # UNCHANGED except, possibly, a no-op guard for non-TUI modes.
tests/
  host/ask-user-tool.test.ts          # NEW: tool returns the dialog result; no-op in no-UI mode
  host/display-forwarding.test.ts     # NEW: events route to the display sink
  extension/tui-bridge.test.ts        # NEW (stub-driven): ctx.ui is threaded; ask_user reachable
  grep-guard.test.ts                  # UNCHANGED (must still pass — the guardrail)
docs/
  tui-bridge-spec.md          # THIS FILE
  extension-usage.md          # MODIFIED: document streaming + ask_user; fix the records.jsonl layout diagram (Finding 3 from the 2026-06-20 run)
```

No file should approach the ~400 LOC ceiling; `tools.ts` is the likely
growth point and may need a `ask-user-tool.ts` split to stay disciplined.

## Code style

Follows `AGENTS.md` exactly: strict TS, named exports only, JSDoc on
public exports with spec-section pointers, pure functions first, no
silent fallbacks, Biome. A representative style anchor is the existing
`src/host/tools.ts` `createHandoffTool`/`createEndTool` — `ask_user`
will mirror that shape (a `defineTool` factory closed over a seam, with
a `terminate: false` normal result, **not** a terminating result like
`handoff`/`end`).

```ts
// Shape anchor (illustrative, not final):
export function createAskUserTool(ui: ExtensionUIContext): ToolDefinition<…> {
  return defineTool({
    name: "ask_user",
    label: "Ask user",
    description: "Ask the user a clarifying question. Returns their answer.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("input"), Type.Literal("confirm"), Type.Literal("select")]),
      prompt: Type.String(),
      ...(select variants)
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      // ctx.ui is available; but the tool is constructed with `ui`
      // so the seam is explicit. See Invariants §B3.
      const answer = await ui.input("Conductor", params.prompt) ?? "(no answer)";
      return { content: [{ type: "text", text: answer }], details: { kind: params.kind } };
    },
  });
}
```

## Invariants (the discipline this spec adds)

These are non-negotiable. They exist to keep the feature from reopening
FSM boundaries. Reviewers should reject any implementation that violates
them.

### A — Streaming is a display tap, not a session-tree merge

1. Role sessions remain spawned via standalone `createAgentSession` only.
   The grep guard on `extensions/**/*.ts` still rejects
   `ctx.newSession(` and `ctx.fork(`. (§9.5 unchanged.)
2. Streaming forwards **display-only** events into the host TUI via
   `ctx.ui.sendMessage`. It does **not** add role messages to the host
   session's message history. A streamed entry is a `CustomMessage` with
   a conductor-owned `customType` (e.g. `"conduct.role.text"`), rendered
   by a registered message renderer; it is not a user/assistant message
   in pi's session tree.
3. The host's existing event handler
   (`attachSessionEventHandler`) is the single forwarding point — no
   second subscription path. Adding a display sink is an additional
   *output* on the existing handler, not a new control flow.

### B — `ask_user` is FSM-orthogonal

1. **`ask_user` is a tool, not a machine event.** The reducer, the
   `SessionSeam` capture buffer, and the transition records are unchanged
   by it. The loop's single-emission assertion (exactly one
   `handoff`/`end` per session) still holds; `ask_user` writes nothing
   to the capture buffer and returns a normal (non-terminating) tool
   result. The turn continues, exactly as `read`/`bash` do today.
2. **Available to every role.** `buildToolsAllowlist` force-injects
   `ask_user` alongside `handoff`/`end` (or the host wires it via
   `customTools`); role prompts decide when to call it. No gating by
   `is_orchestrator`.
3. **UI access comes from `ctx.ui` on the tool `execute` context**, which
   is populated only when the host passed `uiContext` to
   `createAgentSession`. When `uiContext` is absent (CLI fallback,
   non-TUI mode, tests with no UI), `ask_user` degrades to a defined
   fallback (see Boundaries) — it must **not** silently no-op (AGENTS.md:
   no silent fallbacks); it returns a typed "no UI available" result or
   throws, per the implementation task's decision.
4. **Resume / crash semantics are unchanged.** If the process dies
   mid-`ask_user`, the checkpoint is "session in progress, no transition
   yet" — identical to dying mid-`read`. Resume re-spawns the role from
   the seed and re-asks. The lost answer is consistent with existing
   mid-turn-crash semantics.
5. **Cost caps unaffected.** The per-session cap fires on `message_end`
   token usage. A paused `ask_user` consumes no tokens, so it cannot
   trip the cap. Dialog-level cancellation (for example, `Esc`/`Ctrl+C`
   in the pi TUI prompt) is a normal tool result with no answer/selection;
   the role decides whether to ask again, hand off, or end. Process-level
   abort remains host-owned run cancellation, not an `ask_user` machine
   event.

### C — Layering unchanged

1. `src/core`, `src/manifest`, `src/seam`, `src/cost`, `src/persistence`
   are untouched. Zero new pi imports there. The grep-guard test
   enforces this.
2. `src/host` and `src/extension` may import pi (unchanged posture).
3. `ask_user`'s `defineTool` lives in `src/host/` (like `handoff`/`end`),
   not in the core.

## Testing strategy

- **Unit (Vitest, stub-driven, no API key):**
  - `ask_user` tool: returns the dialog result when a `uiContext`-shaped
    stub is present; returns the defined fallback / throws when absent.
    Verify it writes nothing to a `SessionSeam` capture buffer
    (FSM-orthogonality, Invariant B1).
  - Display forwarding: feed synthetic `AgentSessionEvent`s through the
    event handler with a sink spy; assert the expected `sendMessage`
    payloads are emitted (text, tool call, tool result, handoff reason)
    and that no host session-tree mutation occurs.
  - `ProductionHost.spawnRole` wiring: assert `createAgentSession` is
    called with the `uiContext` passed through the factory (via a spy
    on the session factory, matching the existing stub-provider pattern).
- **Grep guard:** `tests/grep-guard.test.ts` still passes — the
  `extensions/**/*.ts` `ctx.newSession(`/`ctx.fork(` rejection and the
  core no-pi-imports scan are unchanged.
- **Extension integration (stub-driven):** a `/conduct`-shaped handler
  call with a stub `ctx.ui` threads the UI context end-to-end. Spawned-role
  tests cover `ask_user` being force-injected and available to every role.
- **Real-model smoke (manual, filed in `docs/dev-run-transcripts/`):**
  a run where a role asks the user a question, the user answers, and the
  run reaches a terminal state with the answer in the transcript. This
  is the human-eyeball acceptance for both A and B; it is not a CI gate.

Coverage expectation: the new tool + forwarding + wiring get unit tests;
no new coverage threshold is introduced beyond "the new code is tested
and the suite stays green."

## Boundaries

- **Always:**
  - Run `pnpm typecheck && pnpm build && pnpm test && pnpm lint && pnpm
    format:check` before declaring a task done.
  - Keep `ask_user` out of the core; keep the reducer unaware of it.
  - Thread `uiContext` as an explicit field on
    `CreateProductionHostInputs` / `ProductionHostOptions` — no ambient
    globals, no singleton UI.
  - Register a conductor-owned `customType` for streamed entries and a
    message renderer for it; do not reuse pi's built-in message types.
- **Ask first:**
  - Any change to `ExtensionUIContext` consumption that touches modes
    other than `tui` (rpc/json/print) — confirm degradation behavior.
  - Any change to the SDK surface pinned above (i.e., if a pi version
    bump moves `uiContext` or `sendMessage`).
- **Never:**
  - `ctx.newSession(` / `ctx.fork(` in `extensions/`.
  - pi imports in `src/core`/`src/manifest`/`src/seam`/`src/cost`/
    `src/persistence`.
  - Silently no-op `ask_user` when no UI is present (return a typed
    fallback or throw — AGENTS.md "no silent fallbacks").
  - Stream role messages into the host session's message history (that
    reopens §9.5). Display-only `CustomMessage` entries only.
  - Make `ask_user` a machine event / route it through `reduce` /
    persist a transition record for it.

## Resolved questions (human input 2026-06-20, plus SDK-source verification)

1. **Thinking visibility — APPROVED as proposed, then REVERSED 2026-06-20.**
   Originally: text + tool calls + handoff/ask reasons streamed by default;
   raw thinking available but collapsed/toggleable (the encrypted thinking
   blobs from `gpt-5.4-mini` were deemed noisy as a default). **Reversed
   after Phase 5.5:** the human reviewed the run and found the TUI showed no
   reasoning at all — reasoning models emit their reasoning as `thinking`
   content parts (not `text`), and the original extractor skipped thinking,
   so combined with Phase 5.5's tool-event suppression the stream starved.
   The human wants to see what the models are thinking at all times and does
   not care if it floods the session. `extractAssistantText`
   (`src/host/display-sink.ts`) now surfaces non-redacted `ThinkingContent.thinking`
   as part of the `text` display event, joined as its own `\n\n`-separated
   block so reasoning reads as its own paragraph; redacted blocks (opaque
   `thinkingSignature` only) are skipped. Text-only messages are
   byte-identical to the pre-reversal behavior.
   - **`read` clarification (raised by the human):** file reads surface as
     `read` tool calls in the stream — verified: `AgentSessionEvent`
     includes `tool_execution_*` events (`AgentSessionEvent = Exclude<
     AgentEvent, {agent_end, queue_update, compaction_*, ...}>`,
     `core/agent-session.d.ts` L3). The conductor's current handler only
     reads `message_end` (`src/host/session-event-handler.ts` L108); A
     broadens the subscription. **Manifest caveat:** a role can only call
     `read` if its `tools:` allowlist names `read` (strict allowlist,
     `core/sdk.js` L132–135); `tools: [handoff, end]` alone does not.
     Role authors must grant built-in tools explicitly.
2. **`ask_user` degradation in non-TUI modes — DEFERRED to implementer
   (no human opinion).** Per recommendation: throw a typed
   `AskUserUnavailableError` for rpc/json/print modes; fall back to
   stdin readline for the CLI fallback (`src/bin/conduct.ts`). The
   implementer may adjust if the CLI readline proves fiddly; the
   principle is "no silent no-op" (AGENTS.md).
3. **Persist streamed entries — DEFERRED to implementer (no human
   opinion); recommendation adopted.** Streamed entries are
   display-only `CustomMessage`s; they are NOT appended to the
   host-owned `records.jsonl`. The per-role session JSONL is already
   the durable record; duplicating into the run log is redundant state.
4. **Message renderer — NO reinvention needed (SDK-source verified).**
   `CustomMessageComponent` (`modes/interactive/components/custom-message.js`)
   renders `content: string` as themed **markdown** by default via pi's
   `Markdown` component from `@earendil-works/pi-tui` (purple box,
   colored `[customType]` label, markdown body) — no custom renderer
   required for markdown/colored text. **Decision:** ship with the
   default renderer (zero rendering code); a bespoke renderer
   (collapsible role-prefixed sections) is a documented follow-up, not
   v1 of this feature. The human's concern about reinventing the wheel
   is resolved: we leverage pi's existing TUI rendering.
5. **`uiContext` side-effect risk — UNRESOLVED, deferred to the
   implementation spike.** Passing `uiContext` to a spawned session
   *might* affect pi's interactive mode (dialog focus, status-line
   conflicts). The plan's first task is a spike that passes `ctx.ui`
   to one spawned session and observes. If it misbehaves, the
   contingency is a host-routed callback (the host calls `ctx.ui.input`
   on behalf of the tool via a queue) instead of passing the UI context
   directly. This is the one open technical risk; it does not block
   planning.

## Success criteria (restated, testable)

See "Success criteria" under Objective — they are the testable
definition of done. The plan and tasks must derive from them.

## Relationship to existing specs

- **`docs/orchestrator-fsm-spec.md`** — authority for the reducer,
  lifecycle, cost, persistence. **Not modified by this spec.**
  Invariants A/B/C above are carefully scoped to keep it that way.
- **`docs/extension-pivot-plan.md`** / `docs/extension-usage.md` —
  delivery-shape and user-facing surface. `extension-usage.md` will be
  updated to document streaming + `ask_user` and to fix the
  `records.jsonl` layout diagram (Finding 3 from the 2026-06-20 run:
  the file is a flat `<runId>.jsonl` sibling of the run directory, not
  `<runId>/records.jsonl` inside it).
- **`docs/sdk-surface.md`** — pinned SDK primitives. This spec adds
  pinned surfaces (`uiContext`, `ExtensionUIContext.input/confirm/
  select/sendMessage`, `ToolDefinition.execute` ctx). The
  implementation should update `sdk-surface.md` with the verified
  findings above so the next phase isn't re-deriving them.
