# Spec: Tool Observability + Loading Indicator for `/conduct`

## Revision summary (plan-reviewer-b pass → single-revision fix)

This revision resolves five findings from `plan-reviewer-b`'s second-pass
review. All five are concrete (each has a discrete acceptance signal); none
is stylistic.

- **C1 — spinner placement internally contradictory + breaks 7+ existing
  `formatConductStatus` tests.** §5's narrative already says "Prepend the
  frame to the status line when the run is active (poller-level)," but the
  Task 7B.UX.5 bullet said "Prepend spinner frame to `formatConductStatus`
  output" (formatter-level) — a direct contradiction. `tests/extension/status.test.ts`
  has 7+ string-equality assertions on the `running` case (e.g. line 80:
  `expect(line).toBe("conduct: orchestrator · running · handoffs=0 · $0.000 · Esc abort")`)
  that a formatter-level prepend would break. **Chosen fix: the preferred
  path (C1-P).** The spinner prepend moves into the poller's tick path —
  `formatConductStatus` stays pure, all existing status tests stay green, and
  §5's "purely cosmetic, cycles on the 250ms poll interval" narrative is
  honored verbatim. The 7B.UX.5 bullet is corrected to "poller-level, NOT
  inside `formatConductStatus`"; `tests/extension/status.test.ts` is **not**
  added to the Files-touched MODIFY list (it stays green).
- **C2 — `tests/host/display-forwarding.test.ts` will fail with the new
  formatter.** Task 7B.UX.2 swaps `stringifyDisplayValue` for
  `formatToolCallSummary`/`formatToolResultSummary`; the existing test at
  `tests/host/display-forwarding.test.ts:124-129` asserts the old text
  verbatim (`'bash: {"command":"ls"}'` and `'bash: {"ok":true}'`); the new
  formatter produces `'bash: ls'` and `'✓'`. **Fix:** add
  `tests/host/display-forwarding.test.ts` to the Files-touched MODIFY column
  with the precise fixture updates + a new error-path case; revise the
  7B.UX.2 acceptance to match the new compact format.
- **M1 — Tool-renderer body shape is implicit (builder trap).** §4 says "no
  markdown body" but the existing `buildContainer` always wraps the body in
  `Markdown`. **Fix:** add one sentence pinning the body as a `Text` child
  (not `Markdown`), plus the matching test assertion in 7B.UX.4.
- **M2 — Tool-renderer role label is ambiguous.** §4 says "muted-colored
  tool icon + the formatter-produced text" then "Reuses the existing
  role-label color logic" — "tool icon" is undefined. **Fix:** pin the label
  as `details.role` text with a new `TOOL_LABEL_COLOR` (distinct from
  `ORCHESTRATOR`/`WORKER`/`UNKNOWN`); add the discriminating test in 7B.UX.4.
- **N1 — Bash truncation under-specified.** `MAX_BASH_COMMAND_DISPLAY_LENGTH
  = 60`, "tail-truncated", but no ellipsis char or boundary rule.
  **Fix:** slice to `MAX - 1` (59) chars and append `…` (U+2026) for a total
  of 60; commands ≤ 60 render verbatim. Add the expected output to the
  table-driven test in 7B.UX.1.

What changed in the bodies below: §1 (N1 ellipsis rule), §4 (M1 + M2 pins),
§5 unchanged (already poller-level), task 7B.UX.1 (N1 long-bash case),
7B.UX.2 (C2 acceptance), 7B.UX.4 (M1 + M2 tests), 7B.UX.5 (C1 bullet fix), and
the Files-touched summary (C2 adds `tests/host/display-forwarding.test.ts`).

## What I found (investigation notes)

### Tool event pipeline — the seam already exists

The host's `session-event-handler.ts` already intercepts
`tool_execution_start` and `tool_execution_end` events from each
role session's `AgentSession` event stream (via `session.subscribe()`).
It emits `DisplayEvent` objects with `kind: "tool_call"` /
`"tool_result"` through the `DisplaySink` interface.

The display sink in `src/extension/display-sink-wiring.ts` currently
**suppresses all tool events** (Phase 5.5 remediation). Only `text`
events become `CustomMessage`s. The file-level doc explicitly
anticipates this feature:

> "A future phase that wants non-JSON tool rendering in the TUI
> re-introduces a `conduct.role.tool` `customType` + a structured
> renderer."

So this feature is the "future phase" the existing code anticipated.

### Current tool event formatting (the problem)

