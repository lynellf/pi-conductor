# Implementation plan: Handoff cards in the TUI stream (Phase 9)

> Companion to `docs/handoff-cards-spec.md`. Read the spec first — it
> defines the data inventory, requirements R1–R5, open questions Q1–Q5,
> and the Overseer decisions. This plan is the ordered task breakdown.
> **Do not start implementation until the spec is acknowledged by the
> overseer** (per AGENTS.md operating model: a new spec must be
> acknowledged before implementation against it starts).

## Overview

A rendering-only change to the pi-conductor extension. Two
complementary levers:

- **Lever A (renderer-side, authoritative):** widen `DisplayEvent` to
  carry structured tool args; the display sink intercepts
  `tool_execution_start` for `handoff`/`end`, validates the args
  against the existing TypeBox schemas, and emits a `conduct.handoff`
  `CustomMessage` with the parsed fields. A new conductor-owned
  `MessageRenderer` renders a compact card (role label + arrow +
  target + reason + suggests_next + payload).
- **Lever B (prompt-side, best-effort):** update `.pi/roles/*.md` and
  the handoff/end tool descriptions to instruct the LLM not to narrate
  tool calls in text.

No FSM, reducer, host-loop, or persistence changes. The only `src/host/`
touches are: `display-sink.ts` (type widening), `session-event-handler.ts`
(populating new fields), `tools.ts` (description text only).

## Architecture decisions

- **`DisplayEvent` widening is backward-compatible.** The two new
  fields (`toolName?: string`, `args?: unknown`) are optional. Existing
  consumers that only read `role` / `kind` / `text` are unaffected.
  `exactOptionalPropertyTypes` requires omitting the keys (not setting
  `undefined`) on events that don't carry them — text and `tool_result`
  events omit both fields.
