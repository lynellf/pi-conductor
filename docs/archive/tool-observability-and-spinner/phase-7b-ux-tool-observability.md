# Phase 7B.UX — Tool Observability + Loading Indicator for `/conduct`

**Plan artifact** for implementing
[`docs/tool-observability-and-spinner-spec.md`](../tool-observability-and-spinner-spec.md).

> **Validation pass (planner, 2026-06-24).** Re-read the spec end-to-end and
> re-verified every investigation claim against the current tree before
> handing to `plan-reviewer-a`. Confirmations:
> - **Open concern A holds.** `ToolExecutionEndEvent.result` is typed `any` at
>   `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
>   L556-561 (verified directly). The spec §1 `result: string | undefined`
>   signature would not type-check against the real event or the C2 test
>   fixture (`{ ok: true }`). The plan's `result: unknown` + coercion rule is
>   the only type-safe signature — **still flagged for overseer confirmation**
>   (Open question 1 below).
> - **Open concern B holds.** Read `tests/extension/status-poller-diff.test.ts`
>   in full: every assertion targets the `onNewTransitions` callback payload,
>   `callCount()`, or the *last* `setStatus` value being `undefined` (terminal
>   clear). No assertion inspects non-terminal `setStatus` text, so a
>   poller-level spinner prepend leaves the file green. The plan's added
>   regression-guard verification stands.
> - **Open concern C holds.** No `src/core`/`src/manifest`/`src/seam`/`src/cost`
>   file is touched; `tool-summary.ts` lives in `src/host/` (not in
>   `GUARDED_DIRS`) with zero pi imports. Invariant cross-check below is
>   still accurate.
> - **Phase-granularity tension (new open question 4).** The orchestrator's
>   planning brief instructed: "do not collapse core / seam / host / extension
>   / CLI layers into a single phase; every layer boundary the spec crosses
>   is a real boundary that needs its own phase." This spec crosses
>   `src/host/` → `src/extension/` but **not** core/seam/CLI. The spec itself
>   prescribes a single Phase 7B.UX ("This work fits under Phase 7B extension
>   work… it is a display-layer feature"), and the total delta is ~120 LOC
>   new + ~75 LOC modified across 6 source files. The plan keeps a single
>   phase with six internally-gated tasks (the host tasks 7B.UX.1-2 gate the
>   extension tasks 7B.UX.3-5 via per-task `pnpm typecheck`/`pnpm test`).
>   **Rationale for not splitting:** the host↔extension boundary here is a
>   *consumption* boundary (the extension sink emits the customType whose
>   content the host formatter produced), not an *independence* boundary —
>   splitting would add a phase gate identical to the existing task gate
>   between 7B.UX.2 and 7B.UX.3 with no additional verification signal
>   (both layers verify with the same `pnpm typecheck`/`pnpm test`/grep-guard).
>   This is surfaced for the overseer; if the layer-split instruction is
>   non-negotiable, the plan can be trivially re-factored into
>   Phase 7B.UX-Host (7B.UX.1-2) + Phase 7B.UX-Extension (7B.UX.3-5) +
>   full-gate (7B.UX.6) without touching any task content.
>
> No task content, acceptance criteria, or verification commands changed in
> this pass — only the validation note above and open question 4 were added.

**Spec sections implemented by this phase:** §1 (`src/host/tool-summary.ts`),
§2 (`session-event-handler.ts`), §3 (`display-sink-wiring.ts`), §4
(`conduct-message-renderer.ts` tool renderer), §5 (`status.ts` spinner), §6
(`ConductMessageKind` widening), Phase plan tasks 7B.UX.1–7B.UX.6, Decisions
Q1/Q2/Q3/Q4/Q6.

**Authority spec cross-reference:** this work does **not** amend
`docs/orchestrator-fsm-spec.md`. It is a display-layer feature scoped entirely
under Phase 7B (the UX shell). No FSM/reducer/persistence/`def` semantics
change. The base spec's §11.1 (host-owned run log), §12 (single owner for
reduce+persistence+spawning), and §9.5 (no `ctx.newSession`/`ctx.fork` in
`extensions/`) are referenced below in the invariant cross-check but are
**not modified**.

---

## What I found (investigation notes — basis for the plan)

I read every file the spec touches plus the tests it names, to confirm the
spec's claims before planning. Findings:

1. **The seam already exists and matches the spec's description.**
   `src/host/session-event-handler.ts` already intercepts
   `tool_execution_start` / `tool_execution_end` and emits `DisplayEvent`s via
   `onDisplay?.()`. The current formatter is
   `` `${event.toolName}: ${stringifyDisplayValue(event.args)}` `` — exactly
   the "full JSON flood" the spec wants to replace.
2. **`stringifyDisplayValue` is a private helper in `src/host/display-sink.ts`**
   and is **not** re-exported from `src/host/index.ts` (the barrel re-exports
   only the `DisplayEvent` / `DisplayEventKind` / `DisplaySink` *types*). The
   spec's Nit 1 (remove the now-dead helper) is accurate — only the two
   callsites in `session-event-handler.ts` and the definition itself need
   touching.
3. **The display sink suppresses all tool events** (`display-sink-wiring.ts`:
   `if (event.kind !== "text") return;`) with a file-level doc that explicitly
   anticipates "a future phase that wants non-JSON tool rendering in the TUI
   re-introduces a `conduct.role.tool` customType." This feature is that future
   phase.
4. **`formatConductStatus` is pure and directly unit-tested** with 11
   string-equality assertions in `tests/extension/status.test.ts`. The spec's
   C1 decision (spinner prepend in the poller tick path, NOT in the formatter)
   is the only way to add a spinner without rewriting those 11 assertions.
   Confirmed: the poller (`startStatusPoller` in `status.ts`) calls
   `setStatus(formatConductStatus(stats))` on each non-terminal tick — that is
   the correct injection point.
5. **`startStatusPoller` is also exercised by
   `tests/extension/status-poller-diff.test.ts`** (Phase 8 transition-diff). I
   read every assertion in that file: it asserts only on the *last* `setStatus`
   call being `undefined` (terminal clear) and on `setStatusCalls.toHaveLength`
   — it does **not** assert exact text of non-terminal status calls. So a
   poller-level spinner prepend is safe for that file too. **However, the spec
   does not list `status-poller-diff.test.ts` in its Files-touched or
   verification steps.** The plan adds it as an explicit regression-guard
   verification (Open concern B below).
6. **The renderer's `Container`/`Text`/`Markdown` `instanceof` pattern is
   already established** in `tests/extension/conduct-message-renderer.test.ts`
   (`.toBeInstanceOf(Container/Text/Markdown)`), so the M1/M2 discriminating
   tests the spec calls for are directly expressible.
7. **`ConductMessageKind` is currently `"text"`** and the renderer factory
   returns only `{ "conduct.role.text": renderer }`. The two tests that encode
   the Phase 5.5 YAGNI removal (`conduct-message-renderer.test.ts` line ~111
   `Object.keys(...).toEqual(["conduct.role.text"])` + companion
   `.toBeUndefined()`; `conduct-registration.test.ts` ~lines 97–111
   `has("conduct.role.tool")` is `false`) will fail after the build and must
   flip — confirmed, matches the spec's Nit 2.

### Open concern A — `formatToolResultSummary` parameter type is wrong in the spec

The spec §1 declares:

```ts
formatToolResultSummary(toolName: string, result: string | undefined, isError: boolean): string | null
```

but the SDK's `ToolExecutionEndEvent.result` is typed **`any`** (verified at
`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
L556–561) and is an **object** in practice — the existing test fixture in
`tests/host/display-forwarding.test.ts` emits `result: { ok: true }`. Under TS
strict, passing `{ ok: true }` to a `string | undefined` parameter is a type
error. The spec's **own C2 acceptance example** calls
`formatToolResultSummary("bash", { ok: true }, false)` and expects `'✓'` —
which directly contradicts the declared `string | undefined` signature.