`session-event-handler.ts` formats tool events as:
```ts
// tool_call:
`${event.toolName}: ${stringifyDisplayValue(event.args)}`
// tool_result:
`${event.toolName}: ${stringifyDisplayValue(event.result)}`
```
`stringifyDisplayValue` JSON-stringifies the entire args/result
object — this is what the user wants to avoid (full tool bodies
flood the TUI).

### Spinner — the working-indicator APIs won't work for conductor

The `ExtensionUIContext` (accessible via `ctx.ui`) provides:
- `setWorkingMessage(message?)` — types.d.ts L90
- `setWorkingVisible(visible)` — types.d.ts L91
- `setWorkingIndicator(options?)` — types.d.ts L92

**However**, the interactive mode gates these on
`session.isStreaming` — captured in prose (not file:line, which drifts across SDK upgrades): the working-indicator APIs (`setWorkingMessage` / `setWorkingVisible` / `setWorkingIndicator`) are gated on `session.isStreaming` in the interactive-mode module. The conductor's role sessions are standalone `AgentSession` instances spawned via `createAgentSession` — not the interactive session, so the gate is `false`
during a `/conduct` run (the interactive pi session is awaiting
`handle.completion()` in the command handler). So the working
indicator is invisible during conductor runs regardless of what we
set. Verified against `@earendil-works/pi-coding-agent@0.79.1`.

The `setStatus(key, text)` API (types.d.ts L88) IS always available.
The status poller (`src/extension/status.ts`) already runs at 250ms
and updates the footer via `ctx.ui.setStatus("conduct", text)`. This
is the cleanest channel for a spinner — we cycle a spinner frame on
each tick.

### Tool input schemas (from pi SDK)

The SDK exposes typed tool-call events with structured `args`:

| Tool | Schema fields | Source |
|------|--------------|--------|
| `read` | `{ path, offset?, limit? }` | read.d.ts readSchema |
| `bash` | `{ command, timeout? }` | bash.d.ts bashSchema |
| `edit` | `{ path, edits: [{ oldText, newText }] }` | edit.d.ts editSchema |
| `write` | `{ path, content }` | write.d.ts writeSchema |
| `grep` | `{ pattern, path?, ... }` | grep.d.ts grepSchema |
| `find` | `{ path, ... }` | find.d.ts findSchema |
| `ls` | `{ path, ... }` | ls.d.ts lsSchema |
| custom | `Record<string, unknown>` | types.d.ts L643 |

The conductor's own tools (`handoff`, `end`, `ask_user`) are custom
tools — their args are protocol noise (the Phase 5.5 comment already
identified this). They should be filtered out of the tool display.

### Pi API surface — file:line pointers (pinned)

> SDK version pinned at **`@earendil-works/pi-coding-agent@0.79.1`**.
> Line numbers below are investigation aids and may drift across SDK
> upgrades; the spinner-gating fact the plan depends on is captured
> in prose (not line numbers) in the "Spinner" section above.

All paths relative to
`node_modules/@earendil-works/pi-coding-agent/dist/`:  

| API | Location | Notes |
|-----|----------|-------|
| `AgentSessionEvent` (tool events) | `core/agent-session.d.ts` L20-47 | `tool_execution_start`/`end` inherited from `AgentEvent` (`@earendil-works/pi-agent-core` types.d.ts L354-389) |
| `ToolExecutionStartEvent` | `core/extensions/types.d.ts` L541-546 | `{ type, toolCallId, toolName, args }` |
| `ToolExecutionEndEvent` | `core/extensions/types.d.ts` L556-561 | `{ type, toolCallId, toolName, result, isError }` |
| `ExtensionUIContext.setStatus` | `core/extensions/types.d.ts` L88 | `setStatus(key, text \| undefined)` |
| `ExtensionUIContext.setWorkingMessage` | `core/extensions/types.d.ts` L90 | **Gated on `session.isStreaming` — won't show during conductor runs** |
| `ExtensionUIContext.setWorkingVisible` | `core/extensions/types.d.ts` L91 | **Same gating — won't show** |
| `ExtensionUIContext.notify` | `core/extensions/types.d.ts` L82 | Ephemeral toasts; not for stream tool display |
| `ExtensionAPI.sendMessage` | `core/extensions/types.d.ts` L861 | How the display sink emits `CustomMessage`s |
| `ExtensionAPI.registerMessageRenderer` | `core/extensions/types.d.ts` L859 | Registers `conduct.role.tool` renderer |
| `WorkingIndicatorOptions` | `core/extensions/types.d.ts` L54-59 | `{ frames?, intervalMs? }` — won't show (gating) |
| Working indicator gating | `modes/interactive/interactive-mode.js` (pinned `@earendil-works/pi-coding-agent@0.79.1`) | gated on `session.isStreaming`; conductor's role sessions are standalone `AgentSession` instances, not the interactive session, so the gate is false during a `/conduct` run |

