/**
 * Shared per-session event handler — Tasks 17 + 18, used by
 * `StubHost` (test path) and `ProductionHost` (production path).
 *
 * Both hosts subscribe to the same SDK `AgentSession` event stream
 * and need identical behavior on it:
 *   - `message_end` for an assistant message → accumulate
 *     `Usage` into the per-session `SessionState` (the §11.4
 *     SDK → normalized mapping is in `SessionState`).
 *   - `message_end` for an assistant message with
 *     `stopReason: "error"` → flip the terminal reason to
 *     `"model_error"` (Task 18, §8.2).
 *   - cap exceeded → mark aborted, flip terminal reason to
 *     `"session_cost_cap_exceeded"`, call `session.abort()`
 *     (§11.7).
 * - **Progressive assistant-text streaming (Phase 1).**
 *   `message_update` with an assistant message → recompute
 *   `extractAssistantText(partial)` and emit the new suffix
 *   (delta since the last flush) to the display sink every
 *   `STREAM_FLUSH_THRESHOLD_CHARS` accumulated chars.
 *   `message_end` flushes the unflushed tail.
 *
 * Without this module the two hosts would each carry a ~50-line
 * copy of the same handler — a textbook drift hazard. With it,
 * any future protocol-level fix lands in one place and the
 * existing stub E2E / cost / fallback / stats tests keep their
 * behavior contract (they call `runLoop` against the host, not
 * the handler directly).
 *
 * **Host-agnosticism.** This module imports SDK types only
 * (`@earendil-works/pi-ai` for `AssistantMessage` / `Usage`,
 * `@earendil-works/pi-coding-agent` for `AgentSession` /
 * `AgentSessionEvent`). It's in `src/host/`, which is the only
 * directory the grep-guard allows pi runtime imports.
 *
 * **Public-surface change (Phase 1).** This module now exports one
 * additional non-breaking `export const number`
 * (`STREAM_FLUSH_THRESHOLD_CHARS`) and defines one local interface
 * (`StreamState`) — no new imports, no new dependencies, no new
 * exported types.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Role } from "../core/types.js";
import { findFlushBoundary, MAX_FLUSH_WINDOW_CHARS } from "./boundary-flush.js";
import type { SessionState } from "./cost.js";
import { type DisplaySink, extractAssistantText } from "./display-sink.js";
import { normalizeContinuationChunk } from "./markdown-continuation.js";
import { formatToolCallSummary, formatToolCompletedLine } from "./tool-summary.js";

// ─── Streaming constants ────────────────────────────────────────────

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

/**
 * Per-session mutable holder for streamed message state (spec:
 * progressive-text-streaming / tui-stream-readability). Passed by
 * reference into `onSessionEvent` and mutated in place, mirroring
 * how `pending` is threaded.
 *
 * - `len`: number of formatted characters already flushed during
 *   the in-flight assistant message.
 * - `hasEmittedText`: whether this assistant message has already
 *   emitted at least one visible text chunk. The first chunk uses
 *   `kind: "text"` (labeled); subsequent chunks use `kind: "text_stream"`
 *   (label-less continuation). Reset on `message_start` and after
 *   `message_end` so labels do not leak across messages (N1).
 */
interface StreamState {
  len: number;
  hasEmittedText: boolean;
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Subscribe `session` to events for usage capture, model-error
 * detection, and per-session cap enforcement. The handler
 * writes to the supplied `SessionState`; the host stores the
 * state in its own session-id-keyed map for later reads via
 * `captureUsage` and `sessionTerminalReason`.
 *
 * `agent_runtime` calls listeners synchronously as events flow,
 * so by the time `createAgentSession` returns the state already
 * reflects the session's first events (typically none — the
 * `prompt()` call drives emissions).
 */
export function attachSessionEventHandler(args: {
  session: AgentSession;
  state: SessionState;
  role: Role;
  onDisplay?: DisplaySink;
}): void {
  // Per-session buffer: toolCallId → invocation summary. The
  // shared displaySink is wired into every role session;
  // toolCallId is unique within a session, so a closure-scoped
  // Map avoids cross-session collisions without needing the
  // sessionId — fine because each session gets its own
  // onSessionEvent via attachSessionEventHandler.
  const pending = new Map<string, string>();

  // Per-session streamed-len holder. Reset on message_start and after
  // message_end. Same scoping rationale as `pending`: each role
  // session gets its own onSessionEvent via attachSessionEventHandler.
  const stream: StreamState = { len: 0, hasEmittedText: false };

  args.session.subscribe((event) =>
    onSessionEvent(args.session, args.state, args.role, args.onDisplay, event, pending, stream),
  );
}

/**
 * Build the rejection predicate the handoff/end tool factories
 * close over. The predicate is `false` until `bindState` is
 * called (the host binds the state after constructing the
 * session, once `sessionId` is known). This indirection
 * matches StubHost's existing pattern and lets the production
 * host share the same code path.
 *
 * **Why the indirection.** The tool factories take a
 * `() => boolean` predicate at construction. The
 * `SessionState` is constructed AFTER the session, so the
 * predicate can't close over the state directly. The host
 * binds the state post-construction via `bindState`.
 */
export interface CaptureRejector {
  bindState(state: SessionState): void;
  shouldRejectCapture(): boolean;
}

