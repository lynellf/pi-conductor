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
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import type { SessionState } from "./cost.js";

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
}): void {
  args.session.subscribe((event) => onSessionEvent(args.session, args.state, event));
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
  event: AgentSessionEvent,
): void {
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
