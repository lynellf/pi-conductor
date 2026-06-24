# Spec: Progressive assistant-text streaming (Approach A — suffix-chunk flush)

> Display-layer refinement for the `/conduct` tool-observability stream.
> Continues the lineage of `docs/archive/tool-observability-and-spinner-spec.md`,
> `docs/archive/tool-ux-refinement-spec.md`, and
> `docs/archive/tool-display-combine-status/spec.md` (all Phase 7B UX).
> Touches only the display surface — **no `docs/orchestrator-fsm-spec.md`
> changes**; the core FSM, the durable per-role session JSONL, and all
> cost/reducer invariants are unaffected (the TUI stream is an
> observability surface, not the record of truth — see
> `src/extension/display-sink-wiring.ts` file comment).

## Revision summary

Initial spec. Scope is one display behavior: surface an assistant
message **progressively** (in chunks) as the model streams, instead of
delivering the entire turn's text in one monolithic `conduct.role.text`
block at `message_end`. Implemented as "Approach A" from the prior
feasibility investigation (the user confirmed it): a **periodic
suffix-chunk flush** over the SDK's existing `message_update` event
stream, delivered through the **existing** `sendMessage` pipeline.

## What I found (investigation notes — basis for the plan)

### The pain — confirmed against code

`session-event-handler.ts` has an early guard
`if (event.type !== "message_end") return;` (preceded only by the two
`tool_execution_*` branches). Every `message_update` event the SDK
streams while the model is generating is dropped on the floor. Only at
`message_end` does `extractAssistantText(message)`
(`src/host/display-sink.ts`) run once on the finished message and emit a
single `kind: "text"` `DisplayEvent` → one `conduct.role.text`
`CustomMessage`. Result: the operator sees **nothing** while a long role
turn is in flight, then the entire response materializes at once.

### SDK provides what we need — pinned contract (re-verified in node_modules)

The provider-level `AssistantMessageEvent` stream
(`@earendil-works/pi-ai/dist/types.d.ts` L250–301) carries, for **every**
variant (`text_start` / `text_delta` / `text_end` / `thinking_*` /
`toolcall_*`), a `partial: AssistantMessage` — the full accumulated
snapshot so far. The agent core
(`@earendil-works/pi-agent-core/dist/.../types.d.ts` L369–371 and
`agent-loop.js` L215–227) re-emits each as a top-level `AgentEvent`:

```ts
{ type: "message_update", message: AgentMessage, assistantMessageEvent: AssistantMessageEvent }
```

`AgentSessionEvent` (`@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts`
L40) keeps `message_update` (it excludes only `agent_end` from `AgentEvent`),
and `agent-session.js` L385–392 re-emits it verbatim to `session.subscribe`
listeners. So `attachSessionEventHandler` already receives a `message_update`
per delta, and `event.message` is the partial `AssistantMessage` snapshot.
Verified by reading both the `.d.ts` and the `.js`.

### The constraint that shapes the design — append-only CustomMessages

`ExtensionAPI.sendMessage()` (`src/extension/display-sink-wiring.ts`)
creates a **new** `CustomMessage` each call. There is **no** update/edit/
replace primitive on `display: true` custom messages (the prior
`tool-display-combine-status` spec hit the same wall). So:

- Emitting every delta as its own `sendMessage` floods the transcript
  with many tiny blocks (bad).
- Emitting the **full accumulated snapshot** periodically creates a
  sequence of **growing duplicate** blocks (each contains everything
  before plus the new text) — redundant scrolling (the assistant's
  investigation labelled this "imperfect UX").

Neither is good. The clean append-only-compatible model is to emit, on
each flush, **only the suffix** that has not been shown yet (the new
characters since the last flush). The TUI then renders the full message
as a concatenation of chunked `conduct.role.text` blocks — append-only
safe, **no duplication**, and the full text is reconstructed by reading
the sequence in order.

### Reusing `extractAssistantText` for free

`extractAssistantText(partial)` already does the formatting work we want
for streaming: it merges adjacent `text` parts, blockquotes non-redacted
`thinking` parts, joins blocks with `"\n\n"`, and skips redacted thinking.
Because it is a **pure function of the snapshot**, running it on each
`message_update`'s `partial` and `slice`-ing off the already-flushed
prefix yields exactly the new formatted characters — no manual delta
buffering, no ordering hazards, tool-call blocks ignored automatically.
This is the single key reuse that keeps the change to ~one source file.

### Backward compatibility — the message_end remainder path

The `message_end` step is reframed from "emit the whole text" to **"emit
the unflushed tail"**: `text.slice(streamedLen)`. When no `message_update`
ever fired (the pre-streaming path, every existing test), `streamedLen`
stays `0`, so `text.slice(0)` === the current behavior byte-for-byte.
Concretely the four existing `message_end`-only assertions in
`tests/host/display-forwarding.test.ts` (the `"Hello \n\n> planning the
response\n\nworld"`, blockquote, redacted, and tool-line tests) remain
green unchanged — their sessions emit no `message_update`, so the
streaming code is inert and the remainder equals the full text.

### Stub provider — zero regression risk

