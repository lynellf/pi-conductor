# Spec: Combine Tool-Call Status + Invocation Into One Line

> Display-layer refinement for the `/conduct` tool-observability stream.
> Continues the lineage of `docs/tool-observability-and-spinner-spec.md`
> and `docs/tool-ux-refinement-spec.md` (both Phase 7B UX). Touches only
> the display surface — no `docs/orchestrator-fsm-spec.md` changes; the
> core FSM, the durable per-role session JSONL, and all cost/reducer
> invariants are unaffected (the TUI stream is an observability surface,
> not the record of truth — see `src/extension/display-sink-wiring.ts`
> file comment).

## Revision summary

Initial spec. Scope is one display behavior: collapse the current two-block
per-tool-call TUI output (an invocation block, then a separate bare `✓`/`✗`
block) into a **single** block emitted once, at tool completion, that carries
the status marker next to the invocation summary.

## What I found (investigation notes — basis for the plan)

### Current rendering — confirmed against code

A role session's SDK events flow through `attachSessionEventHandler`
(`src/host/session-event-handler.ts`) into a shared `DisplaySink`
(created in `src/extension/display-sink-wiring.ts`), which converts each
event into a pi `CustomMessage`:

1. **`tool_execution_start`** → `formatToolCallSummary(toolName, args)`
   (`src/host/tool-summary.ts`) → emits a `tool_call` `DisplayEvent`
   → `conduct.role.tool` `CustomMessage` with `content = "bash: ls"` etc.
2. **`tool_execution_end`** → `formatToolResultSummary(toolName, result, isError)`
   → emits a `tool_result` `DisplayEvent` → a **second**
   `conduct.role.tool` `CustomMessage` with `content = "✓"` (success) or
   `"✗ <first error line>"` (error).

Each `CustomMessage` is rendered by `buildToolContainer`
(`src/extension/conduct-message-renderer.ts`) as a `Container`:
- `Text` child — dim role label (`TOOL_LABEL_COLOR = "dim"`, prior M2)
- `Markdown` child — the body, blockquote-wrapped (`> ✓` / `> ✗ ...`)

So today the user sees **two blocks per tool call**: an invocation block
(`> bash: ls`) and a separate status block (`> ✓`). The status block's
body is a bare marker — decontextualized (Issue 1: anonymous status),
and the second block exists purely to show a check/cross (Issue 2:
redundant separate line). Matches the screenshot description.

### Correlation primitive — available

The SDK's `tool_execution_start` and `tool_execution_end` session events
**both carry `toolCallId: string`** (verified in
`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:541-559`
and in the bundled core `AgentEvent` at
`node_modules/.pnpm/@earendil-works+pi-agent-core@0.79.1.../dist/types.d.ts:376-391`;
the session re-emits both with `toolCallId` in
`dist/core/agent-session.js:~406,~425`). So start↔end can be correlated
per-tool-invocation.

The end event carries `{ toolCallId, toolName, result, isError }` but
**no `args`** — the args (and thus the invocation summary) are only on the
start event. Therefore the summary must be **buffered at start** and
**combined at end**.

### Sink / renderer seam

- `DisplaySink = (event: DisplayEvent) => void` is created once per
  extension factory (`createConductDisplaySink`) and the host wires the
  **same** sink into every role session (`src/host/production-host.ts:349`),
  so a correlation buffer must be **per-session** (scoped to the
  `onSessionEvent` closure), not on the shared sink.
- The status spinner lives **at the poller level**
  (`src/extension/status.ts` `setStatus(\`${frame} ${formatConductStatus(...)}\`)`)
  and does **not** depend on per-tool `tool_call` start events. Removing
  the start emission does not break the spinner — verified by reading
  `status.ts` (no `tool_call`/in-flight-tool references).
- Machine tools (`handoff`/`end`/`ask_user`) and unknown tools return
  `null` from **both** formatters today → suppressed entirely. The change
  preserves this: they are never buffered and never emitted.

### Edge: no display count assertions in E2E

`tests/host/e2e.test.ts` and `tests/extension/conduct-e2e.test.ts` do not
assert tool-display event counts or sink text. The display path is
exercised only by `tests/host/display-forwarding.test.ts`,
`tests/host/tool-summary.test.ts`, and `tests/extension/tui-bridge.test.ts`
+ `conduct-tool-renderer.test.ts` (the latter two test the sink/renderer in
isolation and remain valid). So the test blast radius is contained.

## Design — resolved format (per user)

Exact format, decided with the user via clarifying questions:

- **Success:** `✓ <summary>` — e.g. `✓ bash: ls`
  (no parentheses; the marker itself is the status.)
- **Error:** `✗ <summary>: <error first line>` — e.g. `✗ bash: ls: command not found: foo`
  (colon separator; if no extractable error line, `✗ <summary>`.)
- **Truncation:** the whole combined line is tail-truncated to a new
  `MAX_TOOL_LINE_DISPLAY_LENGTH = 100` chars with `…` (U+2026) when
  exceeded. Replaces the current per-part limits for the *combined* line;
  `MAX_BASH_COMMAND_DISPLAY_LENGTH` (60) and the error-extraction logic
  are retained unchanged at the formatter internals.
- **Role label:** KEEP the dim role label above the combined body row
  (consistent with how tool messages render today; honors prior M2).
- **Single combined `conduct.role.tool` block** per tool call, emitted on
  `tool_execution_end` only. The host will **no longer emit `tool_call`
  DisplayEvents** (buffered, not displayed).

## Open concern flagged (in-flight feedback vs. single-line goal)