export function createCaptureRejector(): CaptureRejector {
  let bound: SessionState | null = null;
  return {
    bindState(state: SessionState) {
      bound = state;
    },
    shouldRejectCapture(): boolean {
      if (bound === null) return false;
      // Reject when the session is in a terminal state (cap
      // exceeded, model error, or externally aborted). The
      // tool wrapper short-circuits to an error result without
      // invoking the underlying tool — preventing
      // work-after-handoff from mutating the workspace after
      // the role has declared its exit intent (§12.1).
      return bound.terminalReason !== null || bound.aborted;
    },
  };
}

// ─── Internals ──────────────────────────────────────────────────────

/**
 * Per-session event handler. Pure side-effect: writes to the
 * `SessionState` and (for cap detection) calls
 * `session.abort()`. The loop owns the rest (record shape,
 * `reduceLifecycle`, persistence).
 */
function onSessionEvent(
  session: AgentSession,
  state: SessionState,
  role: Role,
  onDisplay: DisplaySink | undefined,
  event: AgentSessionEvent,
  pending: Map<string, string>,
  stream: StreamState,
): void {
  if (event.type === "tool_execution_start") {
    // Buffer the invocation summary; do NOT emit a tool_call
    // event (spec: tool-display-combine-status — combine at end).
    const summary = formatToolCallSummary(event.toolName, event.args);
    if (summary !== null) {
      pending.set(event.toolCallId, summary);
    }
    return;
  }

  if (event.type === "tool_execution_end") {
    // Look up the buffered summary from the matching start event
    // (if any). Orphaned ends (no matching start) get undefined
    // and formatToolCompletedLine returns null → no emit.
    const summary = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    const line = formatToolCompletedLine(summary, event.result, event.isError);
    if (line !== null) {
      onDisplay?.({ role, kind: "tool_result", text: line });
    }
    return;
  }

  // ─── Streaming: message_start ────────────────────────────────
  // Reset per-message stream state (len + hasEmittedText). Defensive
  // — harmless for user-prompt message_start (spec:
  // progressive-text-streaming / tui-stream-readability N1).
  if (event.type === "message_start") {
    stream.len = 0;
    stream.hasEmittedText = false;
    return;
  }

  // ─── Streaming: message_update ───────────────────────────────
  // Recompute the formatted assistant text; emit only the suffix
  // since the last flush when the accumulated delta crosses the
  // threshold. Uses boundary-aware flushing to avoid mid-sentence
  // splits (spec: tui-stream-readability).
  if (event.type === "message_update") {
    const msg = event.message as AssistantMessage;
    if (msg?.role === "assistant") {
      const formatted = extractAssistantText(msg);
      if (formatted.length - stream.len >= STREAM_FLUSH_THRESHOLD_CHARS) {
        const boundaryPos = findFlushBoundary(
          formatted,
          stream.len,
          STREAM_FLUSH_THRESHOLD_CHARS,
          MAX_FLUSH_WINDOW_CHARS,
        );
        const suffix = normalizeContinuationChunk(formatted, stream.len, boundaryPos);
        if (suffix.length > 0) {
          const kind = stream.hasEmittedText ? "text_stream" : "text";
          onDisplay?.({ role, kind, text: suffix });
          stream.hasEmittedText = true;
        }
        stream.len = boundaryPos;
      }
    }
    return;
  }

  if (event.type !== "message_end") return;
  const message = event.message as AssistantMessage;

  // Model-error detection (Task 18, §8.2). The stub's `fail`
  // step emits an AssistantMessage with `stopReason: "error"`.
  // The SDK's `AgentSessionEvent` protocol folds the
  // underlying `pi-ai` stream's `error` into `message_end`
  // carrying the error message; we catch both here.
  if (message?.role === "assistant" && message.stopReason === "error") {
    state.setTerminalReason("model_error");
    return;
  }

  if (message?.role === "assistant") {
    const text = extractAssistantText(message);
    // Tail-flush: emit only the unflushed portion (all of it when
    // no message_update fired, because stream.len stays 0).
    // Use text_stream for continuation tails when hasEmittedText
    // is true; use text for the first/only chunk (N3 preserves the
    // `text.length > stream.len` guard).
    // Reset stream state for the next message (N1).
    if (text.length > stream.len) {
      const kind = stream.hasEmittedText ? "text_stream" : "text";
      onDisplay?.({ role, kind, text: normalizeContinuationChunk(text, stream.len, text.length) });
    }
    stream.len = 0;
    stream.hasEmittedText = false;
  }

  if (message?.role === "assistant" && message.usage) {
    // De-dup key: timestamp + totalTokens + cost.total. The SDK
    // contract is one `message_end` per message; this guard is
    // defensive against an `abort()` re-emitting the final
    // message's events (§11.7 "abort accounting"). The
    // composite key is unique per message by construction.
    const key = `${message.timestamp ?? 0}-${message.usage.totalTokens}-${message.usage.cost.total}`;
    state.addMessageUsage(key, message.usage);

    // Per-session cap (§11.7). Evaluate against the cumulative
    // usage; if exceeded, abort and flip the terminal reason.
    // The check is on `message_end` (not `turn_end` as the spec
    // sketch mentions) so the abort fires BEFORE the
    // tool-execution phase — the handoff tool wrapper checks
    // the same state via `shouldRejectCapture` and refuses to
    // write to the capture buffer, leaving it empty. The loop
    // then records `session_failed(session_cost_cap_exceeded)`
    // with no captured handoff to reduce.
    if (state.isSessionCapExceeded() && !state.aborted) {
      state.markAborted();
      state.setTerminalReason("session_cost_cap_exceeded");
      void session.abort();
    }
  }
}