---

## Goal

**Surface compact tool-call activity and a loading indicator to the
end-user during `/conduct` runs**, so the session doesn't look idle
during reasoning gaps or client↔server latency.

### Success criteria

1. When a role session calls a built-in tool (`read`, `bash`, `edit`,
   `write`, `grep`, `find`, `ls`), the TUI shows a one-line summary
   with the tool name and the primary target (e.g., `read:
   src/host/loop.ts:1-50`, `bash: pnpm test`, `edit:
   src/core/types.ts (2 edits)`), followed by a `✓` indicator on
   success or a `✗ <first line of the error>` indicator on error
   (Open Q1 — indicator appears in the same tool stream, right
   below the summary line). Full tool result bodies are NOT shown.
2. The conductor's own machine tools (`handoff`, `end`, `ask_user`)
   are NOT shown in the tool stream — they are protocol noise
   (handoff/end notifications already exist via the status poller's
   `onNewTransitions`; `ask_user` is handled by pi's native
   interactive mechanism which blocks the role session and renders
   its own UI, so the conductor's tool stream is intentionally
   silent on it to avoid double-surfacing — Open Q2).
3. The status line shows a cycling spinner character during active
   role sessions, so the user sees the run is alive during reasoning
   gaps.
4. The spinner stops cycling when the run reaches a terminal state.

## Non-goals

- **Full tool body rendering.** The user explicitly asked for "tool
  name and target" only, not full args/result bodies. The per-role
  session JSONL remains the durable record for full tool I/O.
- **`tool_execution_update` streaming.** The SDK emits partial
  results during long-running tools (e.g., bash output). v1 shows
  start/end only; streaming partials is a future enhancement.
- **Re-architecting the display pipeline.** The `DisplaySink` →
  `CustomMessage` seam is the right abstraction. This feature
  re-enables a suppressed path and adds a formatter + renderer — no
  new seams.
- **Using `setWorkingMessage`/`setWorkingVisible`/`setWorkingIndicator`.**
  These are gated on the interactive session's streaming state,
  which is inactive during conductor runs. The status line is the
  spinner channel.

---

## Module/seam breakdown

### 1. `src/host/tool-summary.ts` (NEW — pure, host-agnostic)

**File-level docstring (to be carried into the new file):** "sits in
`host/` only because the consumer is here, not because the formatter
itself depends on the SDK." (Nit 4)

Pure functions for compact tool-call summaries. **No I/O, no pi
imports.** Powers the tool observability surface in the TUI: a summary
line on `tool_execution_start` (e.g., `bash: pnpm test`), then a
`✓` / `✗ <first error line>` indicator line on `tool_execution_end`
(Open Q1 — both events wired through; the formatter decides what to
render).

Exports two functions — one per SDK event (`tool_execution_start`
carries `args` but not `result`; `tool_execution_end` carries `result`
+ `isError` but not `args`):

- `formatToolCallSummary(toolName: string, args: unknown): string | null`
  — the summary line for `tool_execution_start`.
- `formatToolResultSummary(toolName: string, result: string | undefined,
  isError: boolean): string | null` — the
  indicator line for `tool_execution_end`:
  - success (`!isError`) → `✓`
  - error (`isError`) → `✗ <first line of the error result>` (first
    line = substring up to the first `\n`)

Both return `null` for conductor machine tools (`handoff`, `end`,
`ask_user`) — protocol noise already surfaced elsewhere (handoff/end
via the status poller's `onNewTransitions`; `ask_user` via pi's native
interactive mechanism — see Open Q2). Unknown tools also return
`null` (suppressed — safer than showing raw JSON).

