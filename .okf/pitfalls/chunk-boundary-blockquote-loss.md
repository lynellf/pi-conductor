---
title: Chunk-Boundary Blockquote Loss in Streamed Markdown
type: pitfall
status: active
source_files:
  - src/host/markdown-continuation.ts
  - src/host/session-event-handler.ts
  - src/host/display-sink.ts
tags:
  - streaming
  - markdown
  - blockquote
  - rendering
updated_at: 2026-06-26
---
# Summary

When streaming markdown chunks to a TUI, lines beginning with `> ` (blockquote
marker) lose their prefix when a chunk boundary falls mid-line. The independent
Markdown renderer for each chunk then renders the continuation fragment outside
the quote block, producing a visual quote-break.

# Durable knowledge

- **Root cause**: `extractAssistantText()` adds `> ` only at original thinking
  line starts (`src/host/display-sink.ts:62-89`). Streaming then slices the
  formatted string mid-line (`formatted.slice(stream.len, boundaryPos)`), so the
  continuation chunk begins with plain prose. Each chunk is rendered by a fresh
  Markdown instance, which has no prior quote context.
- **Fix approach**: normalize continuation chunks via
  `normalizeContinuationChunk` to prepend the detected quote prefix before the
  chunk reaches the Markdown renderer. The source-position invariant
  (`stream.len`) is preserved against the original formatted string.
- **Required discipline**: any future code that produces streamed markdown
  chunks from a formatted source string must either (a) use
  `normalizeContinuationChunk`, or (b) implement equivalent cross-chunk state
  tracking for blockquote context. Skipping this step will reintroduce the
  visual quote-break.
- **Nested quotes**: the prefix must preserve nesting depth (`> > text` rather
  than always prepending a single `> `).
- **Known limitation**: full code-fence state preservation across chunks is not
  handled. Quote-marker continuity only. Documented as a follow-up in
  `docs/archive/quote-block-rendering-fix/spec.md`.
- **Early spec acknowledgment**: the archived progressive-streaming spec
  predicted this exact limitation: "a downstream chunk can start without its `> `
  prefix and render as normal text"
  (`docs/archive/progressive-text-streaming/spec.md:198-201`).

# Evidence

- Commit `f3d8575` implements the fix (the normalizer plus two call sites).
- Screenshots in the plan archive
  (`docs/archive/quote-block-rendering-fix/spec.md`) show the visual defect:
  planner thinking starts inside a quote block and continues outside it.
- `tests/host/markdown-continuation.test.ts` — 11 unit tests that fail without
  the fix and pass with it.
- `tests/host/display-forwarding.test.ts` — integration tests through the full
  streaming event pipeline include a test named "preserves blockquote marker on
  continuation chunks when flush boundary splits a blockquoted line."

# Related

- `.okf/components/markdown-continuation.md` — the component that fixes this
  pitfall.
