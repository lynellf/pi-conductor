# Implementation Plan: Quote-block rendering fix

## Summary of what changed

Initial plan for the reported quote-block streaming bug. It narrows the fix to display-only markdown continuation context, cites the two screenshots, and avoids changing the FSM core.

## Bug description

User complaint: “See how text can start within quote blocks and then finish outside of them? Is it possible to fix this? It's jarring to see.”

Evidence:

- `docs/image.png` — planner thinking begins in a quote block and continues outside it at `documents or screenshots...`.
- `docs/Screenshot 2026-06-24 at 10.03.08 PM.png` — `ui-reviewer` thinking begins in a quote block and continues outside it at `accessibility, and check...`.

## Root cause summary

`extractAssistantText()` adds `> ` only at original thinking line starts (`src/host/display-sink.ts:62-89`). Streaming slices the formatted markdown mid-line (`src/host/session-event-handler.ts:220-237`, `:256-267`). Each slice is rendered as an independent `Markdown` component via `conduct.role.text_stream` (`src/extension/display-sink-wiring.ts:80-100`, `src/extension/conduct-message-renderer.ts:310-329`), so the markdown parser has no prior quote context.

## Plan status

- [x] Investigated screenshots and characterized the visual defect.
- [x] Located the streaming/display rendering seam.
- [x] Identified root cause with file/line citations.
- [x] Decided `ui-designer` is not needed because no visual treatment changes.
- [x] Implement quote-context normalization for streamed chunks.
- [x] Add regression tests for quoted continuation chunks.
- [x] Run focused and full verification gates.
- [ ] Manually verify in a pi `/conduct` session or recorded TUI fixture.

## Phase summary

- [x] Phase 1 — `phase-1-markdown-continuation-context.md`: add a pure markdown-context chunk normalizer, wire it into host display streaming, and verify the screenshot regression.

## Files likely touched

- `src/host/session-event-handler.ts` — apply the display-normalized chunk text before `onDisplay?.(...)`.
- `src/host/display-sink.ts` or new `src/host/markdown-continuation.ts` — pure helper for quote-context detection/prefixing. Prefer a new small module if adding the helper would blur `display-sink.ts`’s extractor responsibility.
- `tests/host/display-forwarding.test.ts` — regression tests through the real streaming event path.
- `tests/host/markdown-continuation.test.ts` or `tests/host/boundary-flush.test.ts` — pure helper tests if the helper is split.
- Optional: `tests/extension/tui-bridge.test.ts` only if the event/detail contract changes. Preferred design avoids changing it.

## UI-designer decision

No `ui-designer` step is needed. The fix preserves the existing markdown blockquote style and only ensures each append-only streamed custom message has enough markdown syntax to render the same visual state as the original text.

## Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Added `> ` changes displayed raw text if markdown rendering falls back. | Low | Restrict prefixing to `text_stream` display chunks that start mid-line inside an existing blockquote. |
| `stream.len` accounting drifts if normalized text is counted. | Medium | Keep `stream.len` based on the original formatted string; normalize only the emitted display text. |
| Nested quotes are flattened. | Low | Copy the current line’s quote marker sequence instead of hardcoding one marker. |
| Code fences inside quotes still lose code styling. | Low/Medium | Preserve quote marker now; document full markdown-state rebasing as a follow-up if observed. |

## Verification

Focused:

```bash
pnpm test -- tests/host/display-forwarding.test.ts
```

If a pure helper is split:

```bash
pnpm test -- tests/host/markdown-continuation.test.ts tests/host/display-forwarding.test.ts
```

Full gates:

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm lint
pnpm format:check
```

Manual acceptance:

- Run `/conduct` with a prompt or fixture that produces a long thinking block.
- Confirm a continuation like `documents or screenshots...` / `accessibility, and check...` remains visually inside the quote block.
- Confirm non-quoted assistant prose and tool summaries are unchanged.