> **Planner override disclosed (review nit 5).** The user's clarifying answer
> selected Option A (show `… <summary>` at start, replaced by the combined
> `✓/✗ …` line at end) under the assumption that pi `CustomMessage`s support
> edit/replace; they do not — `CustomMessage`s are append-only. The planner is
> therefore overriding the in-flight answer in favor of the primary single-line
> goal (suppress the start emission, lean on the global status-line spinner).
> If the user wants the two-line model instead, switch Task 2 in the plan to
> Option C (emit `… <summary>` at start AND the combined `✓/✗ …` line at end,
> explicitly accepting two persisted lines per tool).

The user's stated primary goal (the `brief`) is "**one line … that's it**"
(single combined line, no redundant separate line). When asked about
in-flight feedback, the user selected "show a bare `… <summary>` at start,
replaced by the combined `✓/✗ …` line at end."

**Conflict:** pi `CustomMessage`s are **append-only** — there is no
update/replace primitive on `display: true` custom messages. An in-flight
start line and a completion end line would **both persist** — i.e. still
two lines per tool call, which is exactly the "redundant separate line"
the primary goal wants gone. Option C therefore resolves Issue 1
(anonymous status) but **not** Issue 2.

**Recommended resolution (this plan's default):** **suppress the start
emission entirely**; emit the single combined line at end, and lean on
the **existing global status-line spinner** ("conduct: … · running · …")
for in-flight feedback. This honors the primary goal (true single line per
tool) and keeps the in-flight signal at the status bar, where it already
lives.

This is recorded as the top open concern for the user to confirm at review.
If the user instead wants in-flight per-tool disclosure, the fallback is
Option C with the explicit trade-off: **two persisted lines per tool call**
(start = `… <summary>`, end = `✓/✗ <summary>...`). No middle ground exists
without an edit/replace primitive the SDK does not provide.

## Edge cases

- **Tool errors (the `✗` path):** `✗ <summary>: <error first line>`,
  error extracted via the existing D1 extraction order, first line only,
  whole line truncated to 100.
- **No extractable error line:** `✗ <summary>` (marker + summary).
- **Truncated/partial results:** the durable record (SDK session JSONL in
  `<cwd>/.pi-conductor/runs/<run_id>/sessions/`) is untouched — the TUI
  stream has always been a summary, not the full body. No change.
- **Tools without a natural summary:** covered by existing
  `formatToolCallSummary` fallbacks (`read: <no path>`, `bash: <no command>`,
  etc.). The combined line becomes `✓ read: <no path>`.
- **Long summaries:** combined line truncated to 100 (see Design).
- **Unknown / built-in non-summary tools:** unchanged — suppressed (never
  buffered, never emitted).
- **Machine tools (`handoff`/`end`/`ask_user`):** unchanged — suppressed
  at the formatter level (never buffered). This change applies **only to
  observable built-in tools** (`read`, `bash`, `edit`, `write`, `grep`,
  `find`, `ls`). It does NOT surface machine tools; those remain protocol
  noise surfaced elsewhere.
- **Orphaned start (start buffered, end never arrives — e.g. abort):**
  the buffered summary is **dropped silently** at session teardown (the
  per-session closure is GC'd). Phase 1 does **not** flush orphaned
  summaries; deferred to a follow-up (see Remaining work). Documented so
  it is a known limitation, not a silent gap.
- **Concurrent in-flight tools within one turn:** each emits its own
  combined line on its own `tool_execution_end`, in completion order
  (same as today's `tool_result` ordering). No interleaving correctness
  issue; the per-session buffer is keyed by `toolCallId`.

## Scope — layer boundary

This is a **display-layer change only**:

- `src/host/tool-summary.ts` (pure formatter) — **add** `formatToolCompletedLine`
  and `MAX_TOOL_LINE_DISPLAY_LENGTH`. No SDK import (already none). The
  module location rationale note already says it could live in `src/seam/`,
  so adding a pure display helper here is non-breaking and keeps the
  blast radius to the two consumer modules.
- `src/host/session-event-handler.ts` — **add** a per-session pending
  buffer (`Map<toolCallId, summary>`) and switch from two-event emission
  to one combined event on `tool_execution_end`. Host is permitted pi
  imports; this change adds none.
- `tests/host/tool-summary.test.ts`, `tests/host/display-forwarding.test.ts`
  — update assertions to the combined line; add new cases.

**Not changed:** `src/core/**`, `src/seam/**`, `src/cost/**`,
`src/persistence/**`, `src/manifest/**` (grep-guard stays green — no new
pi imports, and none in core). `src/extension/conduct-message-renderer.ts`
renderer is unchanged (the body content changes, the renderer logic does
not — the prior M1/M2 decisions stand). `src/extension/display-sink-wiring.ts`
unchanged (it still maps `tool_result` → `conduct.role.tool`; forwarding a
`tool_call` if ever pushed still works — the host simply stops pushing
them).

The change **does not** reach into role-session tool calls differently
than today: the shared sink already surfaces tool activity from spawned
role sessions uniformly. This applies to all observable tool calls across
orchestrator + worker roles, exactly as the existing behavior does.

## Spec impact (orchestrator-fsm-spec)

None. `docs/orchestrator-fsm-spec.md` has no section enumerating TUI
display rules — display behavior is owned entirely by the Phase 7B UX
shell specs (`tool-observability-and-spinner-spec.md`,
`tool-ux-refinement-spec.md`, and now this one). §11 "Persistence and
observability" covers the durable record JSONL, which this change does
not touch.

---

## Archive note

Phase 1 of this spec was implemented and shipped on **2026-06-24**.
See `docs/archive/tool-display-combine-status/phase-1-combine-tool-line.md`
for the full plan-status record, reviewer verdicts, and deferred follow-ups.
This specification document is archived alongside the phase plan.
