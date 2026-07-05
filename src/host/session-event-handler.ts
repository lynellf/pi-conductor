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
 * - **Assistant-text display (Phase 1 open-issues-round-2).**
 *   `message_end` for an assistant message → emit one
 *   `"text"` display event with the full extracted text.
 *   No per-chunk streaming — text accumulates in the session
 *   and appears as one continuous block per assistant turn.
 *
 * Tool events (`tool_execution_start` / `tool_execution_end`)
 * are emitted as `tool_call` / `tool_result` display events per
 * event (unchanged).
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
import type { Role } from "../core/types.js";
import type { SessionState } from "./cost.js";
import {
  type DisplaySink,
  extractAssistantText,
  extractFileHunks,
  extractFileMutations,
  type HunkLine,
} from "./display-sink.js";
import { loadWriteHunksForArgs } from "./hunk-diff.js";
import { formatToolCallSummary, formatToolCompletedLine } from "./tool-summary.js";

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
 *
 * **Display sink (`onDisplay`):** `tool_result` events may carry a
 * `files` field when the tool is `write` or `edit` and the
 * execution succeeded (issue #12, open-issues-round-3).
 *
 * Issue #13 (open-issues-round-3): `files[].hunks` is populated for
 * `edit` (synchronous) and `write` (synchronous via pre-read at
 * `tool_execution_start`) when structured diff hunks can be computed.
 */
export function attachSessionEventHandler(args: {
  session: AgentSession;
  state: SessionState;
  role: Role;
  onDisplay?: DisplaySink;
}): void {
  // Per-session buffer: toolCallId → { summary, args, writeHunks }.
  // The args are needed at `tool_execution_end` to populate
  // `DisplayEvent.files` for write/edit tools (issue #12).
  // Issue #13: for `write` tools, `writeHunks` holds structured diff
  // hunks computed synchronously at `tool_execution_start` (pre-mutation
  // file read via loadWriteHunksForArgs).
  // toolCallId is unique within a session, so a closure-scoped
  // Map avoids cross-session collisions without needing the
  // sessionId — fine because each session gets its own
  // onSessionEvent via attachSessionEventHandler.
  const pending = new Map<
    string,
    {
      summary: string;
      args: unknown;
      /** Structured diff hunks for `write` tool invocations.
       *  Computed at `tool_execution_start` (pre-mutation, synchronous);
       *  consumed at `tool_execution_end` for emission. `undefined` on
       *  read failure (graceful degradation: char-counts still flow). */
      writeHunks?: ReadonlyArray<HunkLine> | undefined;
    }
  >();

  args.session.subscribe((event) =>
    onSessionEvent(args.session, args.state, args.role, args.onDisplay, event, pending),
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
 *
 * **Issue #13 (`hunks`):** `tool_execution_end` emits `files[].hunks`
 * for `edit` (synchronous) and `write` (synchronous via pre-read).
 */
function onSessionEvent(
  session: AgentSession,
  state: SessionState,
  role: Role,
  onDisplay: DisplaySink | undefined,
  event: AgentSessionEvent,
  pending: Map<
    string,
    {
      summary: string;
      args: unknown;
      writeHunks?: ReadonlyArray<HunkLine> | undefined;
    }
  >,
): void {
  if (event.type === "tool_execution_start") {
    // Buffer the invocation summary and args; do NOT emit a tool_call
    // event (spec: tool-display-combine-status — combine at end).
    const summary = formatToolCallSummary(event.toolName, event.args);
    if (summary !== null) {
      const entry: {
        summary: string;
        args: unknown;
        writeHunks?: ReadonlyArray<HunkLine> | undefined;
      } = { summary, args: event.args };

      // Issue #13: capture the previous file content for `write` so we
      // can produce structured diff hunks at `tool_execution_end`. The
      // file is still pre-mutation here; reading post-tool would yield
      // `args.content` (useless for diffing). Fire-and-forget — failures
      // are swallowed in `loadWriteHunksForArgs` (returns `undefined`).
      if (event.toolName === "write") {
        entry.writeHunks = loadWriteHunksForArgs(event.args);
      }

      pending.set(event.toolCallId, entry);
    }
    return;
  }

  if (event.type === "tool_execution_end") {
    // Look up the buffered { summary, args, writeOldContentPromise }
    // from the matching start event (if any). Orphaned ends (no matching
    // start) get undefined and formatToolCompletedLine returns null →
    // no emit.
    const buffered = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    const line = formatToolCompletedLine(buffered?.summary, event.result, event.isError);
    if (line === null) return;

    if (event.isError) {
      // Errors omit `files` entirely (Phase 1 contract).
      onDisplay?.({ role, kind: "tool_result", text: line });
      return;
    }

    const mutations = extractFileMutations(event.toolName, buffered?.args);

    // Helper: emit a `tool_result` display event with the given hunks
    // attached to the existing mutations (or omit hunks if none).
    const emit = (hunks?: ReadonlyArray<HunkLine>): void => {
      const files =
        mutations !== undefined && mutations.length > 0
          ? mutations.map((f) => (hunks && hunks.length > 0 ? { ...f, hunks } : f))
          : undefined;
      onDisplay?.({
        role,
        kind: "tool_result",
        text: line,
        ...(files !== undefined && { files }),
      });
    };

    // `edit` — pure, hunks from args.
    if (event.toolName === "edit") {
      emit(extractFileHunks(event.toolName, buffered?.args));
      return;
    }

    // `write` — synchronous hunks already computed at tool_execution_start
    // via loadWriteHunksForArgs (pre-mutation file read). Emit with the
    // computed hunks (or undefined on read failure → emit without hunks).
    const writeHunks = buffered?.writeHunks;
    if (event.toolName === "write" && writeHunks !== undefined) {
      emit(writeHunks);
      return;
    }

    // Other tools: emit without hunks.
    emit();
  }

  // Phase 1 (open-issues-round-2): `message_update` no longer emits
  // progressive text events. Text is accumulated in the session and
  // emitted once on `message_end` as a single `"text"` event.
  if (event.type === "message_start" || event.type === "message_update") {
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
    // Phase 1 (open-issues-round-2): emit exactly one `"text"` event
    // per assistant turn with the full extracted text. No progressive
    // streaming, no `text_stream` chunks.
    if (text.length > 0) {
      onDisplay?.({ role, kind: "text", text });
    }
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