Format per tool (start summaries):
- `read` → `read: <path>` or `read: <path>:<offset>-<offset+limit>`
- `bash` → `bash: <command>`. When `command` is longer than `MAX_BASH_COMMAND_DISPLAY_LENGTH` (60) chars, tail-truncate: slice the command to `MAX_BASH_COMMAND_DISPLAY_LENGTH - 1` (59) chars and append `…` (U+2026), yielding exactly 60 chars including the ellipsis. Commands ≤ 60 chars render verbatim with no ellipsis (boundary rule: the `>` comparator, so a command of exactly 60 chars is rendered as-is).
- `edit` → `edit: <path> (<N> edits)` or `edit: <path>`
- `write` → `write: <path>`
- `grep` → `grep: "<pattern>" in <path>` or `grep: "<pattern>"`
- `find` → `find: <path>`
- `ls` → `ls: <path>`
- `handoff` / `end` / `ask_user` → `null` (suppress)
- unknown → `null` (suppress — safer than showing raw JSON)

Named constant (Nit 6 — no magic number) where bash truncation lands:

```ts
/** Maximum length of a rendered `bash` command in the TUI
 *  tool-observability line. Long commands are tail-truncated to
 *  keep the line readable.
 *
 *  Truncation rule: when `command.length` > MAX, slice to
 *  `MAX - 1` (59) chars and append `…` (U+2026) for a total of
 *  60 chars including the ellipsis. Commands <= MAX render
 *  verbatim (the `>` boundary, so exactly-60 is as-is). */
export const MAX_BASH_COMMAND_DISPLAY_LENGTH = 60;
```

Lives in `src/host/` because it's consumed by
`session-event-handler.ts` (host layer); the function itself has no
SDK dependency, so a future relocation to `src/seam/` or
`src/extension/` is non-breaking. Testable in isolation with
table-driven tests.

### 2. `src/host/session-event-handler.ts` (MODIFY — use the formatters)

Change the `tool_execution_start` handler to call
`formatToolCallSummary` instead of `stringifyDisplayValue`, and the
`tool_execution_end` handler to call `formatToolResultSummary` (Open
Q1 — wire the end event through; the formatter decides what to
render). Both call paths filter machine tools via the formatters;
only non-null summaries emit a `DisplayEvent`:

```ts
if (event.type === "tool_execution_start") {
  const summary = formatToolCallSummary(event.toolName, event.args);
  if (summary !== null) {
    onDisplay?.({ role, kind: "tool_call", text: summary });
  }
  return;
}

if (event.type === "tool_execution_end") {
  const result = formatToolResultSummary(event.toolName, event.result, event.isError);
  if (result !== null) {
    onDisplay?.({ role, kind: "tool_result", text: result });
  }
  return;
}
```

**Nit 1 decision — remove the now-dead `stringifyDisplayValue`.**
Both of its callsites in this file are replaced by the new
formatters, so `stringifyDisplayValue` in
`src/host/display-sink.ts` becomes dead code. **Decision: remove it
(YAGNI).** It is a private helper NOT re-exported from
`host/index.ts` (that barrel re-exports only the `DisplayEvent` /
`DisplayEventKind` / `DisplaySink` *types* from `display-sink.ts`;
verified by reading `host/index.ts`), so no call-site or re-export
cleanup is needed beyond `display-sink.ts` itself. Rationale: keeping
an unused private helper adds noise with no consumer; if a future
need arises it is a one-function restore. The grep-guard test is
unaffected (`display-sink.ts` has no pi imports).

### 3. `src/extension/display-sink-wiring.ts` (MODIFY — re-enable tool events)

Stop suppressing `tool_call` and `tool_result` events (Open Q1 — both
wired through; the formatter already produced the indicator text for
`tool_result`). Emit both as `CustomMessage`s with the
`conduct.role.tool` customType:

```ts
if (event.kind === "text") {
  // existing path — conduct.role.text
} else if (event.kind === "tool_call" || event.kind === "tool_result") {
  sendMessage({
    customType: "conduct.role.tool",
    content: event.text,
    display: true,
    details: { role, kind: "tool", is_orchestrator },
  });
}
```

`Details.kind` is widened to `"text" | "tool"` (see §6). The sink
stamps `kind: "tool"` for both `tool_call` and `tool_result`; the
content carries the formatter's summary or `✓`/`✗` indicator
already, so the renderer does not need a third discriminator.

### 4. `src/extension/conduct-message-renderer.ts` (MODIFY — add tool renderer)

