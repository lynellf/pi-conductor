# Spec: Quote-block continuity in streamed `/conduct` output

## What I found

- User complaint: “See how text can start within quote blocks and then finish outside of them? Is it possible to fix this? It's jarring to see.”
- `docs/image.png` shows planner reasoning beginning inside a gray markdown quote block (`I need to take a closer look... Perhaps I should check relevant`) and then continuing outside the quote block (`documents or screenshots...`). The sentence is visually split even though it is one model-thinking block.
- `docs/Screenshot 2026-06-24 at 10.03.08 PM.png` shows the same defect for `ui-reviewer`: quoted reasoning starts as `Now let me also do one quick test – navigate around with keyboard for` and the continuation `accessibility, and check...` renders as normal body text outside the quote.
- The current code already fixed the older repeated-role-label issue by adding `text_stream`, but the quote context still drops at chunk boundaries.
- The root cause is in the display streaming seam, not the FSM core: blockquote markers are emitted only at source line starts, while streamed chunks are rendered as independent markdown messages.

## Objective

Make streamed continuation chunks preserve markdown quote-block context when a chunk starts in the middle of an already-open blockquoted logical line. The visible TUI output should not show a sentence begin inside a quote block and continue outside it.

## Scope

In scope:

- Display-only role output for `/conduct` role sessions.
- Host streaming chunk selection / chunk text normalization.
- Extension rendering/sink tests only as needed to prove independent markdown chunks still receive self-contained quote markers.

Out of scope:

- Core FSM, reducer, manifest, seam, persistence, and cost semantics.
- Durable per-role session JSONL content.
- New color, border, spacing, or layout treatment for quote blocks.
- Replacing pi’s markdown renderer.

## Root cause

1. `extractAssistantText()` converts non-redacted thinking blocks into markdown blockquotes by prefixing each original thinking line with `> ` (`src/host/display-sink.ts:62-89`). This works only when the markdown parser sees the start of that logical line.
2. Streaming then slices the fully formatted string into suffix chunks: `formatted.slice(stream.len, boundaryPos)` on `message_update` and `text.slice(stream.len)` on `message_end` (`src/host/session-event-handler.ts:220-237`, `src/host/session-event-handler.ts:256-267`). If `stream.len` lands after the line-start `> ` marker but before the line ends, the continuation chunk begins with ordinary prose.
3. The extension maps each `text_stream` event to a separate append-only `conduct.role.text_stream` custom message (`src/extension/display-sink-wiring.ts:80-100`). The `text_stream` renderer then creates a fresh `Markdown(bodyText, ...)` instance for that chunk (`src/extension/conduct-message-renderer.ts:310-329`). Markdown block state therefore cannot carry over from the previous chunk.
4. The archived progressive-streaming spec already named this exact limitation: “a downstream chunk can start without its `> ` prefix and render as normal text” (`docs/archive/progressive-text-streaming/spec.md:198-201`).

## Fix design

Add a small pure display helper that makes each streamed suffix chunk self-contained for markdown blockquote rendering.

### New emission rule

When emitting any streamed text chunk:

- Keep `stream.len` and `findFlushBoundary()` behavior for deciding source slice boundaries.
- Before forwarding the slice to the display sink, normalize the display text:
  - If the slice starts at the beginning of the formatted string or at the start of a logical line, emit it unchanged.
  - If the slice starts mid-line and that logical line starts with a markdown blockquote marker (`>` after optional leading spaces), prefix the emitted chunk’s first line with `> ` so the independent markdown renderer treats the continuation as quoted.
  - Do not prefix normal text chunks.
  - Do not mutate `stream.len`; it must continue to count characters in the original formatted string, not the display-normalized string.

This intentionally makes display chunks self-contained markdown fragments while keeping source accounting stable.

### Edge cases

- Empty chunks: emit nothing, as today.
- Empty quoted lines: `>` / `> ` lines remain quoted; mid-line continuations still get a `> ` prefix.
- Nested blockquotes: preserve the current line’s quote depth when practical by copying the existing line’s leading quote marker sequence (for example `> > `) instead of always forcing a single `> `.
- Very long quoted line with no newline: chunk periodically as today, but every continuation chunk remains visibly inside the quote.
- Code fences inside quotes: do not attempt a full markdown parser in the first fix. At minimum, quoted code-fence continuations must keep the quote marker. If tests show code-block styling is lost across chunks, document that as a follow-up rather than broadening the fix into a renderer replacement.
- Unquoted code fences: unchanged; this bug is quote-block continuity, not general markdown-state streaming.

## UI design call

`ui-designer` input is not needed. The intended visual treatment already exists: use the same markdown blockquote style; only preserve it across streamed custom-message boundaries. No new spacing, color, border, responsive layout, or user flow decision is introduced.

## Success criteria

- The screenshot failure mode no longer occurs: quote-block text does not start inside a quote and finish outside solely because of streaming chunk boundaries.
- Continuation chunks that start inside blockquoted thinking render as blockquoted markdown.
- Continuation chunks that start in normal text remain normal text.
- Existing `text_stream` label-less behavior remains unchanged.
- Core FSM and durable record behavior are untouched.
- Focused unit tests fail before the fix and pass after it.

## Commands

```bash
pnpm test -- tests/host/display-forwarding.test.ts tests/host/boundary-flush.test.ts tests/extension/tui-bridge.test.ts tests/extension/conduct-message-renderer.test.ts
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
```

## Boundaries

- Always: keep the fix in the display/host/extension seam; add regression tests first.
- Ask first: replacing pi markdown rendering or adding a new TUI component.
- Never: touch `src/core`, `src/manifest`, `src/seam`, `src/cost`, or `src/persistence` for this bug.

## Open questions

None blocking. The only deliberate limitation is full code-fence state preservation across chunks; quote-marker continuity is the required fix.
