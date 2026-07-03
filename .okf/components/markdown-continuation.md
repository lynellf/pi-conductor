---
title: Markdown Continuation Normalizer
type: component
status: deprecated
source_files:
  - src/host/session-event-handler.ts
  - src/host/display-sink.ts
tags:
  - streaming
  - markdown
  - blockquote
  - display
updated_at: 2026-07-02
---
# Summary

**DEPRECATED.** This component (`normalizeContinuationChunk`, `detectQuotePrefix`)
was deleted in commit 6f962f2 (Phase 1 open-issues-round-2). The TUI switched
from progressive text streaming to single-emit per turn at `message_end`,
rendering the chunk normalizer unnecessary.

Archived for historical context. If progressive text streaming is re-introduced,
this component's approach should be re-evaluated.

---

# Summary (archived)

Pure display-text normalizer (`normalizeContinuationChunk`) that makes streamed
markdown chunks self-contained for blockquote rendering by prepending the
detected `> ` prefix when a chunk starts mid-line inside a blockquote.

# Durable knowledge (archived)

- The normalizer was a **pure function** — no I/O, no side effects, no module
  state. Deterministic and unit-testable in isolation.
- Normalization triggered when **all three** conditions were true:
  1. `sliceStart > 0` (not the first chunk).
  2. `sliceStart` was mid-line (not at a newline boundary).
  3. The logical line containing `sliceStart` began with a blockquote marker.
- When triggered, the normalizer prepended the detected quote prefix to the
  **first line fragment** only. Complete subsequent lines were left unchanged.
- `stream.len` was always based on the **original** formatted string, not the
  normalized display text.
- Deleted in commit 6f962f2 along with `boundary-flush.ts` and their test files.

# Evidence

- `src/host/markdown-continuation.ts` — deleted in commit 6f962f2.
- `src/host/boundary-flush.ts` — deleted in commit 6f962f2.
- `tests/host/markdown-continuation.test.ts` — deleted in commit 6f962f2.
- `tests/host/boundary-flush.test.ts` — deleted in commit 6f962f2.
- `tests/host/display-forwarding.test.ts` — streaming tests removed (reduced
  from ~640 lines).
- Commit `6f962f2` — full removal commit with message explaining the TUI
  single-emit redesign.

# Related

- `.okf/pitfalls/chunk-boundary-blockquote-loss.md` — the pitfall this component
  addressed (now deprecated, pitfall eliminated by streaming removal).
