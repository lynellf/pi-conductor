# Plan — Phase 1: Progressive assistant-text streaming (suffix-chunk flush)

> **Revision 2 (PLAN-REVISED)** — plan-reviewer-a returned `APPROVE-WITH-NITS`
> (3 nits) and plan-reviewer-b returned `APPROVE-WITH-NITS` (10 nits); all
> 13 folded into this revision before hand-off back to plan-reviewer-a. This
> is a revision pass, not a re-plan — no task was added/removed/reordered
> (task 2's optional case 7 is an *optional* addition flagged in review nit
> b-N5, not a re-ordering).
>
> ### Reviewer nits folded (PLAN-REVISED)
>
> **plan-reviewer-a (3):**
> 1. **`STREAM_FLUSH_THRESHOLD_CHARS` export decision half-made (a-N1):** the
>    constant stays `export const` (the future config-flag follow-up reads
>    it), and Task 1 now adds a one-line comment in the code snippet stating
>    the export is an intentional test seam + config-flag hook. Acceptance
>    bullet updated.
> 2. **Task-1 "streamedLen closure" note internally inconsistent (a-N2):** the
>    diff note no longer trails both a bare `let` and the `{ len }` object;
>    Task 1 now shows the **updated `onSessionEvent` signature** carrying the
>    new `stream: StreamState` parameter (mirroring how `pending: Map<…>` is
>    shown), plus a tiny named `interface StreamState { len: number }`. The
>    scalar-`let` paragraph is dropped — the holder is the design.
> 3. **Open concern #2 (per-chunk role-label repetition) — explicit user
>    sign-off (a-Important / b-N9):** the plan now flags this as the **one
>    open question for the user at end-of-loop** (mirrored in the
>    plan-status block + the spec's Open concern 2). It is **not** scoped into
>    Phase 1; the label-less-stream-chunk variant stays in Follow-ups.
>
> **plan-reviewer-b (10):**
> - **N1 — "Move/duplicate" wording is wrong:** rewritten to "Add new
>   `message_start` / `message_update` branches" — there is nothing to move.
> - **N2 — "subscribes" wording is wrong:** the handler does not subscribe;
>   `onSessionEvent` IS the listener that `session.subscribe` invokes. Summary
>   + Task 1 reworded.
> - **N3 — LOC estimate rounds oddly:** now reads "currently 196; adds ~25
>   lines → ~221 LOC" (explicit arithmetic, no stray tilde on a computed sum).
> - **N4 — Cases 1 & 3 indistinct:** added a one-line "what **only** this case
>   pins" note to streaming cases 1 and 3 (and a gloss note on 2, 4, 5, 6
>   where helpful).
> - **N5 — Missing defensive test (undefined / non-assistant `message_update`):**
>   added streaming case 7 (**optional**; pins the optional-chain
>   `msg?.role === "assistant"` short-circuit). Marked optional — not a gate.
> - **N6 — `stream` holder inline type:** added `interface StreamState
>   { len: number }` for grep-parity with `pending: Map<string, string>`.
> - **N7 — "no new imports" vs new module export:** the top-of-file JSDoc note
>   + Task 1 acceptance now state explicitly that the change adds **one new
>   non-breaking `export const number`** to the module's surface (no new
>   imports, no new deps, no new types beyond the local `StreamState`).
> - **N8 — Harness supports `message_update`:** Task 2 now records the
>   passing fact that `makeSession().subscribe` forwards `listener?.(event)`
>   for whatever the test emits, so `message_update` flows through
>   unchanged.
> - **N9 — Concern 2 is the loudest one:** consolidated with reviewer-a nit 3
>   (see above) — single end-of-loop user sign-off question.
> - **N10 — `docs/orchestrator-fsm-spec.md` path is stale:** verified — the
>   file actually lives at `docs/archive/orchestrator-fsm-spec.md`.
>   Handled back to the orchestrator as a **repo-hygiene note** (AGENTS.md
>   and README still cite the un-archived path); it is **not** a plan-rejection
>   and does not change this plan's display-only impact claim.
>
> (Other review confirmations — unchanged: one source file + one test file;
>   grep-guard green; SDK contract re-verified; `extractAssistantText` purity;
>   the `stream: { len }` holder mirrors `pending`; no-regression for the
>   no-`message_update` path; error-path early-return preserved; LOC under the
>   ~400 ceiling.)
>
> Implements `docs/progressive-text-streaming/spec.md`.
> Sub-plan of the Phase 7B UX tool-observability lineage. Continues
> `docs/archive/tool-display-combine-status/`. **One source file + one
> test file** blast radius. No core / seam / cost / persistence /
> manifest / extension / renderer / sink changes.