- **Validation at the sink, not in the formatter.** The sink calls
  `Value.Check(handoffArgsSchema, args)` / `Value.Check(endArgsSchema,
  args)` (from `typebox/value`, same import as
  `src/seam/validate-emission.ts`). The schemas are imported from
  `src/seam/schema.ts` (single source of truth, invariant #9). If the
  check fails, the card is NOT emitted — the loop records the breach.
- **A new pure module owns card details + formatting.**
  `src/extension/handoff-card.ts` (new, ~<150 LOC) holds:
  `HandoffCardDetails` (the seam contract type),
  `tryBuildHandoffCard(role, toolName, args, isOrchestrator)` (validate
  + build details, returns `null` on invalid), and
  `formatHandoffCardContent(details)` (the plaintext fallback string
  for `content`). Pure functions, no `ctx`, no I/O, no pi imports —
  unit-testable in isolation like `handoff-view.ts`.
- **A new renderer module owns the `conduct.handoff` renderer.**
  `src/extension/handoff-card-renderer.ts` (new, ~<120 LOC) follows the
  `conduct-message-renderer.ts` pattern: thin closure over a container
  builder, `pickLabelColor` for the label, `getMarkdownTheme()` for the
  body, fail-safe try/catch. Exports `createHandoffCardRenderers(
  getOrchestratorRole)` returning `{ "conduct.handoff": renderer }`.
- **The sink gains a handoff branch, keeps the text branch.**
  `display-sink-wiring.ts` checks `event.toolName` for `tool_call`
  events: if `"handoff"` or `"end"`, call `tryBuildHandoffCard` and
  emit a `conduct.handoff` message; otherwise suppress (Phase 5.5).
  The text branch is unchanged.
- **Registration merges the two renderer records.** `extensions/conduct.ts`
  spreads both `createConductMessageRenderers(...)` and
  `createHandoffCardRenderers(...)` into one record and iterates
  `Object.entries` — same loop, one extra entry.
- **No host-loop changes.** `src/host/loop.ts`,
  `production-host.ts`, `run-handle.ts`, `stats.ts` are NOT modified.

## Task list

### Phase A — `DisplayEvent` widening + event-handler population (host layer)

- [ ] **Task A1: Widen `DisplayEvent` with optional `toolName` + `args`**
  - **Description:** In `src/host/display-sink.ts`, add two optional
    fields to `DisplayEvent`: `readonly toolName?: string` and
    `readonly args?: unknown`. Update the JSDoc to document that
    `toolName` is set only for `tool_call` / `tool_result` events and
    `args` is set only for `tool_call` events. The `DisplayEventKind`
    and `DisplaySink` types are unchanged.
  - **Acceptance:**
    - [ ] `DisplayEvent` has the two new optional fields.
    - [ ] `pnpm typecheck` clean (the widening is additive; no
          existing code breaks).
    - [ ] Existing `display-forwarding.test.ts` still passes (the
          test constructs events without the new fields; the
          assertions check `role` / `kind` / `text` only).
  - **Verify:** `pnpm typecheck && pnpm test -- display-forwarding`.
  - **Dependencies:** None.
  - **Files likely touched:** `src/host/display-sink.ts`.
  - **Estimated scope:** S (1 file).

- [ ] **Task A2: Populate `toolName` + `args` in `session-event-handler.ts`**
  - **Description:** In `src/host/session-event-handler.ts`, the
    `tool_execution_start` branch (lines 112–119) now forwards
    `toolName: event.toolName` and `args: event.args` alongside the
    existing `text` field. The `tool_execution_end` branch forwards
    `toolName: event.toolName` (no `args` — the result event does not
    carry the original args). Text events omit both fields
    (`exactOptionalPropertyTypes`).
  - **Acceptance:**
    - [ ] `tool_execution_start` events arrive at the sink with
          `toolName` and `args` populated.
    - [ ] `tool_execution_end` events arrive with `toolName` populated.
    - [ ] Text events omit both fields.
    - [ ] `display-forwarding.test.ts` updated to expect the new
          fields on tool events (the exact-match assertions need the
          new fields).
  - **Verify:** `pnpm typecheck && pnpm test -- display-forwarding`.
  - **Dependencies:** A1.
  - **Files likely touched:** `src/host/session-event-handler.ts`,
    `tests/host/display-forwarding.test.ts`.
  - **Estimated scope:** S (2 files).

### Checkpoint: Host layer widening

- [ ] All Phase A tests pass.
- [ ] `pnpm typecheck && pnpm build && pnpm lint && pnpm format:check` clean.
- [ ] Grep guard green.

### Phase B — Pure card details + formatting (foundation)

- [ ] **Task B1: Create `src/extension/handoff-card.ts` — details + formatter**
  - **Description:** A new single-purpose module with:
    - `HandoffCardDetails` interface (the seam contract — see spec R3).
    - `tryBuildHandoffCard(role: string, toolName: string, args:
      unknown, isOrchestrator: boolean): HandoffCardDetails | null` —
      validates `args` against `handoffArgsSchema` / `endArgsSchema`
      via `Value.Check`, builds `HandoffCardDetails` from the validated
      args, returns `null` on invalid or non-handoff/non-end toolName.
      `payload` is included only when it is a string (accessed via
      `(args as Record<string, unknown>).payload`).
    - `formatHandoffCardContent(details: HandoffCardDetails): string` —
      the plaintext fallback for the `CustomMessage.content` field
      (e.g. `orchestrator → worker — reason: … · suggests_next: …`).
      Used by the default `CustomMessageComponent` if the renderer
      fails.
    - `formatHandoffCardBody(details: HandoffCardDetails): string` —
      the markdown body string for the renderer (e.g.
      `**reason:** …\n**suggests_next:** …\n**payload:** …`). Each
      field is on its own line; absent fields are omitted.
  - **Acceptance:**
    - [ ] `tryBuildHandoffCard` returns valid details for a valid
          handoff args object with all optional fields.
    - [ ] `tryBuildHandoffCard` returns valid details for a valid
          handoff with only `target_role` (no optional fields).
    - [ ] `tryBuildHandoffCard` returns valid details for a valid
          `end` args object with `reason`.
    - [ ] `tryBuildHandoffCard` returns `null` for a schema-invalid
          handoff (missing `target_role`).
    - [ ] `tryBuildHandoffCard` returns `null` for a non-handoff/non-end
          toolName (e.g. `"bash"`).
    - [ ] `tryBuildHandoffCard` includes `payload` only when it is a
          string; skips non-string payloads.
    - [ ] `formatHandoffCardContent` produces a readable one-line
          fallback.
    - [ ] `formatHandoffCardBody` produces a markdown string with
          `**reason:**`, `**suggests_next:**`, `**payload:**` lines
          (only present fields).
  - **Verify:** `pnpm test -- handoff-card` (new test file);
    `pnpm typecheck`.
  - **Dependencies:** None (pure module; imports `typebox/value` and
    `src/seam/schema.ts` only).
  - **Files likely touched:** `src/extension/handoff-card.ts` (new),
    `tests/extension/handoff-card.test.ts` (new).
  - **Estimated scope:** S (2 files).

### Phase C — Display sink handoff branch (wiring)

- [ ] **Task C1: Add the handoff card emission to the display sink**
  - **Description:** In `src/extension/display-sink-wiring.ts`, add a
    branch before the existing `if (event.kind !== "text") return;`
    guard: if `event.kind === "tool_call"` AND `event.toolName` is
    `"handoff"` or `"end"`, call `tryBuildHandoffCard(event.role,
    event.toolName, event.args, isOrchestrator)`. If the result is
    non-null, emit a `conduct.handoff` `CustomMessage` via
    `sendMessage` with `{ customType: "conduct.handoff", content:
    formatHandoffCardContent(details), display: true, details }`. If
    null (schema-invalid or missing args), fall through to suppression.
    Non-handoff tool calls and all `tool_result` events are still
    suppressed (the existing guard handles them).
  - **Acceptance:**
    - [ ] A valid `handoff` tool_call event emits a `conduct.handoff`
          `CustomMessage` with the correct `details`.
    - [ ] A valid `end` tool_call event emits a `conduct.handoff`
          `CustomMessage` with `target: "done"`.
    - [ ] A schema-invalid handoff tool_call event does NOT emit
          (suppressed).
    - [ ] A `bash` tool_call event does NOT emit (suppressed).
    - [ ] A `tool_result` event does NOT emit (suppressed).
    - [ ] Text events still emit `conduct.role.text` as before
          (unchanged).
    - [ ] `is_orchestrator` is computed from `getCurrentOrchestratorRole()`
          (same as the text branch).
  - **Verify:** `pnpm test -- tui-bridge` (extend existing
    `tui-bridge.test.ts` with handoff-card cases);
    `pnpm typecheck`.
  - **Dependencies:** A1, A2, B1.
  - **Files likely touched:** `src/extension/display-sink-wiring.ts`,
    `tests/extension/tui-bridge.test.ts`.
  - **Estimated scope:** M (2 files).

### Phase D — Handoff card renderer

- [ ] **Task D1: Create `src/extension/handoff-card-renderer.ts`**
  - **Description:** A new module following the
    `conduct-message-renderer.ts` pattern. Exports
    `createHandoffCardRenderers(getOrchestratorRole: () => string |
    null): Record<string, MessageRenderer<HandoffCardDetails>>` returning
    `{ "conduct.handoff": renderer }`. The renderer:
    - Builds a `Container` with:
      1. `Text` — the label `<role> → <target>`, bolded via
         `theme.bold`, colored by `pickLabelColor` (same logic as the
         text renderer — reuse the helper or duplicate it; see
         assumption below).
      2. `Markdown` — the body from `formatHandoffCardBody(details)`,
         via `getMarkdownTheme()`.
    - Returns `undefined` on any throw (fail-safe).
    - Reads `details` for the label and body; `message.content` is the
      fallback (not read by the renderer).
  - **Assumption:** `pickLabelColor` is currently a private function
    in `conduct-message-renderer.ts`. I will either (a) export it
    from `conduct-message-renderer.ts` for reuse, or (b) duplicate the
    3-line helper in `handoff-card-renderer.ts`. Default: **export it**
    (avoids drift; the function is pure and already tested). If
    exporting it bloats the public API undesirably, duplicate with a
    comment pointing at the original.
  - **Acceptance:**
    - [ ] `createHandoffCardRenderers` returns a record with the
          `"conduct.handoff"` key.
    - [ ] The renderer produces a `Container` with a `Text` label
          child and a `Markdown` body child.
    - [ ] The label text is `<role> → <target>`, bolded, colored by
          role family.
    - [ ] The body markdown carries `**reason:** …` etc. (only present
          fields).
    - [ ] The renderer returns `undefined` on a forced throw
          (fail-safe).
    - [ ] The renderer is defensive when `details` is missing (muted
          fallback label, empty body).
  - **Verify:** `pnpm test -- handoff-card-renderer` (new test file,
    matching `conduct-message-renderer.test.ts` patterns);
    `pnpm typecheck`.
  - **Dependencies:** B1.
  - **Files likely touched:** `src/extension/handoff-card-renderer.ts`
    (new), `src/extension/conduct-message-renderer.ts` (export
    `pickLabelColor`), `tests/extension/handoff-card-renderer.test.ts`
    (new).
  - **Estimated scope:** M (3 files).

- [ ] **Task D2: Register the handoff card renderer in `extensions/conduct.ts`**
  - **Description:** In `extensions/conduct.ts`, import
    `createHandoffCardRenderers` and merge its record with
    `createConductMessageRenderers`'s record before the registration
    loop:
    ```ts
    const renderers = {
      ...createConductMessageRenderers(getCurrentOrchestratorRole),
      ...createHandoffCardRenderers(getCurrentOrchestratorRole),
    };
    for (const [customType, renderer] of Object.entries(renderers)) {
      pi.registerMessageRenderer(customType, renderer);
    }
    ```
  - **Acceptance:**
    - [ ] Both `conduct.role.text` and `conduct.handoff` renderers are
          registered.
    - [ ] `conduct-registration.test.ts` (or equivalent) asserts the
          new renderer is registered.
  - **Verify:** `pnpm test -- conduct-registration`;
    `pnpm typecheck`.
  - **Dependencies:** D1.
  - **Files likely touched:** `extensions/conduct.ts`,
    `tests/extension/conduct-registration.test.ts`.
  - **Estimated scope:** S (2 files).

### Phase E — Prompt-side changes (Lever B)

- [ ] **Task E1: Update `.pi/roles/*.md` with no-narration instruction**
  - **Description:** Add a behavioral constraint to all four role files
    (`orchestrator.md`, `implementer.md`, `planner.md`,
    `reviewer.md`): "Do not narrate tool calls in text. The TUI
    renders tool activity as structured cards; your text output should
    be your reasoning and decisions, not a restatement of tool
    arguments or results." The instruction is appended to each file's
    existing bullet list.
  - **Acceptance:**
    - [ ] All four role files contain the no-narration instruction.
    - [ ] No role file loses its existing content.
  - **Verify:** manual read of the four files; `pnpm test` (no test
    asserts role file content, but the full suite must stay green).
  - **Dependencies:** None (independent of A–D).
  - **Files likely touched:** `.pi/roles/orchestrator.md`,
    `.pi/roles/implementer.md`, `.pi/roles/planner.md`,
    `.pi/roles/reviewer.md`.
  - **Estimated scope:** S (4 files, trivial edits).

- [ ] **Task E2: Add no-narration hint to handoff/end tool descriptions**
  - **Description:** In `src/host/tools.ts`, append to the `handoff`
    tool's `description`: " Do not also write this as text — the TUI
    renders the handoff as a structured card." Same for the `end`
    tool's `description`. The `execute` logic is unchanged.
  - **Acceptance:**
    - [ ] The `handoff` tool description includes the no-narration hint.
    - [ ] The `end` tool description includes the no-narration hint.
    - [ ] No existing test breaks (verified: no test asserts the exact
          description string).
    - [ ] `pnpm typecheck && pnpm test` clean.
  - **Verify:** `pnpm typecheck && pnpm test`.
  - **Dependencies:** None (independent of A–D).
  - **Files likely touched:** `src/host/tools.ts`.
  - **Estimated scope:** S (1 file).

### Phase F — E2E test + docs

- [ ] **Task F1: Extend the stub-driven E2E to assert handoff cards**
  - **Description:** The existing `tests/extension/conduct-e2e.test.ts`
    drives a real run via the stub provider. Extend it (or add a
    companion) to assert that the `sendMessage` calls include a
    `conduct.handoff` `CustomMessage` for each handoff the stub script
    performs, with the correct `details` (role, target, reason if
    present). This is the AC2/AC3/AC4 end-to-end proof. The E2E may
    need to assert against the `sendMessage` mock (the display sink
    calls `sendMessage` for each card) or against a captured render
    output.
  - **Acceptance:**
    - [ ] E2E asserts at least one `conduct.handoff` card is emitted
          with the correct `details.target` and `details.role`.
    - [ ] E2E asserts a schema-invalid handoff does NOT emit a card
          (if the stub script can produce one; otherwise covered by
          the unit test in B1/C1).
    - [ ] E2E asserts non-handoff tool calls do NOT emit cards.
  - **Verify:** `pnpm test -- conduct-e2e`.
  - **Dependencies:** C1, D2.
  - **Files likely touched:** `tests/extension/conduct-e2e.test.ts`
    (or a new companion `conduct-handoff-card-e2e.test.ts`).
  - **Estimated scope:** M (1–2 files).

- [ ] **Task F2: Update `docs/extension-usage.md`**
  - **Description:** Add a "Handoff cards" subsection (under the
    existing "Streaming" section or as a new subsection of "Handoff
    visibility") documenting: (a) the `conduct.handoff` `customType`
    and what the card shows (role → target, reason, suggests_next,
    payload), (b) when it appears (on each `handoff`/`end` tool call
    during a run), (c) that schema-invalid calls do not render a card,
    (d) that the card is model-independent (reads tool args, not LLM
    text), (e) the prompt-side no-narration instruction. Update the
    existing "Streaming" section's claim that "tool calls, tool
    results, and the conductor's `handoff`/`end` protocol noise are
    not shown in the TUI" — this is now partially superseded: handoff
    and end tool calls DO surface as cards (but not as raw JSON).
  - **Acceptance:**
    - [ ] The handoff card surface is documented end-to-end (AC10).
    - [ ] The "Streaming" section is updated to reflect the card.
    - [ ] No claims about non-string payload rendering (it is skipped
          in v1).
  - **Verify:** manual read of the updated doc.
  - **Dependencies:** C1, D2.
  - **Files likely touched:** `docs/extension-usage.md`.
  - **Estimated scope:** S (1 file).

### Checkpoint: Complete

- [ ] All acceptance criteria AC1–AC10 addressed (tick in the spec
      when verified, including the manual real-model run for AC2/AC3/AC7).
- [ ] `pnpm typecheck && pnpm build && pnpm test && pnpm lint && pnpm format:check` clean.
- [ ] Grep guard green; no `ctx.newSession`/`ctx.fork` in `extensions/`.
- [ ] `docs/extension-usage.md` updated.
- [ ] Ready for reviewer end-to-end review.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Widening `DisplayEvent` breaks `exactOptionalPropertyTypes` | Med | Use conditional spreads or omit keys on text/result events; never set `undefined`. Typecheck catches it. |
| `display-forwarding.test.ts` exact-match assertions break | Low | Update the test in A2 to expect the new fields on tool events. The test already constructs SDK events with `toolName`/`args`. |
| `pickLabelColor` export bloats the public API | Low | It's a pure 3-line helper; exporting it from `conduct-message-renderer.ts` is the smallest change. Alternatively duplicate with a pointer comment. |
| The LLM still narrates despite the prompt update (Lever B fails) | Low | Lever A (the card) is authoritative — the user sees the card regardless. The narration is cosmetic noise, not a correctness issue. |
| `payload` is an object, not a string (edge case) | Low | `tryBuildHandoffCard` skips non-string payloads (documented in spec R3). The user can see the full payload in the session JSONL. |
| The card emits twice (once from `tool_execution_start`, once from `tool_execution_end`) | Med | The sink only intercepts `tool_call` (start) events, NOT `tool_result` (end) events. `tool_result` events are still suppressed by the existing guard. One card per handoff. |
| `Value.Check` at the sink duplicates the seam's validation | Low | It reuses the SAME schemas (single source of truth). The sink check is a display-time gate, not a seam enforcement — the loop's `validateEmission` is still the authoritative contract check. The sink check just prevents rendering a malformed card. |

## Open questions (carried from the spec)

- Q1 Card source: **tool_call args, validated at the sink.**
- Q2 Card layout: **compact multi-line block (2–4 lines).**
- Q3 Text filtering: **no — do not filter.**
- Q4 Backward compatibility: **no migration needed.**
- Q5 Prompt scope: **all roles with the handoff tool.**

These are surfaced for the overseer's acknowledgment; the implementer
proceeds with the defaults unless the overseer overrides before
implementation begins.
