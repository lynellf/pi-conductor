# Phase 1 — Issue #8: Disjointed TUI output

**Source:** [`../plan.md`](../plan.md); GH issue #8 (`Disjointed TUI output`, bug).
Sub-plan for the architectural + implementation steps.

## Goal

Make a role's streamed assistant text — whether thinking or direct
output — render in pi's TUI as **one continuous block** per assistant
turn. Eliminate the per-chunk visual line breaks caused by
`CustomMessageComponent`'s hardcoded leading `Spacer(1)` being applied
to every streamed chunk emitted under `conduct.role.text_stream`.

## What the user reported

> "Is it possible to ensure an agent role's output, whether thinking or
> output for the user to read directly, is one continuous block of
> text? At the moment, messages may appear on new lines although it's
> meant to be part of a single response."
>
> *(referenced screenshot reproduced in the issue body; absent the image
> here, the user's textual description is the source of truth)*

A role's streamed text appears as multiple visually-separated blocks
in pi's TUI rather than one continuous block.

## Root cause (verified)

Pi's `CustomMessageComponent` (in
`node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-message.js`)
constructs itself with a hardcoded leading blank line:

```js
// custom-message.js: line 19
this.addChild(new Spacer(1));
// ... later, in rebuild(): line 36
if (this.customRenderer) {
    ...
    if (component) {
        this.customComponent = component;
        this.addChild(component);  // renderer's output, AFTER the Spacer
        return;
    }
}
```

Every `sendMessage({ customType: "conduct.role.text_stream", ... })`
call inserts one `CustomMessageComponent` (with its leading Spacer) into
the session tree. The current display sink
(`src/extension/display-sink-wiring.ts:85–95`) emits one
`conduct.role.text_stream` per `STREAM_FLUSH_THRESHOLD_CHARS` (200) of
formatted text. The result is a sequence of `Markdown` blocks separated
by blank lines, each in its own TUI frame — i.e. exactly the disjointed
rendering the user described.

There is no renderer-side mitigation: the leading Spacer is a property
of the framework class, not a render-time call. `pi.sendMessage` only
adds new `CustomMessage`s to the session tree; the SDK has no in-place
update or stream API.

## Design decisions (must be confirmed before Task 1.1 lands)

### Decision 1 — The fix: buffer chunks, emit one CustomMessage per assistant turn

**Recommendation:** Accept that visual continuity and live progressive
streaming cannot both be served by `pi.sendMessage`. Choose continuity.

**Approach (recommended):**

- Drop the per-chunk `conduct.role.text_stream` emission path. Text +
  thinking content (blockquoted) accumulates in the display sink for
  the in-flight assistant message.
- On `message_end`, emit exactly one `conduct.role.text` CustomMessage
  containing the full `extractAssistantText(msg)` output.
- The existing `buildContainer` renderer (`src/extension/conduct-message-renderer.ts:165–220`)
  handles `text` already — it places a role label and the body as a
  `Markdown` child in a `Container`, which renders as one visual block.
- Tool events (`conduct.role.tool`) keep their per-event emission —
  they are atomic and not user-text-streaming.
- Blockquote continuity (`src/host/markdown-continuation.ts`) becomes
  unused — see Decision 2.

**Trade-off surfaced (overseer sign-off requested):**

- *Loss:* live progressive text rendering. The user no longer sees the
  role's text "type out"; it appears all at once at `message_end`.
  Blockquote-prefixed thinking flashes in at the same moment as direct
  output.
- *Gain:* one continuous visual block per turn. Fixes the user's
  stated bug. Removes the chunk-flushing + boundary-seeking + Spacer
  arithmetic from the hot path.

**Why other options are worse:**

- *Keep streaming, monkey-patch pi's `CustomMessageComponent`.* No
  stable hook; every SDK update risks breaking the patch.
- *Keep streaming, accumulate in the renderer.* The renderer's
  per-message state would need to track prior chunks across messages —
  not feasible across `sendMessage` calls (each new `CustomMessage` is
  freshly mounted).
- *Keep streaming, accept visual gaps.* This is the current bug.

### Decision 2 — Retire `text_stream` from the public DisplayEvent surface