## Summary

Surface an assistant message **progressively** as the model streams,
instead of one monolithic `conduct.role.text` block at `message_end`.
The shared `onSessionEvent` listener (invoked by `session.subscribe` for
every delivered event) responds to the SDK's existing `message_update`
events by recomputing `extractAssistantText(partial)` on each update and
emitting a `kind: "text"` chunk containing **only the new suffix**
(`formatted.slice(stream.len)`) every `STREAM_FLUSH_THRESHOLD_CHARS`
(200) characters. `message_end` is reframed from "emit the whole text"
to "emit the unflushed tail" (`text.slice(stream.len)`); when no
`message_update` ever fired, `stream.len` is `0` and `text.slice(0)` is
byte-identical to today. Append-only `CustomMessage`-safe (no growing
duplicates, no duplication), timer-free (deterministic, stub-testable),
single-source-file.

## Files to change

- **`src/host/session-event-handler.ts`** — add `export const
  STREAM_FLUSH_THRESHOLD_CHARS = 200;` (a non-breaking module export);
  add a local `interface StreamState { len: number }`; add a per-session
  `const stream: StreamState = { len: 0 }` holder in
  `attachSessionEventHandler` (mirroring how `pending` is threaded) and
  pass it as a new trailing `stream` parameter to `onSessionEvent`; add
  `message_start` (reset) and `message_update` (suffix flush) branches
  before the `message_end` guard; reframe the `message_end` assistant-text
  emit to the tail flush and reset `stream.len = 0` after. No new imports;
  one new non-breaking `export const` + one local `interface` (REV-2 nits
  a-N1, a-N2, b-N6, b-N7).
- **`tests/host/display-forwarding.test.ts`** — ADD streaming cases
  (see Task 2). Existing `message_end`-only assertions stay
  byte-identical (those sessions emit no `message_update`, so
  `stream.len` never moves and `message_end` emits `text.slice(0)`).

Unchanged (verified): `src/host/display-sink.ts` (`extractAssistantText`
reused as-is), `src/host/tool-summary.ts`, `src/extension/**`,
`extensions/**`, all core/seam/cost/persistence/manifest modules
(grep-guard stays green; no new pi imports anywhere).
`tests/host/e2e.test.ts` + `tests/extension/*` (e2e asserts persisted
records, not display counts; renderer tests render one `CustomMessage`
at a time so chunking is invisible to them).

## Tasks

### Task 1 — Host: per-session `streamedLen` + suffix-chunk flush

Edit `src/host/session-event-handler.ts`.

- Near the top of the module (after the imports, before
  `attachSessionEventHandler`), add:
  ```ts
  /**
   * Minimum number of NEW formatted assistant-text characters that must
   * accumulate before an intermediate streaming flush (spec:
   * progressive-text-streaming). Char-driven, not time-driven, so the
   * cadence is deterministic and unit-testable without fake timers. The
   * final `message_end` always flushes whatever tail remains regardless
   * of this threshold, so no text is ever held forever.
   *
   * Exported (rather than module-private) deliberately: it is the test
   * seam for `tests/host/display-forwarding.test.ts` (so fixtures derive
   * the threshold instead of hardcoding 200) and the hook for the
   * future config-flag follow-up (spec Open concern 4) that will expose
   * it via host config. No runtime/public-API surface beyond this one
   * `export const number` — a non-breaking addition to the module.
   */
  export const STREAM_FLUSH_THRESHOLD_CHARS = 200;
  ```
- Add a tiny named holder type next to the constants (b-N6 — grep-parity
  with the `pending: Map<string, string>` parameter; clearer than an
  inline `{ len: number }` object literal):
  ```ts
  /**
   * Per-session mutable holder for the count of formatted assistant-text
   * characters already flushed during the in-flight message (spec:
   * progressive-text-streaming). Passed by reference into `onSessionEvent`
   * and mutated in place, mirroring how `pending` is threaded.
   */
  interface StreamState {
    len: number;
  }
  ```
