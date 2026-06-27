# Phase 1: Markdown continuation context for streamed chunks

## Summary of what changed

Initial implementation task breakdown for fixing quote-block continuity in streamed `/conduct` output.

## Task 1 — Add failing regression coverage

**Files likely touched**

- `tests/host/display-forwarding.test.ts`
- Optional: `tests/host/markdown-continuation.test.ts`

**Work**

- Create a streaming fixture where `extractAssistantText()` produces a long single-line blockquote (`> ...`) and the flush boundary lands after the leading `> ` but before the line ends.
- Assert the first chunk is emitted as `kind: "text"` with the original `> ` marker.
- Assert the continuation chunk is emitted as `kind: "text_stream"` and its display text starts with the copied quote marker.
- Add a paired normal-text fixture proving unquoted continuations are not prefixed.

**Acceptance**

- [x] Test fails against current code because the continuation chunk begins with plain prose.
- [x] Test names the screenshot regression.
- [x] Test covers both quoted and unquoted continuations.

**Verify**

```bash
pnpm test -- tests/host/display-forwarding.test.ts
```

## Task 2 — Implement a pure quote-continuation normalizer

**Files likely touched**

- Preferred: new `src/host/markdown-continuation.ts`
- Alternative: `src/host/display-sink.ts` if the helper stays tiny and responsibility remains clear

**Work**

- Add a pure function that receives the full formatted markdown string, the slice start, and the slice end.
- Return the source slice unchanged unless it starts mid-line inside a line whose prefix is a markdown blockquote marker.
- When inside a quote line, prefix the emitted first line with the existing quote marker sequence (`> `, `> > `, etc.).
- Keep empty slices unchanged.
- Do not mutate or return new source offsets; the helper formats display text only.

**Acceptance**

- [x] Handles top-level blockquotes.
- [x] Handles nested quote markers.
- [x] Leaves non-quote continuations unchanged.
- [x] Keeps source offset accounting separate from display-normalized text.

**Verify**

```bash
pnpm test -- tests/host/markdown-continuation.test.ts
```

If no separate helper test file is created, cover these cases in `tests/host/display-forwarding.test.ts`.

## Task 3 — Wire the normalizer into streaming emission

**Files likely touched**

- `src/host/session-event-handler.ts`

**Work**

- For `message_update`, replace `formatted.slice(stream.len, boundaryPos)` display payload with the normalized display chunk.
- For `message_end` tail flush, normalize `text.slice(stream.len)` the same way when `stream.hasEmittedText` is true or when the tail starts inside a blockquote line.
- Keep `stream.len = boundaryPos` / reset behavior based on the original formatted string.
- Do not alter usage capture, cap evaluation, model-error early return, or tool-result handling.

**Acceptance**

- [x] Quoted `text_stream` chunks render with a quote marker.
- [x] Normal `text_stream` chunks render without a quote marker.
- [x] Concatenation tests that compare source text are updated to account for display-only marker insertion, not removed silently.
- [x] Cost/cap/model-error logic remains unaffected.

**Verify**

```bash
pnpm test -- tests/host/display-forwarding.test.ts tests/host/boundary-flush.test.ts
```

## Task 4 — Extension sanity check

**Files likely touched**

- Usually none.
- Optional: `tests/extension/conduct-message-renderer.test.ts` if adding a test that `Markdown("> continuation")` remains the body of a `text_stream` message.

**Work**

- Confirm `display-sink-wiring.ts` still forwards `text_stream` content unchanged to `conduct.role.text_stream`.
- Confirm the existing label-less renderer remains the desired renderer.

**Acceptance**

- [x] No repeated role labels are reintroduced.
- [x] No extension API contract change unless explicitly justified in code/tests.

**Verify**

```bash
pnpm test -- tests/extension/tui-bridge.test.ts tests/extension/conduct-message-renderer.test.ts
```

## Task 5 — Full verification and manual check

**Work**

- Run full repo gates.
- Manually verify the scenario in a live pi session or deterministic recorded TUI fixture.

**Acceptance**

- [x] The `docs/image.png` and `docs/Screenshot 2026-06-24 at 10.03.08 PM.png` failure mode no longer reproduces.
- [x] Tool summaries and normal assistant text are unchanged.
- [x] No core/FSM files are touched.

**Verify**

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm lint
pnpm format:check
```