Add a `conduct.role.tool` entry to the renderer record. The renderer
produces a compact one-line `Container`. **Role label (M2):** the label is
`details.role` (the role name, e.g. `worker` / `orchestrator`), colored
with a **new** `TOOL_LABEL_COLOR` constant — distinct from
`ORCHESTRATOR_LABEL_COLOR` / `WORKER_LABEL_COLOR` / `UNKNOWN_LABEL_COLOR`
so a test can discriminate it. Do NOT reuse the existing
`pickLabelColor` color logic; the tool renderer's label is muted (a
secondary surface, not a structural body anchor). **Body (M1):** the
summary/indicator text is a single line, not markdown, so the body child
is a **`Text`** component, NOT `Markdown` (the existing `buildContainer`
for `conduct.role.text` wraps the body in `Markdown` — the tool renderer
does not).

### 5. `src/extension/status.ts` (MODIFY — add spinner frame)

Add a spinner frame counter to the status poller. On each tick,
cycle through `["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]`
(braille spinner). Prepend the frame to the status line **in the
poller's tick path** when the run is active (`exitReason === "running"`) —
NOT inside `formatConductStatus` (C1: `formatConductStatus` stays a pure
function; the 7+ string-equality assertions in `tests/extension/status.test.ts`
target it directly and must stay green). `setStatus` receives `${frame} ${line}`
while running and the bare `${line}` otherwise; clear the frame on terminal.

The spinner is purely cosmetic — it cycles on the existing 250ms
poll interval. No new timers, no new pi API calls.

### 6. `src/extension/conduct-message-renderer.ts` — `ConductMessageKind` type (MODIFY)

Widen `ConductMessageKind` from `"text"` to `"text" | "tool"` and
update the `ConductMessageDetails` type to carry the tool kind. Only
two kinds are surfaced (`text` and `tool`); the sink folds both
`tool_call` and `tool_result` DisplayEvents into `kind: "tool"`, so
the renderer does not need a third discriminator (the formatter's
content already carries the `✓` / `✗` marker for end events).

### Files touched summary

| File | Action | LOC delta (est.) |
|------|--------|-----------------|
| `src/host/tool-summary.ts` | NEW | ~120 (two formatters + `MAX_BASH_COMMAND_DISPLAY_LENGTH` + docstring) |
| `src/host/session-event-handler.ts` | MODIFY | ~15 (swap to two formatters, drop `stringifyDisplayValue` import) |
| `src/host/display-sink.ts` | MODIFY | −7 (remove now-dead `stringifyDisplayValue`, Nit 1) |
| `src/extension/display-sink-wiring.ts` | MODIFY | ~15 (re-enable `tool_call` + `tool_result`, new customType) |
| `src/extension/conduct-message-renderer.ts` | MODIFY | ~30 (add tool renderer, widen kind type) |
| `src/extension/status.ts` | MODIFY | ~15 (spinner frame counter) |
| `tests/host/tool-summary.test.ts` | NEW | ~85 (table-driven tests for both formatters incl. ✓/✗ + N1 long-bash case) |
| `tests/host/display-forwarding.test.ts` | MODIFY | ~20 (C2: flip two verbatim tool-text assertions to the new compact format `'bash: ls'` / `'✓'`; add an error-path `'✗ <first line>'` case) |
| `tests/extension/status-spinner.test.ts` | NEW | ~30 (spinner frame cycling test) |
| `tests/extension/conduct-tool-renderer.test.ts` | NEW | ~50 (renderer returns compact container for both call + result content) |
| `tests/extension/conduct-message-renderer.test.ts` | MODIFY | ~10 (flip `Object.keys` assertion: one key → two — Nit 2) |
| `tests/extension/conduct-registration.test.ts` | MODIFY | ~5 (flip `has("conduct.role.tool")` false → true; assert function — Nit 2) |
| `tests/extension/tui-bridge.test.ts` | MODIFY | ~15 (flip two sink tests: tool events now emit `conduct.role.tool` — Nit 3) |

---

## Phase plan

This work fits under **Phase 7B extension work** (the UX shell). It
does not touch the pure core, the reducer, persistence, or the
orchestration loop's control flow. It is a display-layer feature
that re-enables a suppressed path and adds a formatter + spinner.

### Task 7B.UX.1 — Tool summary formatter (pure, testable first)

- [ ] Create `src/host/tool-summary.ts` with `formatToolCallSummary`
  and `formatToolResultSummary` (Open Q1 — two formatters, one per
  SDK event). Export the named constant
  `MAX_BASH_COMMAND_DISPLAY_LENGTH = 60` (Nit 6 — no magic number).
- [ ] Start the file with the docstring: "sits in `host/` only
  because the consumer is here, not because the formatter itself
  depends on the SDK." (Nit 4)