- In `attachSessionEventHandler`, add the holder next to `pending` and
  thread it into the `session.subscribe` call (the `onSessionEvent`
  signature gains a trailing `stream: StreamState` parameter — see the
  signature block below):
  ```ts
  const pending = new Map<string, string>();
  // Per-session streamed-len holder. Reset on message_start and after
  // message_end. Same scoping rationale as `pending`: each role
  // session gets its own onSessionEvent via attachSessionEventHandler.
  const stream: StreamState = { len: 0 };
  // …
  args.session.subscribe((event) =>
    onSessionEvent(args.session, args.state, args.role, args.onDisplay,
                   event, pending, stream),
  );
  ```
  **Signature change (review nit a-N2):** the updated free-function
  signature — new trailing parameter mirrors the existing `pending`:
  ```ts
  function onSessionEvent(
    session: AgentSession,
    state: SessionState,
    role: Role,
    onDisplay: DisplaySink | undefined,
    event: AgentSessionEvent,
    pending: Map<string, string>,
    stream: StreamState,   // REV-2: per-session streamed-len holder
  ): void
  ```
  Access `stream.len` / mutate `stream.len`. This keeps the existing
  "pass the mutable object" pattern (`pending` is already passed the
  same way) — `onSessionEvent` is a free function, not a closure, so a
  bare `let` cannot be captured; the holder is the design (b-N6), not a
  workaround. No closure-via-function restructuring needed.
- **Add** new `message_start` and `message_update` branches BEFORE the
  existing `if (event.type !== "message_end") return;` guard (so they
  run instead of being dropped) — there is nothing to move/duplicate;
  these are new branches (review nit b-N1):
  - `message_start`: `stream.len = 0; return;` (defensive reset; harmless
    for user-prompt `message_start`).
  - `message_update`:
    ```ts
    if (event.type === "message_update") {
      const msg = event.message as AssistantMessage;
      if (msg?.role === "assistant") {
        const formatted = extractAssistantText(msg);
        if (formatted.length - stream.len >= STREAM_FLUSH_THRESHOLD_CHARS) {
          onDisplay?.({ role, kind: "text", text: formatted.slice(stream.len) });
          stream.len = formatted.length;
        }
      }
      return;
    }
    ```
    The `msg?.role === "assistant"` optional-chain short-circuits on an
    undefined/non-assistant `message` — defensive test case 7 pins it.
- Reframe the `message_end` assistant-text emit. Replace the current block
  ```ts
  if (message?.role === "assistant") {
    const text = extractAssistantText(message);
    if (text.length > 0) {
      onDisplay?.({ role, kind: "text", text });
    }
  }
  ```
  with the tail-flush + reset:
  ```ts
  if (message?.role === "assistant") {
    const text = extractAssistantText(message);
    if (text.length > stream.len) {
      onDisplay?.({ role, kind: "text", text: text.slice(stream.len) });
    }
    stream.len = 0;
  }
  ```
  Keep this AFTER the existing `stopReason === "error"` early-return
  (so the error path still skips the remainder, unchanged). Keep the
  `usage` capture + cap-eval block exactly as-is; it runs after.
- Update the top-of-file module JSDoc with a bullet noting the streaming
  tap (`message_update` → suffix-chunk flush) and pointing at the spec,
  so the module's behavior contract stays accurate. Add a one-line note
  (review nit b-N7) that the change introduces **one new non-breaking
  `export const number`** (`STREAM_FLUSH_THRESHOLD_CHARS`) plus a local
  `interface StreamState` — no new imports, no new dependencies, no new
  exported types — so the module's public-surface growth is explicit.

**Acceptance:** `message_update` flushes a text suffix once per ≥200 new
formatted chars; `message_end` flushes only the unflushed tail; with no
prior `message_update`, `message_end` emits the full text (byte-identical
to today); the `usage`/cap path is untouched; the error path is
untouched; module adds exactly one new non-breaking `export const` and a
local `StreamState` interface (no new imports, no new deps, no exported
types); file stays under the ~400 LOC ceiling (currently 196; adds ~25
lines → ~221 LOC).

**Verification:** `pnpm typecheck`; `pnpm test -- tests/host/display-forwarding.test.ts`.

### Task 2 — Tests: streaming cases in `display-forwarding.test.ts`

