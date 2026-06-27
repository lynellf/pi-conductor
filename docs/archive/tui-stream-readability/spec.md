# Spec: TUI streamed text readability

## What I found

- The reported screenshot (`docs/Screenshot 2026-06-24 at 10.03.08 PM.png`) shows worker prose split across multiple `ui-reviewer` blocks. A sentence starts in one block (for example, “Also, the TanStack DevTools button is at”) and continues in the next labeled block (“x=704…”), making the transcript hard to read.
- This matches the archived progressive streaming design in `docs/archive/progressive-text-streaming/spec.md`: `src/host/session-event-handler.ts` flushes suffix chunks every `STREAM_FLUSH_THRESHOLD_CHARS = 200`, and each chunk is sent as `kind: "text"`.
- `src/extension/display-sink-wiring.ts` maps every `kind: "text"` event to a new append-only `conduct.role.text` custom message.
- `src/extension/conduct-message-renderer.ts` renders every `conduct.role.text` message as a `Container` with a bold role label plus a Markdown body. Because each streamed chunk is its own append-only custom message, every chunk repeats the role label and creates a visible block boundary.
- The previous streaming spec explicitly called this out as Open concern 2 (“Per-chunk role-label repetition”) and Open concern 3 (“Blockquote/thinking line-split”). The screenshot is the expected failure mode of those deferred concerns, not a core FSM issue.
- The repo’s canonical FSM spec path in `AGENTS.md` is stale (`docs/orchestrator-fsm-spec.md`); the file currently exists at `docs/archive/orchestrator-fsm-spec.md`. This task is display-only and does not change FSM behavior.

## Objective

Restore readable TUI prose while preserving progressive delivery. Streamed role text must not visibly chop thoughts/sentences into repeated labeled blocks. Long role output should still appear during generation, but chunk boundaries should be visually quiet and should prefer semantic boundaries.

## UI/TUI scope

This is a terminal UI display-layer fix for `/conduct` role output only:

- Host event handling for assistant `message_update` / `message_end` display events.
- Extension display-sink mapping from display events to custom message types.
- Conductor-owned TUI renderers for `conduct.role.*` custom messages.

Separate `ui-designer` input is not required for this fix because the desired UX is already constrained by the existing renderer language and the screenshot: keep the existing labeled role anchor, remove repeated labels for continuation chunks, and avoid mid-sentence chunk boundaries where practical. No new visual system, layout hierarchy, color palette, or user flow decision is being introduced.

## Requirements

1. Preserve progressive streaming for long assistant text.
2. Render at most one visible role label per streamed assistant message sequence.
3. Intermediate continuation chunks must use a label-less renderer.
4. Streaming flushes should prefer safe text boundaries, in this order:
   - paragraph boundary (`\n\n`),
   - line boundary (`\n`),
   - sentence punctuation followed by whitespace,
   - word boundary as a fallback for very long unbroken prose.
5. Do not split words during intermediate flushes unless the text has no usable boundary by a documented maximum window.
6. The no-stream path remains unchanged: short messages or SDK paths with no `message_update` still emit one labeled `conduct.role.text` message at `message_end`.
7. Tool display behavior remains unchanged (`conduct.role.tool`).
8. Cost capture, reducer/FSM behavior, durable JSONL records, and grep-guard boundaries remain unchanged.

## Proposed design

### Display event contract

Extend display text kinds with a continuation-only kind:

- `text` — labeled role text; used for full non-streamed messages and the first visible chunk of a streamed assistant message.
- `text_stream` — label-less continuation text; used after the first visible chunk in the same assistant message.

`text_stream` is display-only. It is not a machine event and is not persisted as a core run record.

### Host streaming state

Replace the current single `StreamState.len` behavior with state that tracks:

- `len`: number of formatted characters already emitted.
- `hasEmittedText`: whether this assistant message has emitted any visible text chunk yet.

On intermediate flush:

- Compute the formatted snapshot with `extractAssistantText(message)` as today.
- If enough new text has accumulated, choose a safe flush boundary instead of slicing exactly at the threshold.
- Emit `kind: "text"` for the first flushed chunk, then `kind: "text_stream"` for continuation chunks.
- Advance `len` to the safe boundary.

On `message_end`:

- If no intermediate chunk was emitted, emit the full message as `kind: "text"` exactly as today.
- If one or more intermediate chunks were emitted, emit the remaining tail as `kind: "text_stream"` when non-empty.
- Reset stream state for the next assistant message.

### Boundary-aware flushing

Add a small pure helper in `src/host/session-event-handler.ts` or a small sibling module if the file approaches the LOC ceiling. Suggested behavior:

- `MIN_FLUSH_CHARS` can reuse `STREAM_FLUSH_THRESHOLD_CHARS` (200).
- Add `MAX_FLUSH_WINDOW_CHARS` (for example 600) to prevent waiting forever on long paragraphs without punctuation.
- Only flush when `formatted.length - len >= MIN_FLUSH_CHARS`.
- Prefer the best boundary at or after `len + MIN_FLUSH_CHARS` within the available snapshot.
- If no preferred boundary appears and the pending suffix is below the max window, wait for more text.
- If the max window is exceeded, flush at the last whitespace before `len + MAX_FLUSH_WINDOW_CHARS`; if none exists, flush at the max window.

This keeps progressive delivery while avoiding the 200-character hard cut that caused the screenshot regression.

### Extension renderer

Add a `conduct.role.text_stream` renderer that returns a Markdown body without the role-label `Text` child. Keep existing `conduct.role.text` rendering unchanged for the initial/lone message anchor.

## Files likely affected

- `src/host/display-sink.ts` — extend `DisplayEventKind` to include `"text_stream"`.
- `src/host/session-event-handler.ts` — stream state, first-vs-continuation kind selection, boundary-aware flush helper.
- `src/extension/display-sink-wiring.ts` — map `text_stream` to `customType: "conduct.role.text_stream"`.
- `src/extension/conduct-message-renderer.ts` — add label-less text-stream renderer and details kind support.
- Tests under `tests/host/` and `tests/extension/` for the new behavior.

## Success criteria

- A long streamed message no longer repeats the role label for every ~200 characters.
- Intermediate chunks avoid mid-sentence splits when punctuation/line boundaries are available.
- Short/non-streamed messages still render exactly one labeled block.
- Existing tool rendering remains compact and unchanged.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and `pnpm format:check` pass.
- Manual TUI check confirms the screenshot failure mode is resolved.

## Open questions

None blocking. The exact max flush window may be tuned during implementation; document the chosen value in code and tests.