`src/host/stub-provider.ts` `emit_text` (L250–256) pushes the **entire**
text as a single `text_delta` with a partial already containing the full
text. Under streaming this produces exactly one `message_update`: if the
text is `>=` the flush threshold, it flushes the full text once and marks
it flushed; the subsequent `message_end` tail is then empty and emits
nothing — **net one `conduct.role.text` block carrying the full text**, the
same count and content as today. If the text is under threshold, no
`message_update` flush and `message_end` emits the full text — also
identical to today. E2E suites assert persisted records, not display
counts (verified: `tests/host/e2e.test.ts` references no `onDisplay`/
`DisplaySink`), so the stub-driven tests are unaffected.

### Sink / renderer seam — unchanged

`DisplayEventKind` stays `"text" | "tool_call" | "tool_result"`; the sink
still maps `kind: "text"` → `conduct.role.text` → the existing labeled
`Container` renderer (`src/extension/conduct-message-renderer.ts`).
**Each chunk renders as its own labeled block** — see Open concern 3.

### Grep guard preserved

`session-event-handler.ts` is in `src/host/` (the only directory the
grep-guard permits pi runtime imports). No change to `src/core`,
`src/seam`, `src/cost`, `src/persistence`, `src/manifest`, or the
extension renderer/sink. The single import the change needs
(`extractAssistantText`) is **already** imported there.

## Design — resolved

### Flush model: suffix-chunk, char-threshold, timer-free

Per session, a closure-scoped `streamedLen: number` tracks how many
characters of the **formatted** assistant text (the
`extractAssistantText` output) have already been forwarded to the sink.

- **`message_start`** → `streamedLen = 0` (defensive reset for a new
  assistant message; harmless for user-prompt `message_start`).
- **`message_update`** (any sub-event variant — text/thinking/toolcall):
  - `message = event.message as AssistantMessage`; if `message?.role !==
    "assistant"`, ignore (only assistant messages stream).
  - `formatted = extractAssistantText(message)`.
  - If `formatted.length - streamedLen >= STREAM_FLUSH_THRESHOLD_CHARS`:
    emit `onDisplay?.({ role, kind: "text", text: formatted.slice(streamedLen) })`
    and set `streamedLen = formatted.length`.
  - Otherwise accumulate (do nothing) — the tail will flush later or at
    `message_end`.
  - Toolcall-only `message_update`s grow no text, so `formatted.length`
    is unchanged → no spurious emit. (No sub-event narrowing needed.)
- **`message_end`** for an assistant message (after the existing
  `stopReason === "error"` early-return, which is preserved):
  - `text = extractAssistantText(message)`.
  - If `text.length > streamedLen`: emit
    `onDisplay?.({ role, kind: "text", text: text.slice(streamedLen) })`.
  - `streamedLen = 0` (ready for the next message).
  - The existing `usage` capture + cap-eval block is **untouched** and
    runs after.

### `STREAM_FLUSH_THRESHOLD_CHARS = 200`