Edit `tests/host/display-forwarding.test.ts`.

- **Keep every existing assertion unchanged.** They emit no
  `message_update`, so `stream.len` stays `0` and `message_end` emits
  `text.slice(0)` === the existing expected text. Before finalizing,
  re-run them to confirm green against the reframed `message_end`.
- Import `STREAM_FLUSH_THRESHOLD_CHARS` from the handler module for the
  threshold-based fixtures (do not hardcode 200).
- **Harness note (review nit b-N8):** the existing `makeSession()` helper
  wires `subscribe: (fn) => { listener = fn }` and exposes `emit(event)` →
  `listener?.(event)`, forwarding **whatever** the test passes — including
  `message_start` and `message_update` events — into the
  `attachSessionEventHandler` listener unchanged. So the streaming cases
  emit new event types through the same forwarder the existing cases use;
  no harness change is needed.
- ADD a `Streaming` section within the existing `describe(...)`. Each case
  carries a one-line **"what only this case pins"** note (review nit b-N4) so
  the case distinctions are explicit:
  1. **"streams accumulated text in a threshold suffix chunk then a tail
     at message_end"** — `emit` `message_start` (assistant partial), then
     ≥2 `message_update` events whose partial snapshots grow the
     formatted text PAST the threshold (e.g. append text until
     `formatted.length - 0 >= threshold`), then a `message_end` with a
     slightly longer final text. Assert:
     - the first `message_update` past the threshold produced one
       `onDisplay` call with `kind: "text"` and
       `text === formattedPartial.slice(0)` (the suffix since `stream.len`
       was `0`).
     - the `message_end` produced one `onDisplay` call with
       `text === finalText.slice(formattedPartial.length)` (the tail).
     - Total `onDisplay` calls for the sequence = 2 (one chunk + one
       tail), and concatenation `chunk + tail === finalText`.
     *What only this case pins:* the **chunk-then-tail boundary** — that
     `message_end` emits the slice *after* the last-flushed length, not
     the whole text (the new `message_end` invariant).
  2. **"message_update below the threshold emits nothing mid-stream;
     full text emits once at message_end"** — `message_start` + one
     `message_update` whose partial is SHORTER than the threshold + a
     `message_end` carrying the same short text. Assert `onDisplay` called
     exactly once, at `message_end`, with `text === finalText.slice(0)`
     (i.e. the full text). Confirms the threshold gate and the no-flush
     → full-tail equivalence to the legacy path.
     *What only this case pins:* the **sub-threshold no-flush fallback** —
     that a sub-threshold partial produces zero intermediate emits, and the
     new `message_end` tail (`slice(0)`) is byte-identical to the legacy
     whole-text emit. This is the no-regression proof for the pre-streaming
     path inside the new streaming suite.
  3. **"flushes exactly the new suffix on each threshold crossing"** —
     two sequential threshold crossings within one message: emit
     `message_start`, then `message_update` A (crosses threshold → flush
     `fa.slice(0)`), then `message_update` B (partial grows past a SECOND
     threshold → flush `fb.slice(fa.length)`), then `message_end` (tail
     `final.slice(fb.length)`). Assert three `text` emits whose
     concatenation === `finalText`; the middle one starts exactly where
     the first ended.
     *What only this case pins:* **multi-chunk continuity** — that
     consecutive chunks each emit *exactly the new suffix* and never
     re-flush the prefix (case 1 only crosses once, so it cannot prove the
     `stream.len` advances across two `message_update`s).
  4. **"resets the accumulator across consecutive messages"** — emit a
     complete streamed message (start + crossed-threshold update + end),
     then a SECOND `message_start` + short `message_end` (no update).
     Assert the second message emits its full text via
     `final2.slice(0)` (not `final2.slice(lenFromMessage1)`), proving the
     `message_end` reset (and `message_start` reset) works.
     *What only this case pins:* the **per-message reset** — neither case 1
     nor 3 spans two messages, so neither can detect a stale `stream.len`
     leaking from one turn into the next.
  5. **"toolcall message_updates with no text growth emit nothing"** —
     emit `message_start`, then a `message_update` whose partial contains
     a `toolcall_*`-grown message (same text as the start partial, i.e.
     no new text), then `message_end`. Assert `onDisplay` called exactly
     once, at `message_end`, with the full text (the `message_update`
     contributes `formatted.length - 0` new chars = below threshold → no
     emit; the `message_end` tail = full text).
     *What only this case pins:* that a **tool-call-only `message_update`
     (no text) does NOT trip a spurious flush** — the suffix-length guard
     is computed on `extractAssistantText` output, not on event presence.
  6. **"error message_end does not flush the remainder (early-return
     preserved)"** — emit `message_start` + a threshold-crossing
     `message_update` (flushes one chunk) + a `message_end` carrying
     `stopReason: "error"`. Assert `onDisplay` called exactly ONCE (the
     streamed chunk only); the `message_end` remainder is NOT emitted.
     Confirms the error path still skips the tail while leaving the
     already-streamed partial visible.
     *What only this case pins:* the **error-path early-return runs
     before the new tail-flush** — the reframed `message_end` text block
     stays positioned after the `stopReason === "error"` early-return.
  7. **(optional, review nit b-N5)** **"`message_update` with an
     undefined / non-assistant `message` emits nothing mid-stream"** —
     emit `message_start`, then a `message_update` carrying either
     `{ message: undefined }` or `{ message: { role: "user" } }`, then a
     `message_end` with the real text. Assert `onDisplay` called exactly
     once, at `message_end`, with the full text. Pins the
     `msg?.role === "assistant"` optional-chain short-circuit so a future
     refactor can't silently drop it. **Optional, not a gate** — TS strict
     mode + the `as AssistantMessage` cast already exercise the path; this
     case is a cheap regression guard, included if time permits.