- [ ] Table-driven tests in `tests/host/tool-summary.test.ts`:
  - Each known tool (read, bash, edit, write, grep, find, ls) for
    `formatToolCallSummary`
  - Conductor tools (handoff, end, ask_user) → `null` for BOTH
    formatters
  - Unknown tool → `null` (both formatters)
  - Missing/optional fields (e.g., read without offset/limit)
  - `formatToolResultSummary`: success (`!isError`) → `✓`; error
    (`isError`) → `✗ <first line of the result>` (first-line
    extraction)
  - **Long-bash truncation case (N1):** a `bash` command of e.g. 80 chars
    asserts `formatToolCallSummary` returns `'bash: ' + command.slice(0, 59)
    + '…'` (60 chars total incl. ellipsis); a command of exactly 60 chars
    asserts it renders verbatim (no ellipsis) — pin the `>` boundary.
- [ ] Acceptance: `pnpm test` green; `pnpm typecheck` clean.
- [ ] Verify: `pnpm test tests/host/tool-summary.test.ts`

### Task 7B.UX.2 — Wire formatters into session event handler

- [ ] Modify `session-event-handler.ts` to use `formatToolCallSummary`
  for `tool_execution_start` events and `formatToolResultSummary`
  for `tool_execution_end` events (Open Q1 — BOTH events wired
  through; the formatters filter machine tools to `null`).
- [ ] Remove the `tool_execution_end` suppression — the handler now
  emits a `tool_result` `DisplayEvent` with the formatter's indicator
  text. The cap/model-error logic in this handler is unaffected.
- [ ] Remove the now-dead `stringifyDisplayValue` from
  `src/host/display-sink.ts` (Nit 1 — verified NOT re-exported by
  `host/index.ts`, which re-exports only the `DisplayEvent` /
  `DisplayEventKind` / `DisplaySink` *types*; no call-site cleanup
  outside this file). Also drop it from the import line in
  `session-event-handler.ts`.
