# Plan — Phase 1: Combine tool-call status + invocation into one line

> **Revision 2 (PLAN-REVISED)** — plan-reviewer-a approved with 5 nits; all
> folded into this revision before handoff to plan-reviewer-b. This is a
> revision pass, not a re-plan — no task was added/removed/reordered.
>
> ### Reviewer nits folded (PLAN-REVISED)
> 1. **Task 1 — module JSDoc drift** (breadcrumb above the old "Two pure
>    functions — one per SDK event" line): added an explicit Task-1 bullet to
>    rewrite the top-of-file JSDoc into the three-formatter model
>    (start-summary buffered → legacy end-only → new combined) + the
>    buffer-and-combine flow. Acceptance updated to require it.
> 2. **Task 4 — fixture update lifted to its own bullet** (`call-err` /
>    `call-err-obj`): added a test-design bullet requiring each error-flow
>    test to prepend the matching `tool_execution_start` so the buffer holds
>    a summary; the existing start-less fixtures become a NEW orphaned-end
>    test rather than being folded into the error-flow tests.
> 3. **Task 5 — optional evidence archive**: added an optional note to
>    capture/screenshot a TUI transcript (one success + one error) and link
>    it from Task 5 or attach it under `docs/tool-display-combine-status/`.
>    Optional, not a gate.
> 4. **Task 5 — tick checkboxes in same commit**: added the AGENTS.md reminder
>    to tick `[x]` in the plan-status block in the implementing commit.
> 5. **spec.md — in-flight override made explicit**: added a quoted
>    "Planner override disclosed" paragraph at the top of the *Open concern
>    flagged* section stating the user's answer assumed pi supports replace
>    (it does not), so the planner overrides toward the single-line goal,
>    with the Option C two-line escape hatch.
>
> (Other review confirmations — unchanged: blast radius is exactly the two
> source files + two host tests; grep-guard preserved; `toolCallId`
> start/end correlation verified against SDK types; 5 tasks in dependency
> order.)

> Implements `docs/tool-display-combine-status/spec.md`.
> Sub-plan of the Phase 7B UX tool-observability lineage. Touches two source
> files + two test files. No core / seam / cost / persistence / manifest /
> renderer / sink changes.

## Summary

Collapse the current two-block-per-tool-call TUI output into a single
`conduct.role.tool` block emitted once at `tool_execution_end`, carrying
`✓ <summary>` (success) or `✗ <summary>: <error first line>` (error). The
host buffers the invocation summary (from `tool_execution_start`) keyed by
`toolCallId` and stops emitting `tool_call` display events. A pure
formatter helper `formatToolCompletedLine` builds the combined line.
Whole line truncated to `MAX_TOOL_LINE_DISPLAY_LENGTH = 100` with `…`.

## Files to change

- **`src/host/tool-summary.ts`** — ADD `MAX_TOOL_LINE_DISPLAY_LENGTH`
  (100) and `formatToolCompletedLine(summary, result, isError)`; reuse the
  existing private `extractErrorMessage`/`truncateLine`. `'Tui render.`
  rationale per file.
- **`src/host/session-event-handler.ts`** — ADD a per-session `Map<string,string>`
  pending buffer inside the `onSessionEvent` closure; on start buffer the
  summary and emit nothing; on end look up + delete + emit one combined
  `tool_result` event; no longer emit `tool_call` events.
- **`tests/host/tool-summary.test.ts`** — ADD a `formatToolCompletedLine`
  table (success, error w/ string + object results, no-error-line fallback,
  orphaned-undefined-summary → null, 100-char truncation boundary, machine/
  unknown saturation not reached because summary is undefined).
- **`tests/host/display-forwarding.test.ts`** — UPDATE the combined-flow
  test: start now emits nothing, end emits ONE `tool_result` with
  `✓ bash: ls`; error cases emit `✗ bash: ls: <...>`; add a
  start-without-end case asserting no emit; keep the machine-tool
  suppression assertions (no buffer, no emit).

Unchanged (verified): `src/extension/conduct-message-renderer.ts` (renderer
logic identical; only `content` differs), `src/extension/display-sink-wiring.ts`
(still maps `tool_result`→`conduct.role.tool`), `tests/extension/*`
(sink/renderer tested in isolation), e2e suites (no display assertions),
core/seam/cost/persistence/manifest (invariants intact, grep-guard green).

## Tasks

### Task 1 — Formatter: `formatToolCompletedLine` + `MAX_TOOL_LINE_DISPLAY_LENGTH`

Edit `src/host/tool-summary.ts`.

- Add `export const MAX_TOOL_LINE_DISPLAY_LENGTH = 100;` near the other
  MAX constants. Truncation rule identical to `truncateLine`: when the
  whole combined line `> 100`, slice to `99` + `…`.
- Add:
  ```ts
  /**
   * Build the single combined Tool-observability line emitted at
   * `tool_execution_end` (spec: tool-display-combine-status). The host
   * buffers the invocation summary (from `formatToolCallSummary` at
   * `tool_execution_start`) keyed by `toolCallId` and passes it here.
   *
   * @param summary - The buffered invocation summary (e.g. "bash: ls"),
   *                  or `undefined` when the start was suppressed (machine
   *                  tool / unknown tool / orphaned end-without-start).
   *                  `undefined` → returns `null` (no emit).
   * @param result - The end event `result` (used only for the error line).
   * @param isError - The end event `isError` flag.
   * @returns The combined line, `null` to suppress.
   */
  export function formatToolCompletedLine(
    summary: string | undefined,
    result: unknown,
    isError: boolean,
  ): string | null {
    if (summary === undefined) return null;
    let line: string;
    if (!isError) {
      line = `✓ ${summary}`;
    } else {
      const raw = extractErrorMessage(result);
      const nl = raw.indexOf("\n");
      const first = nl === -1 ? raw : raw.slice(0, nl);
      line = first.length > 0 ? `✗ ${summary}: ${first}` : `✗ ${summary}`;
    }
    return truncateLine(line, MAX_TOOL_LINE_DISPLAY_LENGTH);
  }
  ```
- Keep `formatToolCallSummary` and `formatToolResultSummary` exported
  unchanged (the start buffering and any external callers still use
  `formatToolCallSummary`; `formatToolResultSummary` becomes unused by the
  handler but stays for the existing unit tests and as a fallback).
  Add a one-line comment that the handler now uses
  `formatToolCompletedLine`.
- **Update the top-of-file module JSDoc** (review nit 1). The current block
  opens with "Two pure functions — one per SDK event" and lists only
  `formatToolCallSummary` + `formatToolResultSummary`. Rewrite it to describe
  the **three-formatter** model and the "host buffers the start summary,
  combines at `tool_execution_end`" relationship:
  - `formatToolCallSummary` — start invocation summary (buffered by the
    host, no longer emitted on its own).
  - `formatToolResultSummary` — legacy end-only indicator; retained for
    unit tests/fallback but no longer used by the handler.
  - `formatToolCompletedLine` — the **single combined line** the handler now
    emits at `tool_execution_end`.
  Keep the machine-tool/unknown-tool suppression note (all three return
  `null`). Keep the location-rationale note unchanged.

**Acceptance:** `formatToolCompletedLine` exists and is pure; module still
has no SDK import; file stays under the ~400 LOC ceiling; the top-of-file
JSDoc describes the three formatters and the buffer-and-combine flow.

**Verification:** `pnpm typecheck`.

### Task 2 — Host: per-session pending buffer + one combined event

Edit `src/host/session-event-handler.ts`.

- Import `formatToolCallSummary`, `formatToolCompletedLine`.
- Stop importing `formatToolResultSummary` at the handler (remove the now-
  unused import to keep `pnpm lint` clean). Note: keep it EXPORTED from
  `tool-summary.ts` (Task 1 keeps it).
- In `attachSessionEventHandler`, create a per-session closure map:
  ```ts
  const pending = new Map<string, string>();
  ```
- Update `onSessionEvent`:
  - `tool_execution_start`:
    ```ts
    const summary = formatToolCallSummary(event.toolName, event.args);
    if (summary !== null) pending.set(event.toolCallId, summary);
    // do NOT emit a tool_call event (spec: buffered)
    return;
    ```
  - `tool_execution_end`:
    ```ts
    const summary = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    const line = formatToolCompletedLine(summary, event.result, event.isError);
    if (line !== null) onDisplay?.({ role, kind: "tool_result", text: line });
    return;
    ```
- Comment why the buffer is per-session (the shared `displaySink` is wired
  into every role session; toolCallId is unique within a session, so a
  closure-scoped Map avoids cross-session collisions without needing the
  sessionId — fine because each session gets its own `onSessionEvent` via
  `attachSessionEventHandler`).

**Acceptance:** host emits exactly one `tool_result` event per observable
tool at end; no `tool_call` events emitted; orphaned end (no matching start)
emits nothing.

**Verification:** `pnpm typecheck`, `pnpm test -- tests/host/display-forwarding.test.ts`.

### Task 3 — Tests: `formatToolCompletedLine` table

Edit `tests/host/tool-summary.test.ts`. Add a new `describe("formatToolCompletedLine")`:

- success → `✓ bash: ls`.
- success ignores `result` content.
- error string (single line) → `✗ bash: ls: command not found: foo`.
- error string (multi-line) → `✗ bash: ls: permission denied` (first line).
- error object with `message` → `✗ bash: ls: command failed` (D1 order).
- error object nested `error.message` → correct.
- error object with `stderr` → correct.
- error with empty/ple-has-content → `✗ bash: ls` (no extractable line).
- `summary === undefined` → `null` (orphaned end / suppressed-start end).
- truncation boundary: line of exactly 100 → verbatim; 101 → slice 99 + `…`.

**Acceptance:** table covers the cases above; one assertion per case; names the case.

**Verification:** `pnpm test -- tests/host/tool-summary.test.ts`.

### Task 4 — Tests: update `display-forwarding.test.ts`

Edit `tests/host/display-forwarding.test.ts`.

- "forwards assistant text, compact tool summaries, and success/error
  indicators…" → rename/rewrite to "emits a single combined line at end". After
  `message_end` + start + end:
  - `onDisplay` called **2 times** (text + one `tool_result`), not 3.
  - nth(1) = text (unchanged).
  - nth(2) = `{ role, kind: "tool_result", text: "✓ bash: ls" }`.
- error flow tests (the two `forwards tool_error...`) → assert a **single**
  `tool_result` event with the combined text:
  - string error → `✗ bash: ls: permission denied` (note summary `bash: ls`
    prepended).
  - object error → `✗ bash: ls: command not found`.
- **Test-design requirement (review nit 2) — error fixtures must now emit the
  matching start.** The two error-flow tests (`call-err`, `call-err-obj`)
  currently emit ONLY `tool_execution_end` with no prior
  `tool_execution_start`. Under the new buffering, a start-less end is an
  **orphaned-end** case (summary undefined → `null` → no emit) and would
  silently break these tests' assertions. Therefore, in each error-flow
  test, **prepend the matching `tool_execution_start`** (`bash`, args `ls`,
  same `toolCallId`) BEFORE the `tool_execution_end`, so the buffer holds the
  summary `bash: ls` to combine. The start-event fixture's `onDisplay` count
  expectation is unchanged (start emits nothing).
- **The existing start-less fixtures become a NEW orphaned-end test**, NOT a
  folded-in modification of the error-flow tests (see the explicit orphaned
  bullet below). Do not leave start-less error-flow tests behind — that
  duplicates the orphaned case and hides a fixture error as a "pass".
- ADD "buffers start and emits nothing until end":
  - emit start (`bash`, `ls`) only → `expect(onDisplay).not.toHaveBeenCalled()`.
- machine-tool suppression tests (`handoff`, `end`) → unchanged (no buffer,
  no emit). They already assert `onDisplay` not called.
- ADD "orphaned end (no matching start) emits nothing":
  - emit only `tool_execution_end` for an observable tool with no prior
    start → `onDisplay` not called (summary undefined → null). This is the
    NEW test that absorbs the start-less fixture shape formerly used by
    `call-err` / `call-err-obj` (see the test-design bullet above).

**Acceptance:** the host flow test asserts the two-call (text + combined)
count and the combined text; orphaned/buffer cases pass.

**Verification:** `pnpm test -- tests/host/display-forwarding.test.ts`.

### Task 5 — Full gate + manual visual check

- Run the repo's standard gates:
  - `pnpm typecheck`
  - `pnpm build`
  - `pnpm test` (incl. `tests/grep-guard.test.ts` — must stay green; no new
    pi imports, none in core)
  - `pnpm lint` (`biome check .`)
  - `pnpm format:check`
- Module-size check: `src/host/tool-summary.ts` and
  `src/host/session-event-handler.ts` stay under the ~400 LOC ceiling; if
  they approach it, split by (Task 1) keeping the new helper minimal and
  (Task 2) keeping the buffer logic inline-topic + 4 lines.
- **Manual / visual check:** run `/conduct` against a small task in scratch
  that performs a few `bash`/`read`/`edit` calls (and at least one failing
  `bash`). Confirm each observable tool now renders as a single
  `conduct.role.tool` block (dim role label + `> ✓ <summary>` /
  `> ✗ <summary>: <error>`), with no separate bare-`✓`/`✗` block. Confirm
  the global status-line spinner still shows "running" during in-flight
  tools. Record the manual check result in the plan summary block below.
- **Optional evidence archive (review nit 3):** if convenient, capture a
  transcript or screenshot of the TUI showing two observable tools — one
  success (`✓ <summary>`) and one error (`✗ <summary>: <error>`) — and link it
  from this Task 5 block, or attach the file alongside
  `docs/tool-display-combine-status/`. This is optional evidence, not a gate.
- **Tick checkboxes in the same commit (review nit 4):** AGENTS.md is explicit
  — tick `[x]` every box in the plan-status block below whose
  acceptance/verification step was actually performed, in the same change that
  implements it. Do not tick a box for work not done, and do not leave a
  completed step unticked.

### Plan-status block (tick as applied)

```text
[x] Task 1 — formatter helper + MAX_TOOL_LINE_DISPLAY_LENGTH
[x] Task 2 — per-session buffer + combined end emission
[x] Task 3 — formatToolCompletedLine test table
[x] Task 4 — display-forwarding.test.ts rewrite
[x] Task 5 — full gates + manual visual check
```

## Open concerns (for the user / reviewer to confirm)

1. **In-flight feedback vs. single-line goal** (top concern). The plan
   defaults to **suppressing the start emission** (true single line per
   tool, relying on the global status-line spinner for in-flight
   feedback). The user's in-flight answer selected showing a `… <summary>`
   start line, but pi `CustomMessage`s are append-only — that yields two
   persisted lines per tool call, contradicting the primary "one line,
   that's it" goal. If the user instead wants in-flight per-tool
   disclosure, switch the implementation to Option C (Task 2 emits a
   `tool_call` event `… ${summary}` at start AND the combined
   `tool_result` at end); document explicitly that this is two lines per
   tool. **No middle ground exists without an SDK edit/replace primitive
   the SDK does not provide.** Needs user confirmation before/during
   review.
2. **Truncation length 100** was picked as a terminal-row budget; if the
   user's terminal is narrow, 100 may still wrap. Configurable width is
   out of scope for Phase 1 (no width plumbing into the formatter).
3. **Separator for errors** is `": "`. An em-dash alternative was offered
   and rejected by the user's format choice; flagged here for visibility.

## Follow-ups (deferred, not Phase 1)

Items deferred from Phase 1. These are scope decisions, not gaps — each is
recorded here so whoever picks up Phase 2 can assess them at a glance.

1. **Orphaned-start flush** (reviewer-flagged): emit a buffered summary
   without a marker when a session ends without a matching
   `tool_execution_end` (abort path), so partial info isn't silently lost.
   Phase 1 drops orphans silently by design (limitation documented, not a
   silent gap). The reviewer noted this explicitly as a follow-up.
2. **`formatToolResultSummary` cleanup** (reviewer-flagged): the function
   at `src/host/tool-summary.ts:265` is dead in production (the handler now
   uses `formatToolCompletedLine`). Retained as a fallback and for existing
   unit tests. Phase 2 should evaluate whether to remove or deprecate it.
3. **Per-terminal-width truncation:** feed the renderer / formatter terminal
   width for a wrapping-safe cut. Deferred — needs width plumbing.
4. **Unknown-tool observability:** today fully suppressed. If the user wants
   unfamiliar tools to show, extend `BUILTIN_TOOLS`. Not in scope.

## Verification block (repo gates)

```bash
pnpm typecheck   # strict + noUncheckedIndexedAccess
pnpm build       # emit dist/ with .d.ts
pnpm test        # incl. grep-guard (no pi imports in core)
pnpm lint        # biome check .
pnpm format:check
# manual:
/conduct <small task that runs bash/read/edit + one failing bash>
```

## Summary-of-changes (mirror of summary, ticked at review)

- One combined `conduct.role.tool` block per observable tool at end.
- Host buffers the start summary by `toolCallId`; emits no `tool_call`.
- `formatToolCompletedLine` + `MAX_TOOL_LINE_DISPLAY_LENGTH=100`.
- Renderer + sink + core + seam unchanged.

---

## Archive footer

- **Plan:** `docs/tool-display-combine-status/phase-1-combine-tool-line.md`
- **Run ID:** tool-display-combine-status-phase-1
- **Ship date:** 2026-06-24
- **Reviewer verdict (plan-reviewer-b, visit 1):** `status: approve` — all
  three visits (plan-reviewer-a → plan-reviewer-b → implementer → reviewer)
  completed cleanly. The plan-reviewer-a nits were folded into PLAN-REVISED.
- **Reviewer verdict (reviewer, visit 1):** `status: approve` — Phase 1
  implementation accepted. Two follow-up items flagged (see Follow-ups
  section).
- **As-shipped behavior summary:** Collapses the prior two-block-per-tool-call
  TUI output (separate invocation block + bare `✓`/`✗` block) into a **single
  `conduct.role.tool` block** emitted once at `tool_execution_end`, carrying
  `✓ <summary>` (success) or `✗ <summary>: <error>` (error). The host buffers
  the invocation summary from `tool_execution_start` keyed by `toolCallId` and
  no longer emits `tool_call` DisplayEvents. A pure formatter
  `formatToolCompletedLine` with `MAX_TOOL_LINE_DISPLAY_LENGTH=100` builds the
  combined line. Four `[x]` tasks + one `[x]` manual visual check, all green.
  Two source files + two test files changed. Core/seam/cost/persistence/
  manifest untouched.
- **Archived by:** implementer role, post-review archive dispatch.
  `docs/tool-display-combine-status/` moved to `docs/archive/tool-display-combine-status/`.