- Use the existing `makeSession()` / `SessionState` / `attachSessionEventHandler` harness fixtures. Build partial-snapshot `AssistantMessage`s by
  shallow-cloning a base message and replacing `content` (an array with a
  single growing `text` part is sufficient for the threshold cases; for
  case 5 use a content array containing a tool-call part plus the text
  part). Keep snapshots realistic but minimal.

**Acceptance:** the six required new cases pass (case 7 optional); the
existing assertions remain green unchanged; one assertion per case; each
case names the behavior.

**Verification:** `pnpm test -- tests/host/display-forwarding.test.ts`.

### Task 3 — Full gate + manual visual check

- Run the repo's standard gates:
  - `pnpm typecheck` — strict + `noUncheckedIndexedAccess`.
  - `pnpm build` — emits `dist/` with `.d.ts`.
  - `pnpm test` — incl. `tests/grep-guard.test.ts` (must stay green; the
    one source file changed is already in `src/host/`, and no new pi
    imports are added).
  - `pnpm lint` (`biome check .`).
  - `pnpm format:check`.
- Module-size check: `src/host/session-event-handler.ts` stays under the
  ~400 LOC ceiling (was 196; adds ~25 → ~221).
- **Manual / visual check:** run `/conduct` against a small task that
  elicits a long-ish orchestrator/worker response (a few hundred
  characters of prose). Confirm the assistant text now appears
  **progressively** in ~200-char `conduct.role.text` chunks as the model
  streams, with a final tail at the end, and the total visible text
  concatenates to the full message. Confirm the global status-line
  spinner ("● running") still shows during the stream. Record the result
  in the plan-status block below.
- **Tick checkboxes in the same commit:** per AGENTS.md, tick `[x]` in the
  plan-status block below for every acceptance/verification step actually
  performed, in the same commit that implements it. Do not tick a box
  for work not done.

### Plan-status block (tick as applied)

```text
[x] Task 1 — stream holder + StreamState + message_start/message_update branches + message_end tail flush
[x] Task 2 — streaming cases in display-forwarding.test.ts (cases 1–6 required; 7 optional)
[ ] Task 3 — full gates + manual visual check — **gates passed, manual check deferred** (requires running `/conduct` against a real TUI; the user-visible change is per-chunk role-label repetition which is flagged as the end-of-loop sign-off question)
```

> **One open question for the user at end-of-loop** (Open concern 2):
> the per-chunk role-label repetition is shipping as-is for v1. Confirm
> it's acceptable, or request the label-less stream-chunk variant as
> Phase 2. This is the only item blocking final end-of-loop sign-off.

## Open concerns (for the reviewer / user to confirm — mirror of spec)

1. **Char-driven cadence, not time-driven.** 200 chars/flush, no wall-clock
   timer. Smoother progressive feel on slow models needs a follow-up
   timer (considered, deferred). Reviewer to confirm acceptable for v1.