- [ ] Acceptance: `tests/host/display-forwarding.test.ts` is **updated to
  match the new compact format** (C2). The two verbatim assertions at lines
  124-129 flip:
  - `tool_call` `text: 'bash: {"command":"ls"}'` → `text: 'bash: ls'`
    (the formatter's `formatToolCallSummary("bash", { command: "ls" })`)
  - `tool_result` `text: 'bash: {"ok":true}'` → `text: '✓'`
    (the formatter's `formatToolResultSummary("bash", { ok: true }, false)`)
  - Add a **new error-path case**: emit a `tool_execution_end` with
    `isError: true` and a multi-line error result; assert `onDisplay` is
    called with `text: '✗ <first line>'` (first line = substring up to the
    first `\n`).
- [ ] Verify: `pnpm test tests/host/display-forwarding.test.ts` AND
  `pnpm test tests/host/`

### Task 7B.UX.3 — Re-enable tool events in display sink

- [ ] Modify `display-sink-wiring.ts` to emit `tool_call` AND
  `tool_result` events as `conduct.role.tool` custom messages (Open
  Q1 — both tool events wired through; the formatter already
  produced the indicator text for `tool_result`).
- [ ] Update `ConductMessageKind` and `ConductMessageDetails` types.
- [ ] Acceptance: `pnpm typecheck` clean; the direct
  `createConductDisplaySink` unit tests in
  `tests/extension/tui-bridge.test.ts` (describe block "Phase 2 + 5
  display sink wiring") updated as follows (Nit 3 — pick named
  file/tests, no vague "existing display sink tests"):
  - the "emits only text events… tool calls and tool results are
    suppressed" case → flip to "emits text as `conduct.role.text`
    and tool_call / tool_result as `conduct.role.tool` with compact
    summaries; full tool bodies NOT shown";
  - the "suppresses tool_call and tool_result events entirely"
    case → narrow to machine-tool suppression only
    (`handoff`/`end`/`ask_user` still emit no `CustomMessage`;
    built-in tools now emit `conduct.role.tool`).
  - Update the stale comment in `tests/extension/conduct-harness.ts`
    (states `conduct.role.tool` was removed — restore the original
    intent). Comment-only; no assertion changes there.
- [ ] Verify: `pnpm test tests/extension/tui-bridge.test.ts`

### Task 7B.UX.4 — Register tool message renderer

- [ ] Add a `conduct.role.tool` renderer to
  `createConductMessageRenderers` in `conduct-message-renderer.ts`.
- [ ] Renderer: compact one-line `Container`. The label is `details.role`
  (the role name) colored with `TOOL_LABEL_COLOR` — NOT `pickLabelColor`
  and NOT any of `ORCHESTRATOR`/`WORKER`/`UNKNOWN` colors (M2). The body is
  a `Text` child (the formatter-produced text), NOT `Markdown` (M1): for
  `tool_call` the summary line (e.g., `bash: pnpm test`); for `tool_result`
  the indicator (`✓` or `✗ <first error line>`, Open Q1).
- [ ] Tests in `tests/extension/conduct-tool-renderer.test.ts`:
  - Renderer returns a `Container` for a `tool_call` summary
  - Renderer returns a `Container` for a `tool_result` indicator
    (`✓` and `✗` paths)
  - Renderer returns `undefined` on throw (defense-in-depth)
  - `createConductMessageRenderers` returns BOTH `conduct.role.text`
    and `conduct.role.tool` keys
  - **Body is `Text`, not `Markdown` (M1):** assert the tool renderer's
    returned `Container` has a `Text` child carrying the summary text and
    NO `Markdown` child (contrast with the `conduct.role.text` renderer,
    whose `Container` has a `Markdown` child). Discriminate by `child
    instanceof Markdown` being false for the tool case.
  - **Role label uses `TOOL_LABEL_COLOR` (M2):** assert the tool
    renderer's label is colored with the `TOOL_LABEL_COLOR` constant
    (distinct from `ORCHESTRATOR_LABEL_COLOR` / `WORKER_LABEL_COLOR` /
    `UNKNOWN_LABEL_COLOR`). Discriminating test: render a tool message
    with `details.is_orchestrator === true` and assert the label color
    is `TOOL_LABEL_COLOR`, NOT `ORCHESTRATOR_LABEL_COLOR` (proves the
    tool renderer does not reuse `pickLabelColor`).
- [ ] Existing assertion updates (Nit 2 — these currently encode
  the Phase 5.5 YAGNI removal and will fail after the build):
  - `tests/extension/conduct-message-renderer.test.ts` — the case
    asserting `Object.keys(renderers)` previously matched the single-key array `["conduct.role.text"]` (~line 111) — it now flips to expect TWO keys
    `["conduct.role.text", "conduct.role.tool"]`; the companion
    `expect(renderers["conduct.role.tool"]).toBeUndefined()` flips
    to `.toBeTypeOf("function")`. Update that test's title/comments
    too (Phase 5.5 YAGNI → restored feature).
  - `tests/extension/conduct-registration.test.ts` — the case
    asserting `ext.messageRenderers.has("conduct.role.tool")` is
    `false` (~lines 97-111) flips to `true`, and add
    `.toBeTypeOf("function")`. The registration test now affirms
    the extension wires BOTH renderers at `loadExtension` time.
- [ ] Verify:
  `pnpm test tests/extension/conduct-tool-renderer.test.ts`
  `pnpm test tests/extension/conduct-message-renderer.test.ts`
  `pnpm test tests/extension/conduct-registration.test.ts`

### Task 7B.UX.5 — Status line spinner

- [ ] Add spinner frame array + counter to `startStatusPoller` in
  `status.ts`.
- [ ] **Prepend the spinner frame to the status line in the poller's
  tick path — NOT inside `formatConductStatus`.** `formatConductStatus`
  stays pure (C1 preferred path): it continues to return the bare line
  (e.g. `conduct: orchestrator · running · handoffs=0 · $0.000 · Esc abort`)
  and the poller prepends `${frame} ` only when `stats.exitReason ===
  "running"`, before calling `setStatus`. This keeps `tests/extension/status.test.ts`
  green without modification (its 7+ string-equality assertions target
  `formatConductStatus` directly, which is unchanged).
- [ ] No spinner on terminal states (the poller clears the line on
  terminal, as it already does).
- [ ] Tests in `tests/extension/status-spinner.test.ts` (NEW):
  - Spinner frame cycles across ticks (assert the frame advances across
    two consecutive `setStatus` calls while `exitReason === "running"`)
  - No spinner on terminal states (assert the status line passed to
    `setStatus` is bare — no leading spinner char — on a non-running
    `exitReason`)
  - `formatConductStatus` still returns the bare line (regression guard:
    the spinner is poller-owned, not formatter-owned)
- [ ] Verify: `pnpm test tests/extension/status-spinner.test.ts`
  AND `pnpm test tests/extension/status.test.ts` (must remain green)
- [ ] Do NOT add `tests/extension/status.test.ts` to the Files-touched
  MODIFY column — it stays green under the preferred path.

### Task 7B.UX.6 — Full gate

- [ ] `pnpm typecheck` — clean
- [ ] `pnpm build` — emits `dist/` with `.d.ts`
- [ ] `pnpm test` — all green (including grep-guard)
- [ ] `pnpm lint` / `pnpm format:check` — clean
- [ ] Manual UX verification (see below)

---

## Verification

### Automated

- `pnpm typecheck` — strict + `noUncheckedIndexedAccess` +
  `exactOptionalPropertyTypes` + `verbatimModuleSyntax`
- `pnpm test` — all existing tests still pass; new tests for
  `tool-summary.ts`, the tool renderer, and the spinner
- `pnpm lint` / `pnpm format:check` — Biome clean
- `tests/grep-guard.test.ts` — passes (no new pi imports in core;
  `tool-summary.ts` is in `src/host/` which is allowed)

### Manual UX verification

This is a visual feature — automated tests verify the data path but
not the rendered appearance. The manual checklist:

1. Run `/conduct <goal>` with a manifest that has a worker role with
   `read` + `bash` tools.
2. Observe the TUI:
   - Tool calls appear as compact one-liners (e.g., `read:
     src/host/loop.ts:1-50`, `bash: pnpm test`)
   - Full tool args/results are NOT shown
   - The conductor's `handoff`/`end` tools are NOT shown
   - A spinner character cycles in the status line during active
     role sessions
   - The spinner stops when the run reaches terminal state
3. Verify the status line still shows the existing info (state,
   model, effort, handoffs, cost) alongside the spinner.

---

## Decisions (resolved by the overseer)

The open questions raised during planning have been answered. The
decisions are folded into the spec sections above (success criteria,
module breakdown, and task acceptance criteria); this section is the
single self-contained record so a builder need not re-read the review
thread.

### Q1 — Result rendering: show a check/cross indicator (answer A)

The user asked for "at minimum the tool name and target," but the
overseer wanted the run outcome visible too. **Decision: render a
success/error indicator.** Instead of suppressing
`tool_execution_end`, the event is wired through. The formatter
(`formatToolResultSummary`) decides what to render:

- success (`!isError`) → `✓`
- error (`isError`) → `✗ <first line of the error result>`

(The symbols render as a check mark on success, a cross on error.)
This decision is reflected in §1 (two formatters), §2 (both
events wired), §3 (sink emits both), success criteria #1, Task
7B.UX.1, Task 7B.UX.2, and Task 7B.UX.4.

### Q2 — Suppress `ask_user` as protocol noise (answer A)

**Decision: the status line / tool stream suppresses `ask_user`
events.** Rationale (one-line, for the builder and future maintainers):
pi's native `ask_user` mechanism handles the user interaction
— it blocks the role session and renders its own UI — so the
conductor status line is intentionally silent on it to avoid
double-surfacing. The same suppression applies to `handoff`/`end`
(already surfaced via the status poller's `onNewTransitions`; they
have transition records `ask_user` does not). The
`onNewTransitions`-doesn't-cover-`ask_user` gap raised
by the reviewer is acknowledged but not a blocker — it is the
intended consequence of this decision, not an oversight. Reflected in
§1, success criteria #2, and the formatter's machine-tool null
branches.

### Q5 — Standalone spec addendum + feature plan (reviewer-resolved)

**Decision: keep this document standalone** (a spec addendum + feature
plan). Do not promote it to a numbered section of
`docs/orchestrator-fsm-spec.md`. The base spec covers FSM/reducer/
host/persistence; UX presentation evolved during Phase 5/5.5/7B
without a dedicated section and this document is sufficient. No
change beyond the existing structure.

### Q3 / Q4 / Q6 — Standing defaults (no overrule)

These had no overruling answer and stand as written:

- **Q3 — Spinner channel:** the status line (`setStatus`) is the
  channel; `setWorkingMessage` / `setWorkingVisible` /
  `setWorkingIndicator` are gated on `session.isStreaming` and are
  invisible during a `/conduct` run (see the investigation
  "Spinner" section; pinned at `@earendil-works/pi-coding-agent@0.79.1`).
- **Q4 — Spinner character set:** v1 uses braille spinner frames
  (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`).
  No ASCII fallback in v1.
- **Q6 — `tool-summary.ts` location:** lives in `src/host/`
  because its consumer (`session-event-handler.ts`) is there. The
  file-level docstring makes the non-SDK dependency explicit (Nit 4).