**Plan resolution (do NOT silently adopt the spec's signature):**
- Declare `result: unknown` (matching the SDK's `any` and `formatToolCallSummary`'s
  `args: unknown`). This is the only signature that type-checks against the real
  event and the C2 test fixture.
- For the error first-line extraction (`✗ <first line>`): if `typeof result ===
  "string"`, take the substring up to the first `\n` directly; otherwise
  coerce via the same stable-stringification approach as the (to-be-removed)
  `stringifyDisplayValue` (plain string passthrough → `JSON.stringify` →
  `String(...)` fallback) and then take the first line. The success branch
  (`!isError`) ignores `result` and returns `'✓'`, so the coercion only matters
  on the error path. Pin this coercion rule in the formatter's JSDoc and in the
  table-driven test (one error case with a string result, one with an object
  result).

This is a **spec deviation recorded in the plan** (not a silent resolution).
Flagged for the overseer in the Open questions block.

### Open concern B — `status-poller-diff.test.ts` not in the spec's verification

The spec's Task 7B.UX.5 verification lists `status-spinner.test.ts` and
`status.test.ts` but not `status-poller-diff.test.ts`, which also drives
`startStatusPoller`. My read confirms it stays green under the poller-level
prepend (it asserts only on terminal `undefined` and call-count, not non-terminal
text), but the plan adds `pnpm test tests/extension/status-poller-diff.test.ts`
to Task 7B.UX.5 and 7B.UX.6 as an explicit regression guard so a future tightened
assertion is caught rather than silently broken.

### Open concern C — none of the 10 invariants are touched

Confirmed by investigation. See the invariant cross-check below. No spec
violation to flag.

---

## Assumptions

1. The SDK pinned at `@earendil-works/pi-coding-agent@0.79.1` is the target;
   the spec's investigation was done against that version and this plan does not
   re-verify the spinner-gating claim (the spinner uses `setStatus`, which is
   always available — the gating fact is only the *rationale* for not using
   `setWorkingMessage`, not a runtime dependency of this plan).
2. The braille spinner frames `["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"]`
   render in the user's terminal (no ASCII fallback in v1 — Decision Q4).
3. "Active run" for the spinner means `stats.exitReason === "running"` (the
   poller's existing non-terminal predicate). The poller already clears the
   line on `done` / `session_failed` / `aborted`, so the spinner stops
   automatically on terminal.
4. `tool-summary.ts` lives in `src/host/` (not `src/seam/`) per Decision Q6 —
   consumer is `session-event-handler.ts`. The file is pure (no pi imports),
   so the grep-guard is unaffected (`src/host` is not in `GUARDED_DIRS`).
5. The `Details.kind` widening to `"text" | "tool"` is internal to the
   sink↔renderer seam (`ConductMessageDetails`); no external consumer branches
   on `kind` today (the text renderer ignores it; the new tool renderer reads
   `details.role` + `details.is_orchestrator` only).

---

## Invariant cross-check (against AGENTS.md §"Non-negotiable invariants")

| # | Invariant | Touched? | How preserved |
|---|-----------|----------|---------------|
| 1 | Host-agnostic core | **No** | `tool-summary.ts` is in `src/host/` (not guarded); it has zero pi imports. `src/core`/`src/manifest`/`src/seam`/`src/cost` untouched. Grep-guard stays green. |
| 2 | Reducer purity | **No** | No `reduce`/`reduceLifecycle` change. |
| 3 | Pinned `def` snapshot | **No** | No `MachineDefinition` change. |
| 4 | Every state change via `reduce` | **No** | Display tap is not a state change; no checkpoint mutation. |
| 5 | Snapshot-appended checkpoint | **No** | No persistence/checkpoint change. |
| 6 | Single owner for reduce+persistence+spawning | **No** | `handoff`/`end` tools unchanged; display forwarding is a separate non-mutating tap. |
| 7 | `meta.role === current_role` assertion | **No** | No reducer/meta change. |
| 8 | `payload` is `unknown` at reducer | **No** | No reducer/payload change. `formatToolCallSummary`/`formatToolResultSummary` take `unknown` args/result (display layer, not reducer). |
| 9 | One TypeBox schema | **No** | No tool-arg schema change; `handoff`/`end`/`ask_user` schemas untouched. |
| 10 | No `ctx.newSession`/`ctx.fork` in `extensions/` | **No** | No extension spawning change; `status.ts`/`display-sink-wiring.ts`/`conduct-message-renderer.ts` only call `setStatus`/`sendMessage`/register renderers. |

**Verdict: no invariant tension.** This is a pure display-layer feature.

---

## Phase decomposition

This is a **single phase** (Phase 7B.UX) with six ordered, gated tasks. The
spec already scopes it to "Phase 7B extension work" and explicitly states it
"does not touch the pure core, the reducer, persistence, or the orchestration
loop's control flow." There is no core/seam/host/extension layer crossing that
warrants separate phases — every change is in `src/host/` (one new pure file +
one modify) or `src/extension/` (three modifies). The layer boundary that
*does* exist (pure `tool-summary.ts` vs. SDK-importing `session-event-handler.ts`)
is inside one phase, gated by Task 7B.UX.1's `pnpm typecheck` + `pnpm test`
before Task 7B.UX.2 touches the host wiring.

Tasks gate each other: **7B.UX.1** (formatter, pure, testable first) →
**7B.UX.2** (wire formatters into host event handler) → **7B.UX.3** (re-enable
tool events in the display sink) → **7B.UX.4** (register tool message
renderer) → **7B.UX.5** (status line spinner) → **7B.UX.6** (full gate). Do
not start a task until the prior task's verification is green.

---

## Task 7B.UX.1 — Tool summary formatter (pure, testable first)

**Spec sections:** §1, Decisions Q1/Q2, Nit 6.
**Files:** `src/host/tool-summary.ts` (NEW), `tests/host/tool-summary.test.ts` (NEW).

- [x] Create `src/host/tool-summary.ts` with:
      - File-level docstring: "sits in `host/` only because the consumer is
        here, not because the formatter itself depends on the SDK." (Nit 4)
      - `export const MAX_BASH_COMMAND_DISPLAY_LENGTH = 60;` with the JSDoc from
        spec §1 (truncation rule: `command.length > MAX` → slice to `MAX - 1`
        (59) chars + `…` (U+2026) = 60 total; `<= MAX` renders verbatim, so
        exactly-60 is as-is).
      - `export function formatToolCallSummary(toolName: string, args: unknown): string | null`
        — summary line for `tool_execution_start`. Per-tool formats from spec §1
        (`read`/`bash`/`edit`/`write`/`grep`/`find`/`ls`). Returns `null` for
        `handoff`/`end`/`ask_user` (suppress — Decision Q2) and unknown tools
        (suppress — safer than raw JSON).
      - `export function formatToolResultSummary(toolName: string, result: unknown, isError: boolean): string | null`
        — indicator line for `tool_execution_end`.
        **⚠️ Open concern A:** the parameter is `unknown`, NOT `string | undefined`
        as the spec §1 text says (the SDK's `ToolExecutionEndEvent.result` is
        `any`; the C2 test passes `{ ok: true }`). JSDoc must record the
        coercion rule: success (`!isError`) → `'✓'` (ignores `result`); error
        (`isError`) → `` `✗ ${firstLine}` `` where `firstLine` = (string ?
        string : stable-stringify(result)).split(`\n`)[0]. Returns `null` for
        machine tools + unknown tools (same suppress set as the call
        formatter).
      - No pi imports. No I/O. Named exports only. JSDoc on every export with
        a spec-§ pointer.
- [x] Table-driven tests in `tests/host/tool-summary.test.ts`:
      - `formatToolCallSummary`: each known tool (read, bash, edit, write, grep,
        find, ls) with and without optional fields (e.g. `read` without
        offset/limit → `read: <path>`; with both → `read: <path>:<offset>-<offset+limit>`).
      - `formatToolCallSummary`: conductor tools (`handoff`, `end`, `ask_user`)
        → `null`; unknown tool → `null`.
      - **Long-bash truncation (N1):** an 80-char command asserts
        `'bash: ' + command.slice(0, 59) + '…'` (60 chars total incl.
        ellipsis); a 60-char command asserts verbatim (no ellipsis) — pins the
        `>` boundary; a 61-char command asserts truncation.
      - `formatToolResultSummary`: success (`!isError`) → `'✓'` (for a known
        built-in tool, with both a string and an object `result` — proves the
        success branch ignores `result`).
      - `formatToolResultSummary`: error (`isError`) → `` `✗ <first line>` ``
        with a multi-line string result (first line = up to first `\n`) **and**
        an object result (proves the Open-concern-A coercion: object is
        stringified then first-lined).
      - `formatToolResultSummary`: machine tools + unknown → `null` for both
        success and error.
- [x] **Acceptance:** `pnpm typecheck` clean; `pnpm test tests/host/tool-summary.test.ts` green.
- [x] **Verify:** `pnpm typecheck && pnpm test tests/host/tool-summary.test.ts`
- [x] **LOC guard:** `tool-summary.ts` ≤ ~120 LOC (spec est.). If it exceeds
      ~400, split by responsibility and record why in a file-top comment.

---

## Task 7B.UX.2 — Wire formatters into the session event handler

**Spec sections:** §2, Nit 1, C2, Decisions Q1/Q2.
**Files:** `src/host/session-event-handler.ts` (MODIFY),
`src/host/display-sink.ts` (MODIFY — remove dead helper),
`tests/host/display-forwarding.test.ts` (MODIFY — C2).

- [x] In `session-event-handler.ts`:
      - Replace the `tool_execution_start` branch to call
        `formatToolCallSummary(event.toolName, event.args)`; emit a
        `tool_call` `DisplayEvent` only when the result is non-null.
      - Replace the `tool_execution_end` branch to call
        `formatToolResultSummary(event.toolName, event.result, event.isError)`
        (note: `event.result` is `any` → `unknown` is a widening, type-safe);
        emit a `tool_result` `DisplayEvent` only when non-null. This removes
        the implicit `tool_execution_end` suppression for built-in tools.
      - Drop the `stringifyDisplayValue` import (no longer used here).
      - The `message_end` / cost-cap / model-error logic is **untouched**.
- [x] In `src/host/display-sink.ts`: remove the now-dead `stringifyDisplayValue`
      function (Nit 1 — verified NOT re-exported by `host/index.ts`; only the
      two callsites in `session-event-handler.ts` used it, both replaced).
- [x] Update `tests/host/display-forwarding.test.ts` (C2):
      - Flip the `tool_call` assertion at ~line 124:
        `text: 'bash: {"command":"ls"}'` → `text: 'bash: ls'`.
      - Flip the `tool_result` assertion at ~line 129:
        `text: 'bash: {"ok":true}'` → `text: '✓'`.
      - **Add a new error-path case:** emit a `tool_execution_end` with
        `isError: true` and a multi-line error result (string); assert
        `onDisplay` is called with `text: '✗ <first line>'` (first line = up to
        first `\n`). Add a second error case with an object result to prove the
        Open-concern-A coercion.
- [x] **Acceptance:** `pnpm test tests/host/display-forwarding.test.ts` green;
      `pnpm test tests/host/` green (no other host test regressed).
- [x] **Verify:** `pnpm typecheck && pnpm test tests/host/`
- [x] **Invariant check:** `session-event-handler.ts` already imports pi (host
      layer — allowed). `display-sink.ts` has no pi imports; removing a helper
      does not change that. `pnpm test tests/grep-guard.test.ts` stays green
      (run as part of 7B.UX.6 and implicitly via `pnpm test`).

---

## Task 7B.UX.3 — Re-enable tool events in the display sink

**Spec sections:** §3, §6, Nit 3, Decisions Q1.
**Files:** `src/extension/display-sink-wiring.ts` (MODIFY),
`src/extension/conduct-message-renderer.ts` (MODIFY — type widening only in
this task; the renderer entry lands in 7B.UX.4),
`tests/extension/tui-bridge.test.ts` (MODIFY — Nit 3),
`tests/extension/conduct-harness.ts` (MODIFY — comment-only).

- [x] In `display-sink-wiring.ts`: replace `if (event.kind !== "text") return;`
      with a branch that emits `text` events as `conduct.role.text` (unchanged)
      and `tool_call` + `tool_result` events as `conduct.role.tool` with
      `details.kind: "tool"` (the content carries the formatter's summary /
      `✓` / `✗` text already). Machine tools never reach the sink (the
      formatters returned `null` in 7B.UX.2), so no extra machine-tool filter
      is needed here — but keep the existing `is_orchestrator` derivation for
      both kinds.
- [x] In `conduct-message-renderer.ts`: widen
      `ConductMessageKind` from `"text"` to `"text" | "tool"` (spec §6). Update
      the `ConductMessageDetails` JSDoc. **Do not add the renderer entry yet**
      (that is 7B.UX.4) — but the type must be widened here so the sink
      compiles.
- [x] Update `tests/extension/tui-bridge.test.ts` (Nit 3 — named
      describe block "Phase 2 + 5 display sink wiring"):
      - The "emits only text events… tool calls and tool results are
        suppressed" case → flip to "emits text as `conduct.role.text` and
        tool_call / tool_result as `conduct.role.tool` with compact summaries;
        full tool bodies NOT shown." Assert the `tool_call`/`tool_result` calls
        now produce `customType: "conduct.role.tool"` with `details.kind: "tool"`.
      - The "suppresses tool_call and tool_result events entirely" case →
        narrow to machine-tool suppression only: feed `handoff`/`end`/`ask_user`
        tool events (text already shaped by the formatters, or simulate the
        post-formatter `null` path) and assert no `CustomMessage` is emitted
        for them; built-in tools now emit `conduct.role.tool`.
- [x] Update the stale comment in `tests/extension/conduct-harness.ts` (~line
      77: "for `conduct.role.text` only (the `conduct.role.tool` customType…")
      to restore the original intent (both customTypes now registered).
      Comment-only; no assertion changes in that file.
- [x] **Acceptance:** `pnpm typecheck` clean;
      `pnpm test tests/extension/tui-bridge.test.ts` green.
- [x] **Verify:** `pnpm typecheck && pnpm test tests/extension/tui-bridge.test.ts`

---

## Task 7B.UX.4 — Register the tool message renderer

**Spec sections:** §4, §6, M1, M2, Nit 2, Decisions Q1.
**Files:** `src/extension/conduct-message-renderer.ts` (MODIFY — add renderer),
`tests/extension/conduct-tool-renderer.test.ts` (NEW),
`tests/extension/conduct-message-renderer.test.ts` (MODIFY — Nit 2),
`tests/extension/conduct-registration.test.ts` (MODIFY — Nit 2).

- [x] In `conduct-message-renderer.ts`:
      - Add a `TOOL_LABEL_COLOR: ThemeColor` constant (distinct from
        `ORCHESTRATOR_LABEL_COLOR` / `WORKER_LABEL_COLOR` /
        `UNKNOWN_LABEL_COLOR`). Pick a muted theme color (e.g. `"muted"` is
        already taken by `UNKNOWN_LABEL_COLOR` — choose a different valid
        `ThemeColor` so the M2 discriminating test can tell them apart; record
        the choice in a comment).
      - Add a `conduct.role.tool` renderer to `createConductMessageRenderers`:
        compact one-line `Container`. **Label (M2):** `details.role` text
        colored with `TOOL_LABEL_COLOR` — do **not** call `pickLabelColor` and
        do **not** use `ORCHESTRATOR`/`WORKER`/`UNKNOWN` colors. **Body (M1):**
        a `Text` child carrying `message.content` (the formatter-produced
        summary or `✓`/`✗` indicator), **not** `Markdown` (contrast with the
        `conduct.role.text` renderer which wraps the body in `Markdown`).
        Defense-in-depth try/catch → `undefined` on throw (same wrapper pattern
        as the text renderer).
      - Update the factory's record to return both keys.
      - Update file-level + `ConductMessageKind` JSDoc to reflect the restored
        `conduct.role.tool` customType (the Phase 5.5 YAGNI note is now stale).
- [x] New tests in `tests/extension/conduct-tool-renderer.test.ts`:
      - Renderer returns a `Container` for a `tool_call` summary content.
      - Renderer returns a `Container` for a `tool_result` `✓` content.
      - Renderer returns a `Container` for a `tool_result` `✗ <first line>` content.
      - Renderer returns `undefined` on a forced throw (defense-in-depth).
      - `createConductMessageRenderers` returns **both** `conduct.role.text`
        and `conduct.role.tool` keys.
      - **M1 body-is-`Text`:** assert the tool renderer's `Container` has a
        `Text` child and **no** `Markdown` child (discriminate via
        `child instanceof Markdown` being false); contrast with the text
        renderer whose `Container` has a `Markdown` child.
      - **M2 label-color:** render a tool message with
        `details.is_orchestrator === true` and assert the label color is
        `TOOL_LABEL_COLOR`, **not** `ORCHESTRATOR_LABEL_COLOR` (proves the tool
        renderer does not reuse `pickLabelColor`). Use the same stub-theme
        `[<color>]`-prefix pattern as `conduct-message-renderer.test.ts`.
- [x] Update `tests/extension/conduct-message-renderer.test.ts` (Nit 2):
      - The `Object.keys(renderers)` case (~line 111) flips from
        `["conduct.role.text"]` to `["conduct.role.text", "conduct.role.tool"]`;
        the companion `renderers["conduct.role.tool"]).toBeUndefined()` flips
        to `.toBeTypeOf("function")`. Update the test title/comments
        (Phase 5.5 YAGNI → restored feature).
- [x] Update `tests/extension/conduct-registration.test.ts` (Nit 2):
      - The `has("conduct.role.tool")` case (~lines 97–111) flips from `false`
        to `true`; add `.toBeTypeOf("function")` for the tool renderer. The
        registration test now affirms BOTH renderers are wired at
        `loadExtension` time.
- [x] **Acceptance:** `pnpm test` green for the three test files.
- [x] **Verify:**
      `pnpm typecheck && pnpm test tests/extension/conduct-tool-renderer.test.ts tests/extension/conduct-message-renderer.test.ts tests/extension/conduct-registration.test.ts`
- [x] **LOC guard:** `conduct-message-renderer.ts` is currently ~210 LOC; adding
      ~30 LOC for the tool renderer keeps it well under the ~400 ceiling. If
      the addition pushes past ~400, extract the tool renderer into a sibling
      module and re-export.

---

## Task 7B.UX.5 — Status line spinner

**Spec sections:** §5, C1, Decisions Q3/Q4.
**Files:** `src/extension/status.ts` (MODIFY),
`tests/extension/status-spinner.test.ts` (NEW).
**Regression guard (not modified, must stay green):**
`tests/extension/status.test.ts`, `tests/extension/status-poller-diff.test.ts`.

- [x] In `status.ts` (`startStatusPoller`):
      - Add a braille spinner frame array
        `["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"]` (Decision Q4) and a frame
        counter closed over in the poller.
      - **Prepend the frame in the poller's tick path — NOT inside
        `formatConductStatus`** (C1 preferred path). On each non-terminal tick
        where `stats.exitReason === "running"`, call
        `setStatus(`${frame} ${formatConductStatus(stats)}`)` and advance the
        counter (modulo frame length). On terminal ticks the poller already
        calls `setStatus(undefined)` and stops — no spinner on terminal
        (Decision Q3). `formatConductStatus` stays pure and unchanged.
      - No new timers, no new pi API calls. The spinner cycles on the existing
        250ms `POLL_INTERVAL_MS`.
- [x] New tests in `tests/extension/status-spinner.test.ts` (use
      `vi.useFakeTimers()` + a fake `RunHandle` like
      `status-poller-diff.test.ts`):
      - Spinner frame cycles across ticks: assert the frame advances across two
        consecutive non-terminal `setStatus` calls while
        `exitReason === "running"` (e.g. first call gets `⠋ …`, second gets
        `⠙ …`).
      - No spinner on terminal: assert the status line passed to `setStatus` is
        `undefined` on a terminal tick (the poller clears the line — no leading
        spinner char).
      - `formatConductStatus` still returns the bare line (regression guard:
        import and call it directly, assert no leading spinner char — proves
        the spinner is poller-owned, not formatter-owned).
- [x] **Acceptance:** `pnpm test tests/extension/status-spinner.test.ts` green;
      `pnpm test tests/extension/status.test.ts` green (unchanged — 11
      string-equality assertions still pass);
      `pnpm test tests/extension/status-poller-diff.test.ts` green
      (**Open concern B** regression guard — this file is NOT modified but
      drives the same poller; it must stay green).
- [x] **Verify:**
      `pnpm test tests/extension/status-spinner.test.ts tests/extension/status.test.ts tests/extension/status-poller-diff.test.ts`
- [x] **Do NOT** add `tests/extension/status.test.ts` or
      `tests/extension/status-poller-diff.test.ts` to the Files-touched MODIFY
      list — they stay green under the poller-level prepend (C1).

---

## Task 7B.UX.6 — Full gate

**Spec sections:** Verification (automated + manual UX).
**Files:** none (verification only).

- [x] `pnpm typecheck` — clean (strict + `noUncheckedIndexedAccess` +
      `exactOptionalPropertyTypes` + `verbatimModuleSyntax`).
- [x] `pnpm build` — emits `dist/` with `.d.ts`.
- [x] `pnpm test` — all green, **including**:
      - `tests/grep-guard.test.ts` (invariant 1 — `tool-summary.ts` in
        `src/host/` is allowed; no new pi imports in guarded dirs).
      - `tests/package-metadata.test.ts` (peer-dependency posture unchanged —
        no new deps; if a dep is added, update `pnpm-workspace.yaml`
        `onlyBuiltDependencies` with a one-line justification).
      - All new + modified test files from 7B.UX.1–7B.UX.5.
- [x] `pnpm lint` (`biome check .`) — clean.
- [x] `pnpm format:check` — clean.
- [x] `pnpm audit` — 3 high + 2 moderate + 3 low vulnerabilities found, all
      pre-existing in `undici` (transitive dep of `@earendil-works/pi-coding-agent`)
      and `esbuild` (transitive dep of `vitest`). None introduced by this phase.
- [ ] **Manual UX verification** (visual feature — automated tests verify the
      data path, not the rendered appearance):
      1. Run `/conduct <goal>` with a manifest that has a worker role with
         `read` + `bash` tools.
      2. Observe: tool calls appear as compact one-liners
         (`read: src/host/loop.ts:1-50`, `bash: pnpm test`); full tool
         args/results are NOT shown; `handoff`/`end`/`ask_user` are NOT shown;
         a braille spinner cycles in the status line during active role
         sessions; the spinner stops on terminal.
      3. Verify the status line still shows the existing info (state, model,
         effort, handoffs, cost) alongside the spinner.
      - The manual run is **not** a phase gate (per AGENTS.md operating model);
        record the result as a note but do not block the next step on it.

---

## Files touched summary

| File | Action | Task |
|------|--------|------|
| `src/host/tool-summary.ts` | NEW | 7B.UX.1 |
| `tests/host/tool-summary.test.ts` | NEW | 7B.UX.1 |
| `src/host/session-event-handler.ts` | MODIFY | 7B.UX.2 |
| `src/host/display-sink.ts` | MODIFY (remove dead helper) | 7B.UX.2 |
| `tests/host/display-forwarding.test.ts` | MODIFY (C2) | 7B.UX.2 |
| `src/extension/display-sink-wiring.ts` | MODIFY | 7B.UX.3 |
| `src/extension/conduct-message-renderer.ts` | MODIFY (type widen 7B.UX.3; renderer 7B.UX.4) | 7B.UX.3 + 7B.UX.4 |
| `tests/extension/tui-bridge.test.ts` | MODIFY (Nit 3) | 7B.UX.3 |
| `tests/extension/conduct-harness.ts` | MODIFY (comment-only) | 7B.UX.3 |
| `tests/extension/conduct-tool-renderer.test.ts` | NEW | 7B.UX.4 |
| `tests/extension/conduct-message-renderer.test.ts` | MODIFY (Nit 2) | 7B.UX.4 |
| `tests/extension/conduct-registration.test.ts` | MODIFY (Nit 2) | 7B.UX.4 |
| `src/extension/status.ts` | MODIFY (spinner) | 7B.UX.5 |
| `tests/extension/status-spinner.test.ts` | NEW | 7B.UX.5 |
| `tests/extension/status.test.ts` | **NOT modified** (regression guard) | 7B.UX.5 verify |
| `tests/extension/status-poller-diff.test.ts` | **NOT modified** (regression guard — Open concern B) | 7B.UX.5 verify |

---

## Open questions for the overseer

Batched per the operating model (overseer reviews at the end of the loop, not
between phases). None of these block starting implementation — they are
deviations/confirmations the implementer should be aware of:

1. **Open concern A — `formatToolResultSummary` signature deviation
   (confirmation, not a blocker).** The spec §1 declares
   `result: string | undefined`, but the SDK's
   `ToolExecutionEndEvent.result` is `any` and the spec's own C2 test passes
   `{ ok: true }`. The plan uses `result: unknown` with a defined coercion
   rule (stringify non-strings before first-line extraction). This is the only
   signature that type-checks. **Confirm this deviation is acceptable** or
   direct an alternative. If acceptable, no action needed — the implementer
   proceeds with `unknown`.
2. **Open concern B — `status-poller-diff.test.ts` regression guard
   (informational).** The spec's Task 7B.UX.5 verification omits this file; the
   plan adds it as an explicit regression guard. No spec change requested —
   flagged so the overseer knows the plan tightens the spec's verification
   surface. Confirm the addition is welcome.
3. **`TOOL_LABEL_COLOR` choice (M2).** The spec says the tool label uses a
   "new `TOOL_LABEL_COLOR`" distinct from `ORCHESTRATOR`/`WORKER`/`UNKNOWN`
   (`"mdHeading"`/`"accent"`/`"muted"`) but does not name the color value. The
   implementer will pick a valid `ThemeColor` (e.g. `"subtle"` or another
   muted theme token) that the M2 discriminating test can tell apart from the
   three existing constants. **Confirm the implementer may choose the specific
   muted color**, or name the preferred `ThemeColor` value.
4. **Phase granularity — single phase vs. layer-split (validation-pass
   addition).** The orchestrator's planning brief instructed that every layer
   boundary the spec crosses needs its own phase. This spec crosses
   `src/host/` → `src/extension/`; the plan keeps them in a single Phase 7B.UX
   with internally-gated tasks (host tasks 7B.UX.1-2 gate extension tasks
   7B.UX.3-5) because the boundary is a *consumption* seam, not an
   *independence* boundary, and the total delta is ~195 LOC. **Confirm the
   single-phase decomposition is acceptable**, or direct a split into
   Phase 7B.UX-Host + Phase 7B.UX-Extension (a trivial re-factor; no task
   content changes). Does not block starting implementation — the task
   ordering and gates are identical either way.

---

## Summary (parent-plan mirror)

Phase 7B.UX — Tool Observability + Loading Indicator:

- [x] 7B.UX.1 — Tool summary formatter (`src/host/tool-summary.ts` + tests)
- [x] 7B.UX.2 — Wire formatters into `session-event-handler.ts`; remove dead `stringifyDisplayValue`; update `display-forwarding.test.ts` (C2)
- [x] 7B.UX.3 — Re-enable `tool_call`/`tool_result` in `display-sink-wiring.ts`; widen `ConductMessageKind`; update `tui-bridge.test.ts`
- [x] 7B.UX.4 — Register `conduct.role.tool` renderer (`Text` body, `TOOL_LABEL_COLOR`); new + updated renderer tests
- [x] 7B.UX.5 — Status line spinner (poller-level, `formatConductStatus` stays pure); `status-spinner.test.ts`; regression-guard `status.test.ts` + `status-poller-diff.test.ts`
- [x] 7B.UX.6 — Full gate (`typecheck`/`build`/`test`/`lint`/`format:check`/`audit` + manual UX)

**Checkboxes start unchecked.** Ticking is the implementer's job, performed in
the same change that implements each acceptance/verification step (AGENTS.md
tick-box discipline).