200 characters per intermediate chunk (a terminal-row-fitting budget).
No wall-clock timer — the cadence is purely length-driven, which is
deterministic, side-effect-free, and unit-testable without fake timers
(the repo's tests are stub-driven and prefer purity). The final partial
turn (`message_end`) always flushes whatever tail remains regardless of
threshold, so no text is ever lost or held forever.

### Why not the alternatives (recorded so the choice is auditable)

- **Growing-snapshot flush** (emit the full accumulated text each flush):
  rejected — append-only `CustomMessage`s would produce visible growing
  duplicates; worse UX than suffix-chunks.
- **Per-delta flush** (every `text_delta` is its own message): rejected —
  floods the transcript with many sub-token blocks.
- **`pi.events` bridge + custom progressive TUI component** (Approach B
  from the investigation): rejected for v1 — ~80–120 lines + TUI
  component research; the user explicitly chose Approach A.
- **Wall-clock throttling (`setInterval` / time-based)**: deferred — adds
  timer lifecycle + cleanup per session and fake-timer test machinery for
  marginal UX gain over a char threshold. See Follow-ups.

## Edge cases

- **No `message_update` ever fires** (any pre-streaming call path, all
  existing tests): `streamedLen` stays `0`; `message_end` emits
  `text.slice(0)` === current behavior. Zero regression.
- **Message under threshold:** no intermediate emit; `message_end` emits
  the full text once (identical to today).
- **Message exactly at/over threshold then finishes:** one intermediate
  flush of the threshold, then `message_end` flushes only the tail past
  it. Concatenation === full formatted text.
- **Multi-block messages (text + thinking + text):** `extractAssistantText`
  interleaves them in content order with `"\n\n"` and blockquotes; the
  suffix slice preserves overall order — each chunk is a contiguous
  substring of the final formatted output.
- **Blockquote/thinking line splitting (v1 limitation):** the char slice
  may cut a `thinking` block mid-line, so a downstream chunk can start
  without its `> ` prefix and render as normal text for the remainder of
  that line. See Open concern 3 — flagged, line-snap refinement deferred.
- **Multiple assistant messages in one session (tool-call rounds):**
  `message_start` and the post-`message_end` reset both clear
  `streamedLen`, so each message flushes independently. The buffer is
  per-session (closure), like the existing `pending` tool buffer.
- **Abort mid-stream:** the SDK re-emits `message_end` with the final
  partial on abort (`agent-loop.js` `error` → `message_end`); the tail
  flush fires normally. Already-flushed chunks remain visible. If the
  final partial were ever shorter than `streamedLen` (not observed in the
  pinned contract), the `text.length > streamedLen` guard suppresses a
  bogus empty/negative slice.
- **Model error (`stopReason: "error"`):** preserves the existing
  early-return — the remainder is NOT flushed at `message_end`, matching
  today's silence-on-error. Any partial already flushed during the
  stream remains visible (informative, not a regression).
- **No display sink:** `onDisplay?.` optional-chaining unchanged — no
  sink means no flush, no throw.
- **Machine tools (`handoff`/`end`/`ask_user`):** unaffected — they
  route through `tool_execution_*`, never `message_update`; suppression
  from the prior spec stands.

## Scope — layer boundary

This is a **display-layer change only**. One source file touched:

- **`src/host/session-event-handler.ts`** — add the per-session
  `streamedLen` accumulator and the `message_start` / `message_update`
  branches; reframe the `message_end` text emit to the tail-flush. Add
  `export const STREAM_FLUSH_THRESHOLD_CHARS = 200;`. No new imports
  (`extractAssistantText` is already imported).

Tests touched:

- **`tests/host/display-forwarding.test.ts`** — add streaming cases
  (threshold flush, sub-threshold no-flush, tail remainder, multi-message
  reset, toolcall-message_update no-op, error-path preserves early-return).
  Existing `message_end`-only assertions stay byte-identical (no
  `message_update` emitted in those cases). One-source-file blast radius.

**Not changed (verified invariants intact):** `src/core/**`,
`src/seam/**`, `src/cost/**`, `src/persistence/**`, `src/manifest/**`,
`src/host/display-sink.ts`, `src/host/tool-summary.ts`,
`src/extension/**`, `extensions/**` — grep-guard stays green (no new pi
imports anywhere, and none ever in core). The durable per-role session
JSONL is untouched; the `message_end` usage/cap path is untouched.

## Spec impact (orchestrator-fsm-spec)

None. `docs/orchestrator-fsm-spec.md` has no section enumerating TUI
display rules — display behavior is owned by the Phase 7B UX shell specs.
§11 "Persistence and observability" covers the durable record JSONL,
which this change does not touch (the streaming path is observability
only; `message_end` still performs the sole usage capture and cap
evaluation, exactly as today).

## Open concerns (for the reviewer / user to confirm)

1. **Cadence is char-driven, not time-driven (top concern).** This plan
   flushes every **200 chars** rather than on a wall-clock interval.
   That is deterministic and timer-free (testable in the stub-driven
   suite), but on a fast model the chunks arrive in a burst regardless
   of wall clock and on a slow model a short message may stay unflushed
   until `message_end`. If true wall-clock progressive feel is required,
   add time-based throttling (follow-up) — note it brings per-session
   timer lifecycle + fake-timer test machinery.
2. **Per-chunk role-label repetition.** Each flush reuses `kind: "text"`
   → `conduct.role.text` → the existing labeled `Container` renderer, so
   a long message renders as ~N labeled blocks (one bold/yellow heading
   per ~200 chars). Informative but noisy. A label-less stream-chunk
   `kind` + customType + renderer variant removes it (~+30–40 lines,
   3 files). Deferred to a follow-up — confirm the repetition is
   acceptable for v1, or ask for the label-less variant now.
3. **Blockquote/`thinking` line-split (v1 imperfection).** A char slice
   can split a blockquoted `thinking` line, so a chunk may render the
   tail of that line as plain text. A line-boundary-snap refinement
   (advance `streamedLen` to the last `\n` within the window, deferring
   the partial line) avoids it but defeats streaming for long unbroken
   paragraphs (common for conduct role prose). Deferred — confirm the
   imperfection is acceptable for v1.
4. **No config flag.** Streaming is default-on with a fixed 200-char
   threshold; no env/runtime knob. A follow-up can expose
   `STREAM_FLUSH_THRESHOLD_CHARS` / an enable flag. Flagged, not a gap.

## Follow-ups (deferred, not Phase 1)

1. **Label-less stream-chunk variant** (concern 2): a `"text_stream"`
   `DisplayEventKind` + `conduct.role.text_stream` customType + a
   minimal renderer with no role-label `Text` child, so intermediate
   chunks do not repeat the heading.
2. **Wall-clock throttling** (concern 1): per-session timer that flushes
   at most once per ~120 ms even if the char threshold hasn't been
   crossed, for a smoother progressive feel on slow models.
3. **Line-boundary-snap slice** (concern 3): flush up to the last `\n`
   at or before `streamedLen + threshold` to keep `thinking` blockquotes
   intact (trade-off: latency for unbroken long paragraphs).
4. **Configurable threshold / enable flag** (concern 4): expose
   `STREAM_FLUSH_THRESHOLD_CHARS` and a streaming on/off switch via host
   config.