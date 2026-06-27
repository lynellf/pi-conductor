# Plan — Phase 1: Label-less, boundary-aware streamed text

## Summary of what changed

Initial implementation plan for the TUI readability regression. It follows up on the archived progressive streaming plan by addressing its deferred label-repetition and mid-sentence split concerns.

## Task 1 — Extend the display event contract

**Files likely touched**
- `src/host/display-sink.ts`
- affected type imports/tests

**Work**
- Add `"text_stream"` to `DisplayEventKind`.
- Document that it is a display-only continuation kind.

**Acceptance**
- TypeScript callers can distinguish labeled `text` from label-less continuation `text_stream`.
- Tool event kinds are unchanged.

**Verify**
- `pnpm typecheck`

## Task 2 — Make host streaming boundary-aware and continuation-aware

**Files likely touched**
- `src/host/session-event-handler.ts`
- `tests/host/display-forwarding.test.ts`

**Work**
- Expand stream state from `{ len }` to `{ len, hasEmittedText }`.
- Add pure boundary-selection helper(s): prefer paragraph, line, sentence, then word boundary; use a documented max window fallback.
- Emit the first visible streamed chunk as `kind: "text"` and later chunks/tails as `kind: "text_stream"`.
- Preserve current no-`message_update` behavior: one full `kind: "text"` event at `message_end`.
- Keep `stopReason === "error"`, usage capture, cap evaluation, and tool handling unchanged.

**Acceptance**
- Threshold crossing in the middle of a sentence waits until a safe boundary when one appears within the max window.
- Continuation chunks use `text_stream`.
- No-stream and sub-threshold messages still emit a single `text` event.
- Concatenating emitted text/text_stream payloads equals the final formatted assistant text.

**Verify**
- `pnpm test -- tests/host/display-forwarding.test.ts`

## Task 3 — Add label-less stream renderer and sink mapping

**Files likely touched**
- `src/extension/display-sink-wiring.ts`
- `src/extension/conduct-message-renderer.ts`
- `tests/extension/tui-bridge.test.ts`
- `tests/extension/conduct-message-renderer.test.ts`
- `tests/extension/conduct-registration.test.ts`

**Work**
- Extend `ConductMessageKind` with `"text_stream"`.
- Map `DisplayEvent.kind === "text_stream"` to `customType: "conduct.role.text_stream"`.
- Register `conduct.role.text_stream` in `createConductMessageRenderers`.
- Implement the renderer as Markdown body only, no role-label `Text` child.
- Keep `conduct.role.text` and `conduct.role.tool` output unchanged.

**Acceptance**
- Renderer registration includes `conduct.role.text`, `conduct.role.text_stream`, and `conduct.role.tool`.
- `conduct.role.text_stream` renders no role label.
- Existing text/tool renderer tests remain valid after expected key-list updates.

**Verify**
- `pnpm test -- tests/extension/tui-bridge.test.ts tests/extension/conduct-message-renderer.test.ts tests/extension/conduct-registration.test.ts`

## Task 4 — Regression coverage for the screenshot failure mode

**Files likely touched**
- `tests/host/display-forwarding.test.ts`
- optionally a focused extension renderer test

**Work**
- Add a fixture with prose similar to the screenshot where the 200-character point lands mid-sentence and punctuation appears shortly after.
- Assert the host does not emit the chunk at the hard threshold, but does emit at the sentence boundary.
- Assert the first chunk is `text` and the next chunk/tail is `text_stream`.

**Acceptance**
- The test would fail under the current hard-slice implementation.
- The test proves no repeated label is requested for continuation chunks.

**Verify**
- `pnpm test -- tests/host/display-forwarding.test.ts`

## Task 5 — Full gates and manual TUI verification

**Work**
- Run standard repo gates.
- Manually run `/conduct` with a prompt that produces multi-sentence, multi-hundred-character role output.
- Confirm visually that the TUI shows one role label for the streamed message and continuation text is not chopped mid-sentence in the way shown in the screenshot.

**Verify**
```bash
pnpm typecheck
pnpm build
pnpm test
pnpm lint
pnpm format:check
```

## Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Waiting for semantic boundaries reduces perceived streaming cadence. | Medium | Use a max flush window fallback. |
| Label-less custom messages may still have some vertical spacing because `sendMessage` is append-only. | Medium | Removing repeated labels plus boundary-aware cuts addresses the major readability issue; verify manually. |
| Markdown blockquotes can still be split if thinking text has long unbroken lines. | Low/Medium | Boundary helper prefers line/paragraph boundaries; max-window fallback is documented. |
| Renderer key-list tests need updates. | Low | Update focused extension tests in the same phase. |

## Reviewer checks

- Confirm no changes to `src/core`, `src/manifest`, `src/seam`, `src/cost`, or `src/persistence` are needed.
- Confirm `message_end` cost/cap logic remains byte-for-byte equivalent except for display event kind selection.
- Confirm the manual TUI check specifically compares against `docs/Screenshot 2026-06-24 at 10.03.08 PM.png`.