2. **Per-chunk role-label repetition — 🔴 ONE OPEN QUESTION FOR THE USER**
   (consolidated reviewer-a Important + reviewer-b N9 — this is the
   loudest user-visible concern). Each chunk reuses `kind: "text"` → the
   labeled `conduct.role.text` renderer, so a long message (e.g. a 2000-char
   orchestrator turn) renders as ~N labeled `conduct.role.text` blocks,
   each with its own bold/yellow role heading. The user already chose
   Approach A (suffix-chunk flush) over a custom progressive TUI component,
   so they have implicitly accepted *some* UX compromise; but the
   label-less-stream-chunk variant is ~+30–40 lines across 3 files
   (renderer + sink customType + test) and is a clean follow-up.
   **Phase 1 ships the labeled repetition as-is.** This concern is flagged
   for the user at the **end-of-loop review** — confirm the repetition is
   acceptable for v1, or request the label-less variant as Phase 2. It is
   explicitly **not** scoped into Phase 1.
3. **Blockquote/`thinking` line-split (v1 imperfection).** A char slice
   may split a blockquoted thinking line; the tail of that line renders
   as plain text in the next chunk. Line-snap refinement deferred (it
   would stall streaming for long unbroken prose — the common case).
4. **No config flag.** Streaming default-on; fixed 200-char threshold;
   no env/runtime knob (follow-up).
5. **Repo-hygiene drift (review nit b-N10, NOT a plan item).** The
   streaming spec and AGENTS.md / README cite `docs/orchestrator-fsm-spec.md`,
   but the file actually lives at `docs/archive/orchestrator-fsm-spec.md`
   (verified). This does not change this plan's display-only impact claim
   (the spec correctly states the change touches no FSM section) — it is a
   stale-path reference. Handed back to the orchestrator as a repo-hygiene
   note for a separate fix; **not** a Phase 1 task.

## How reviewer concerns will be addressed (template)

When plan-reviewer-a/b feedback arrives, fold addressable nits into a
PLAN-REVISED pass here (mirroring the `tool-display-combine-status`
Revision 2 history), explicitly listing how each concern was addressed or
why it was rejected. Do not reorder/add/remove tasks without recording
it. Lead the return `reason` with `PLAN-REVISED`.

**Revision 2 (this pass)** folded all 13 nits (reviewer-a 3 + reviewer-b
10) — see the `Reviewer nits folded (PLAN-REVISED)` block at the top.
No task was reordered, added, or removed; the only structural addition is
the **optional** streaming case 7 (marked optional, not a gate). The one
question left open for the human is Open concern 2 (role-label
repetition) — surfaced for end-of-loop sign-off, not scoped into Phase 1.

## Verification block (repo gates)

```bash
pnpm typecheck   # strict + noUncheckedIndexedAccess
pnpm build       # emit dist/ with .d.ts
pnpm test        # incl. grep-guard (no pi imports in core)
pnpm lint        # biome check .
pnpm format:check
# manual:
/conduct <small task eliciting a multi-hundred-char prose response>
```

## Summary-of-changes (mirror, ticked at review)

- One source file (`src/host/session-event-handler.ts`) + one test file
  (`tests/host/display-forwarding.test.ts`).
- `STREAM_FLUSH_THRESHOLD_CHARS = 200` (non-breaking export, deliberate
  test seam + config-flag hook); local `interface StreamState`; per-session
  `const stream: StreamState = { len: 0 }` holder threaded into
  `onSessionEvent` (mirrors `pending`); `message_start` reset;
  `message_update` suffix flush; `message_end` reframed to tail flush +
  `stream.len = 0` reset.
- Zero regression for the no-`message_update` path (`stream.len` stays 0;
  `text.slice(0)` === today). Durable JSONL + cost/cap path untouched.
- REV-2: 13 reviewer nits folded — wording ("Move/duplicate" → "Add new",
  "subscribes" → "listener responds"), LOC arithmetic (196 + ~25 → ~221),
  named `StreamState`, explicit non-breaking-export call-out, harness note,
  per-case "what only this pins" notes, optional case 7, repo-hygiene
  spec-path note for the orchestrator, and the one end-of-loop user
  sign-off on Open concern 2 (per-chunk role-label repetition).