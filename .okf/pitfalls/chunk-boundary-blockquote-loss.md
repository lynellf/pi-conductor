---
title: Chunk-Boundary Blockquote Loss in Streamed Markdown
type: pitfall
status: deprecated
source_files:
  - src/host/display-sink.ts
  - src/host/session-event-handler.ts
tags:
  - streaming
  - markdown
  - blockquote
  - rendering
updated_at: 2026-07-02
---
# Summary

**DEPRECATED.** The streaming approach that caused this pitfall was removed in
commit 6f962f2 (Phase 1 open-issues-round-2). Text now emits as a single
`"text"` event per assistant turn at `message_end`, eliminating the
chunk-boundary blockquote loss. The fix component
(`src/host/markdown-continuation.ts`) was also deleted.

Archived for historical context — if progressive text streaming is
re-introduced, this pitfall and its documented fix approach will need to be
re-evaluated against the new streaming architecture.

---

# Summary (archived)

When streaming markdown chunks to a TUI, lines beginning with `> ` (blockquote
marker) lose their prefix when a chunk boundary falls mid-line. The independent
Markdown renderer for each chunk then renders the continuation fragment outside
the quote block, producing a visual quote-break.

# Durable knowledge (archived)

- **Root cause**: `extractAssistantText()` added `> ` only at original thinking
  line starts (`src/host/display-sink.ts:62-89`). Streaming then sliced the
  formatted string mid-line (`formatted.slice(stream.len, boundaryPos)`), so the
  continuation chunk began with plain prose. Each chunk was rendered by a fresh
  Markdown instance, which had no prior quote context.
- **Former fix approach**: normalize continuation chunks via
  `normalizeContinuationChunk` to prepend the detected quote prefix before the
  chunk reached the Markdown renderer. The source-position invariant
  (`stream.len`) was preserved against the original formatted string.
- **Removed in**: commit 6f962f2 (2026-07-02, Phase 1 open-issues-round-2).
  The TUI switched from progressive streaming to single-emit per turn,
  making this fix unnecessary.
- **Nested quotes**: the former prefix detection preserved nesting depth
  (`> > text` rather than always prepending a single `> `).
- **Known limitation (never resolved)**: full code-fence state preservation
  across chunks was not handled. Now moot since streaming was removed.

# Evidence

- Commit `f3d8575` implemented the original fix (normalizer + two call sites).
- Commit `6f962f2` removed the streaming approach entirely (deleted
  `boundary-flush.ts`, `markdown-continuation.ts`, their tests, and
  all streaming test coverage in `display-forwarding.test.ts`).
- Screenshots in `docs/archive/quote-block-rendering-fix/spec.md` show the visual
  defect that no longer applies.
- `tests/host/markdown-continuation.test.ts` deleted in commit 6f962f2.
- `tests/host/display-forwarding.test.ts` reduced from ~640 lines to ~13K
  (streaming tests removed).

# Related

- `.okf/components/markdown-continuation.md` — the component that fixed this
  pitfall (now deprecated, component deleted in commit 6f962f2).