If Decision 1 is approved, the per-chunk `text_stream` kind becomes
strictly internal buffering state and is no longer surfaced.

**Recommendation:** keep the `text_stream` `DisplayEventKind` variant
internally for now (the `DisplaySink` contract stays a 4-variant
union) and have the sink swallow it (no `sendMessage` call). The
contract variant stays available for any future forwarding need (e.g.
a CLI-side live-status display). The `conduct.role.text_stream`
renderer is removed from `createConductMessageRenderers` and the
extension registration loop in `extensions/conduct.ts`. The
`markdown-continuation` helper stays in the codebase but is unused
(no callsite); a follow-up can delete it. `boundary-flush` likewise
goes unused. Both can stay one more release so any in-flight tests
relying on the helper still type-check.

### Decision 3 — Handle `display: false` consistently with the prior renderer

The current code passes `display: true` for all events, including
text. The conductor-owned renderer (`buildContainer`) currently draws
its own role label; the goal here is to keep that label as the
single visual anchor per turn.

**No change** — `display: true` continues, label is still drawn by
`buildContainer`. The label still distinguishes role + orchestrator
status by color (already implemented).

### Decision 4 — Keep the throttle (a separate observability signal?)

The current `STREAM_FLUSH_THRESHOLD_CHARS` constant is the test seam
for `tests/host/display-forwarding.test.ts`. If text stream flushing
goes away, the constant and its exports can be removed too (Decision
2's retirement). The display-forwarding tests will be rewritten to
pin the new behavior — one `text` event per assistant turn,
irrespective of size.

## Sub-tasks (after Decision 1 sign-off)

### Task 1.1 — Sink: accumulate text, emit once on `message_end`

**Description:** Modify `src/extension/display-sink-wiring.ts` so
`text_stream` events accumulate into a per-message buffer instead of
emitting CustomMessages. On `message_end` of the matching assistant
message, emit one `conduct.role.text` carrying the full buffered
text. The buffer is cleared on every `message_start`.

**Acceptance criteria:**

- [ ] `text_stream` events no longer trigger `sendMessage`.
- [ ] `message_start` clears any in-progress buffer.
- [ ] `message_end` for an assistant message emits exactly one
      `conduct.role.text` per turn, with the full
      `extractAssistantText(msg)` content as the body (already
      delivered by the host at `session-event-handler.ts`).
- [ ] `tool_call` / `tool_result` events still emit `conduct.role.tool`
      per event.
- [ ] Behavior under `AbortController` / concurrent sessions is
      unchanged — each session has its own `DisplaySink` closure.

**Verification:**

- [ ] Unit tests in `tests/extension/display-sink-wiring.test.ts` (or
      equivalent) pin:
  - one `conduct.role.text` per assistant turn (regardless of message
    length).
  - one `conduct.role.tool` per tool event.
  - empty assistant message → no `conduct.role.text` emission.
- [ ] Integration test in `tests/extension/conduct-e2e.test.ts` drives
      a stub session with a multi-paragraph assistant message and
      asserts the CustomMessage stream has exactly one
      `conduct.role.text` and zero `conduct.role.text_stream`.

**Dependencies:**

- Task 1.4 (renderer re-registration must finish first OR a one-line
  "no-op renderer" stub is acceptable to keep the message types in
  the registry temporarily). Implementation order: 1.4 → 1.1.

**Files likely touched:**

- `src/extension/display-sink-wiring.ts` (accumulator state + emit
  logic; expect ~+30 / −20 LOC).

**Estimated scope:** S (1–2 files).

### Task 1.2 — Remove `conduct.role.text_stream` from the renderer map

**Description:** Delete `createTextStreamRenderer` and the
`"conduct.role.text_stream": textStreamRenderer` registration from
`createConductMessageRenderers` in
`src/extension/conduct-message-renderer.ts`. Delete the now-unused
`buildTextStreamContainer`. Remove the `"text_stream"` literal from
`ConductMessageKind` if no callers reference it (one type alias
cleanup).

**Acceptance criteria:**

- [ ] `createConductMessageRenderers` returns a record with exactly
      two keys: `"conduct.role.text"` and `"conduct.role.tool"`.
- [ ] `ConductMessageKind` no longer includes `"text_stream"`.
- [ ] `grep -r "text_stream" src/` returns no production matches
      (only OKF / comment references, if any).
- [ ] `extensions/conduct.ts` registration loop only registers the
      two surviving renderers.

**Verification:**

- [ ] `pnpm typecheck` green.
- [ ] `pnpm lint` green (`Biome` flags unused exports automatically).
- [ ] `tests/extension/conduct-message-renderer.test.ts` updates:
  - removes any case asserting the text_stream renderer exists;
  - adds a case asserting the renderer map has exactly two keys.

**Dependencies:** Task 1.1 last (so the sink stops emitting before the
renderer key disappears). Order: 1.4 → 1.1 → 1.2.

**Files likely touched:**

- `src/extension/conduct-message-renderer.ts` (renderer deletion).
- `extensions/conduct.ts` (registration loop — if it iterates the map,
  no code change; verify only).
- `tests/extension/conduct-message-renderer.test.ts` (test edit).

**Estimated scope:** S (1 file + 1 test file).

### Task 1.3 — Update `tests/host/display-forwarding.test.ts`

**Description:** The existing forwarding tests
(`tests/host/display-forwarding.test.ts`) exercise the streaming path
through `attachSessionEventHandler` + `findFlushBoundary`. After
Phase 1, the host still emits one `onDisplay` event per
`message_end` (with full text) and the boundary-flush logic is no
longer triggered from the sink (the sink now drives on `message_end`
rather than progressively). The forwarding test surface needs to
change from "delta since last flush" to "no per-update text events".

**Acceptance criteria:**

- [ ] Test case names referencing progressive streaming are updated
      to reflect the new behavior (single emit per turn).
- [ ] New case: a single multi-paragraph assistant message → sink
      observes a single `text` event with the full string, not a
      series of `text_stream` deltas.
- [ ] Blockquote continuity case (the original reason for
      `markdown-continuation.ts`) is **removed** — its purpose is
      gone.
- [ ] Tool-call streaming cases are unchanged.
- [ ] `STREAM_FLUSH_THRESHOLD_CHARS` and `MAX_FLUSH_WINDOW_CHARS` are
      no longer referenced from the test surface.

**Verification:**

- [ ] `pnpm test -- display-forwarding` is green.
- [ ] `pnpm typecheck` green.

**Dependencies:** Tasks 1.1, 1.2.

**Files likely touched:**

- `tests/host/display-forwarding.test.ts` (rewrite the streaming
  cases).

**Estimated scope:** M (1 test file, multiple case edits).

### Task 1.4 — Update `tests/extension/tui-bridge.test.ts` and `tests/host/display-forwarding.test.ts` setup

**Description:** Some tests assert the renderer's output structure or
the bridge wiring. After Phase 1, any case asserting
`conduct.role.text_stream` rendering must be removed or reframed.
The renderer-registration count assertion (currently 3 keys) becomes
2 keys.

**Acceptance criteria:**

- [ ] Every existing test case mentioning `text_stream` is updated to
      reflect the post-Phase-1 world (no such messages exist; one
      `conduct.role.text` per turn).
- [ ] Registration test asserts 2 keys (not 3).

**Verification:**

- [ ] `pnpm test -- --run tests/extension` green.
- [ ] `pnpm test -- --run tests/host` green.

**Dependencies:** Tasks 1.1, 1.2.

**Files likely touched:**

- `tests/extension/tui-bridge.test.ts` (registration + replay).
- Maybe `tests/extension/conduct-e2e.test.ts` if it asserts a stream.
- `tests/extension/conduct-message-renderer.test.ts` (renderer map
  shape).

**Estimated scope:** S (1–3 test files).

### Task 1.5 — `src/host/boundary-flush.ts` and `src/host/markdown-continuation.ts` — leave or remove?

**Description:** Both modules are unused after Phase 1. The cleanest
option is to delete them. The safest option is to leave them and let
a future cleanup task retire them when no caller is left.

**Acceptance criteria:**

- [ ] `boundary-flush.ts` has zero callers in `src/host/` (after
      Phase 1 completes). Search: `grep -rn "findFlushBoundary\|MAX_FLUSH_WINDOW_CHARS" src/`.
- [ ] `markdown-continuation.ts` has zero callers in `src/host/` (the
      text_stream call sites in `session-event-handler.ts` go away
      with Task 1.1; `boundary-flush.ts` import goes away too).
- [ ] If zero callers, both modules are deleted (Phase 1 owns them
      rather than leaving dead code).
- [ ] Both `docs/archive/tui-stream-readability/` and
      `docs/archive/quote-block-rendering-fix/` archive folders stay
      read-only — they document the historical design.

**Verification:**

- [ ] `pnpm typecheck` green after deletion (Biome catches unused
      exports automatically; manual deletion only after a clean
      result).
- [ ] `pnpm test -- --run tests/host` green.

**Dependencies:** Task 1.1 first (so call-sites vanish).

**Files likely touched:**

- `src/host/boundary-flush.ts` (delete).
- `src/host/markdown-continuation.ts` (delete).
- `tests/host/boundary-flush.test.ts` (delete).
- `tests/host/markdown-continuation.test.ts` (delete).
- `src/host/session-event-handler.ts` (remove imports + handling).

**Estimated scope:** S (1 host module + 1 test file + small
adjustments elsewhere).

### Task 1.6 — OKF note (managed by `okf-curator`, post-merge)

**Description:** The `markdown-continuation` OKF documents
(`.okf/components/markdown-continuation.md` and
`.okf/pitfalls/chunk-boundary-blockquote-loss.md`) describe a
component the implementation now removes. An `okf-curator` pass
should mark them stale (or archive) and replace with a one-paragraph
note that the live-streaming design was retired.

**Acceptance criteria:**

- [ ] The two OKF docs are updated/archived post-merge (out of scope
      for this phase's implementer; noted for the post-merge
      follow-on).

**Dependencies:** Phase 1 merged.

**Files likely touched:**

- `.okf/components/markdown-continuation.md` — archive / mark stale.
- `.okf/pitfalls/chunk-boundary-blockquote-loss.md` — archive / mark
  stale.

**Estimated scope:** XS (curator-only, post-merge).

## Implementation order

1. **Task 1.4 — test setup pass.** Update tests first so they describe
   the desired post-Phase-1 state; the test failures then drive the
   implementation.
2. **Task 1.1 — sink behavior.** Accumulator + emit-on-end.
3. **Task 1.2 — renderer deletion.** Drop `text_stream` from the
   renderer map.
4. **Task 1.3 — forwarding test rewrite.** Rewrite forwarding tests
   under the new model.
5. **Task 1.5 — module cleanup.** Delete `boundary-flush.ts` and
   `markdown-continuation.ts` once they have zero call-sites.
6. **Task 1.6 — OKF (post-merge).** `okf-curator` owns.

## Checkpoint: end of Phase 1

- [ ] `pnpm typecheck` green.
- [ ] `pnpm lint` green.
- [ ] `pnpm test` green (full suite, not just the touched files).
- [ ] `pnpm build` emits `dist/` with `.d.ts`.
- [ ] Manual TUI walkthrough: in `/conduct`, drive a role whose
      assistant message is multi-paragraph + contains blockquoted
      thinking. Confirm the role's output renders as one continuous
      block — no blank lines between paragraphs of the same message.
      *(Same shape as the issue's intended outcome.)*
- [ ] GH issue #8 is closed via `gh issue close 8 --reason completed`
      with a comment pointing at the diff (e.g., commit SHA) and the
      archive folder for the work (`docs/archive/open-issues-round-2/`).

## Out of scope

- Adding a new "live stream" feature flag to restore
  `conduct.role.text_stream`. Possible future addition; not in this
  round.
- Changing pi SDK types or behavior.
- Any change to the reducer, FSM contract, `Checkpoint` schema, or
  `PersistedRecord` union.
- Changes to thinking-content extraction
  (`src/host/display-sink.ts:extractAssistantText`) — the function is
  unchanged; the sink just no longer breaks its output into chunks.
