---
title: Markdown Continuation Normalizer
type: component
status: active
source_files:
  - src/host/markdown-continuation.ts
  - src/host/session-event-handler.ts
tags:
  - streaming
  - markdown
  - blockquote
  - display
updated_at: 2026-06-26
---
# Summary

Pure display-text normalizer (`normalizeContinuationChunk`) that makes streamed
markdown chunks self-contained for blockquote rendering by prepending the
detected `> ` prefix when a chunk starts mid-line inside a blockquote.

# Durable knowledge

- The normalizer is a **pure function** — no I/O, no side effects, no module
  state. Deterministic and unit-testable in isolation.
- Normalization triggers when **all three** conditions are true:
  1. `sliceStart > 0` (not the first chunk).
  2. `sliceStart` is mid-line (not at a newline boundary).
  3. The logical line containing `sliceStart` begins with a blockquote marker
     (`> `, `> > `, etc.).
- When triggered, the normalizer prepends the detected quote prefix to the
  **first line fragment** only. Complete subsequent lines are left unchanged
  (they already carry the correct prefix from the formatted source).
- `stream.len` is always based on the **original** formatted string, not the
  normalized display text. Callers must not use the return length for
  source-position accounting.
- Two call sites in `session-event-handler.ts`: `message_update` (boundary-flush
  path) and `message_end` (tail-flush path).
- `detectQuotePrefix` handles simple blockquotes (`> text`) and nested
  blockquotes (`> > text`, `> > > text`) with optional single spaces between
  markers. Does **not** handle indented blockquotes (leading whitespace) or
  continuation markers.

# Evidence

- `src/host/markdown-continuation.ts` — full implementation (`detectQuotePrefix`
  lines 48–87, `normalizeContinuationChunk` lines 104–147).
- `src/host/session-event-handler.ts` lines 219–233 (message_update call site)
  and lines 262–264 (message_end call site) — both call
  `normalizeContinuationChunk` before passing text to `onDisplay`.
- Commit `f3d8575` adds 19 unit tests + 2 integration test files.
- `tests/host/markdown-continuation.test.ts` — 11 unit tests covering simple,
  nested, multi-line, and edge cases.

# Related

- `.okf/pitfalls/chunk-boundary-blockquote-loss.md` — the pitfall this
  component addresses.
