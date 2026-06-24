/**
 * Phase 2 Task 3 — host display forwarding.
 *
 * Pins the additive display tap on `attachSessionEventHandler`:
 * assistant text and combined tool-completed lines flow to the
 * optional display sink without changing the cost / terminal-reason
 * logic.
 *
 * Updated for tool-display-combine-status (Phase 1): the host
 * buffers the start summary and emits a single combined line at
 * `tool_execution_end`. Start events emit nothing; orphaned ends
 * emit nothing; machine tools remain suppressed.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { SessionState } from "../../src/host/cost.js";
import {
  attachSessionEventHandler,
  STREAM_FLUSH_THRESHOLD_CHARS,
} from "../../src/host/session-event-handler.js";

function makeAssistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    content: [
      { type: "text", text: "Hello " },
      { type: "thinking", thinking: "planning the response" },
      { type: "text", text: "world" },
    ],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 123,
  } as AssistantMessage;
}

/** Assistant message with a redacted thinking block (safety-filtered;
 * only an opaque `thinkingSignature` survives, `.thinking` is empty).
 * The display extractor must skip it — no gibberish in the TUI. */
function makeAssistantMessageWithRedactedThinking(): AssistantMessage {
  return {
    role: "assistant",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    content: [
      { type: "thinking", thinking: "", redacted: true, thinkingSignature: "opaque" },
      { type: "text", text: "final answer" },
    ],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 123,
  } as AssistantMessage;
}

function makeSession() {
  let listener: ((event: unknown) => void) | undefined;
  return {
    abort: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn((fn: (event: unknown) => void) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    }),
    emit(event: unknown) {
      listener?.(event);
    },
  };
}

describe("attachSessionEventHandler — display sink", () => {
  it("emits a single combined line at tool_execution_end (no separate tool_call)", () => {
    const session = makeSession();
    const state = new SessionState({ cap: null, model: null });
    const onDisplay = vi.fn();

    attachSessionEventHandler({
      session: session as never,
      state,
      role: "orchestrator",
      onDisplay,
    });

    session.emit({ type: "message_end", message: makeAssistantMessage() });
    session.emit({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "ls" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "bash",
      result: { ok: true },
      isError: false,
    });

    // The handler emits TWO display events:
    // 1. The assistant text (from message_end).
    // 2. The combined tool-completed line (from tool_execution_end).
    // No separate tool_call event is emitted (buffered).
    expect(onDisplay).toHaveBeenCalledTimes(2);
    expect(onDisplay).toHaveBeenNthCalledWith(1, {
      role: "orchestrator",
      kind: "text",
      // Thinking is included as a separate block (joined with
      // "\n\n") so reasoning reads as its own paragraph; the
      // two adjacent text parts still merge ("Hello " + "world"
      // → "Hello world") because they are one logical utterance.
      // Reversal of the original Task 3 "thinking omitted"
      // decision — the human wants to see model reasoning at
      // all times (2026-06-20, after Phase 5.5).
      text: "Hello \n\n> planning the response\n\nworld",
    });
    // Combined line: "✓ bash: ls" — no separate "✓" indicator.
    expect(onDisplay).toHaveBeenNthCalledWith(2, {
      role: "orchestrator",
      kind: "tool_result",
      text: "✓ bash: ls",
    });
  });

  it("includes non-redacted thinking content in the text display event (reversal of Task 3 'thinking omitted')", () => {
    // The human reversed the original "thinking omitted by default"
    // decision on 2026-06-20: they want to see what the models are
    // thinking at all times. The display extractor now surfaces
    // non-redacted `ThinkingContent.thinking` as part of the text
    // event, joined as a separate block so it reads as its own
    // paragraph above/below the answer text.
    const session = makeSession();
    const state = new SessionState({ cap: null, model: null });
    const onDisplay = vi.fn();

    attachSessionEventHandler({
      session: session as never,
      state,
      role: "worker",
      onDisplay,
    });

    session.emit({ type: "message_end", message: makeAssistantMessage() });

    expect(onDisplay).toHaveBeenCalledTimes(1);
    expect(onDisplay).toHaveBeenNthCalledWith(1, {
      role: "worker",
      kind: "text",
      text: "Hello \n\n> planning the response\n\nworld",
    });
  });

  it("blockquotes multi-line thinking content", () => {
    const session = makeSession();
    const state = new SessionState({ cap: null, model: null });
    const onDisplay = vi.fn();

    attachSessionEventHandler({
      session: session as never,
      state,
      role: "worker",
      onDisplay,
    });

    const msg: AssistantMessage = {
      role: "assistant",
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      content: [{ type: "thinking", thinking: "line one\nline two" }],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 123,
    } as AssistantMessage;

    session.emit({ type: "message_end", message: msg });

    expect(onDisplay).toHaveBeenCalledTimes(1);
    expect(onDisplay).toHaveBeenNthCalledWith(1, {
      role: "worker",
      kind: "text",
      text: "> line one\n> line two",
    });
  });

  it("skips redacted thinking blocks (no opaque payload in the TUI)", () => {
    // Safety-filtered thinking blocks carry only an opaque
    // `thinkingSignature` (`.thinking` is empty, `.redacted` is
    // true). The extractor skips them so the TUI never shows
    // gibberish; the readable text parts still surface.
    const session = makeSession();
    const state = new SessionState({ cap: null, model: null });
    const onDisplay = vi.fn();

    attachSessionEventHandler({
      session: session as never,
      state,
      role: "worker",
      onDisplay,
    });

    session.emit({ type: "message_end", message: makeAssistantMessageWithRedactedThinking() });

    expect(onDisplay).toHaveBeenCalledTimes(1);
    expect(onDisplay).toHaveBeenNthCalledWith(1, {
      role: "worker",
      kind: "text",
      text: "final answer",
    });
  });

  it("emits combined ✗ bash: ls: <first line> for error with string result", () => {
    const session = makeSession();
    const state = new SessionState({ cap: null, model: null });
    const onDisplay = vi.fn();

    attachSessionEventHandler({
      session: session as never,
      state,
      role: "worker",
      onDisplay,
    });

    // Matching start (buffer the summary) + end with multi-line string error
    session.emit({
      type: "tool_execution_start",
      toolCallId: "call-err",
      toolName: "bash",
      args: { command: "ls" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "call-err",
      toolName: "bash",
      result: "permission denied\n  at script.sh:3",
      isError: true,
    });

    expect(onDisplay).toHaveBeenCalledTimes(1);
    expect(onDisplay).toHaveBeenNthCalledWith(1, {
      role: "worker",
      kind: "tool_result",
      text: "✗ bash: ls: permission denied",
    });
  });

  it("emits combined ✗ bash: ls: <message> for error with object result", () => {
    const session = makeSession();
    const state = new SessionState({ cap: null, model: null });
    const onDisplay = vi.fn();

    attachSessionEventHandler({
      session: session as never,
      state,
      role: "worker",
      onDisplay,
    });

    // Matching start (buffer the summary) + end with object error
    session.emit({
      type: "tool_execution_start",
      toolCallId: "call-err-obj",
      toolName: "bash",
      args: { command: "ls" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "call-err-obj",
      toolName: "bash",
      result: { message: "command not found", code: 127 },
      isError: true,
    });

    expect(onDisplay).toHaveBeenCalledTimes(1);
    expect(onDisplay).toHaveBeenNthCalledWith(1, {
      role: "worker",
      kind: "tool_result",
      text: "✗ bash: ls: command not found",
    });
  });

  it("buffers start and emits nothing until end", () => {
    const session = makeSession();
    const state = new SessionState({ cap: null, model: null });
    const onDisplay = vi.fn();

    attachSessionEventHandler({
      session: session as never,
      state,
      role: "worker",
      onDisplay,
    });

    // Emit only the start event; nothing should be displayed yet
    session.emit({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "ls" },
    });

    expect(onDisplay).not.toHaveBeenCalled();
  });

  it("orphaned end (no matching start) emits nothing", () => {
    const session = makeSession();
    const state = new SessionState({ cap: null, model: null });
    const onDisplay = vi.fn();

    attachSessionEventHandler({
      session: session as never,
      state,
      role: "worker",
      onDisplay,
    });

    // Emit only the end event with no prior start; orphaned end
    // has undefined summary -> formatToolCompletedLine returns
    // null -> no emit.
    session.emit({
      type: "tool_execution_end",
      toolCallId: "call-orphan",
      toolName: "bash",
      result: "permission denied",
      isError: true,
    });

    expect(onDisplay).not.toHaveBeenCalled();
  });

  it("suppresses handoff tool_call and tool_result events (protocol noise)", () => {
    // Machine tools (handoff, end, ask_user) are suppressed by
    // the formatters returning null. The display sink never
    // receives them.
    const session = makeSession();
    const state = new SessionState({ cap: null, model: null });
    const onDisplay = vi.fn();

    attachSessionEventHandler({
      session: session as never,
      state,
      role: "orchestrator",
      onDisplay,
    });

    session.emit({
      type: "tool_execution_start",
      toolCallId: "call-handoff",
      toolName: "handoff",
      args: { target_role: "worker" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "call-handoff",
      toolName: "handoff",
      result: { ok: true },
      isError: false,
    });

    // No tool_call or tool_result events for machine tools.
    expect(onDisplay).not.toHaveBeenCalled();
  });

  it("suppresses end tool_call and tool_result events", () => {
    const session = makeSession();
    const state = new SessionState({ cap: null, model: null });
    const onDisplay = vi.fn();

    attachSessionEventHandler({
      session: session as never,
      state,
      role: "orchestrator",
      onDisplay,
    });

    session.emit({
      type: "tool_execution_start",
      toolCallId: "call-end",
      toolName: "end",
      args: { reason: "done" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "call-end",
      toolName: "end",
      result: { ok: true },
      isError: false,
    });

    expect(onDisplay).not.toHaveBeenCalled();
  });

  it("does not require a display sink", () => {
    const session = makeSession();
    const state = new SessionState({ cap: null, model: null });

    expect(() =>
      attachSessionEventHandler({
        session: session as never,
        state,
        role: "worker",
      }),
    ).not.toThrow();
  });

  // ─── Streaming (Phase 1: suffix-chunk flush) ─────────────────

  describe("Streaming", () => {
    /** Build a minimal assistant message with pure text content. */
    function textMessage(text: string): AssistantMessage {
      return { role: "assistant", content: [{ type: "text", text }] } as AssistantMessage;
    }

    const THRESHOLD = STREAM_FLUSH_THRESHOLD_CHARS;

    // ── Case 1 ─────────────────────────────────────────────────
    it("streams accumulated text in a threshold suffix chunk then a tail at message_end", () => {
      // What only this case pins: the chunk-then-tail boundary —
      // that message_end emits the slice *after* the last-flushed
      // length, not the whole text (the new message_end invariant).
      const session = makeSession();
      const state = new SessionState({ cap: null, model: null });
      const onDisplay = vi.fn();

      attachSessionEventHandler({
        session: session as never,
        state,
        role: "orchestrator",
        onDisplay,
      });

      const chunkLen = THRESHOLD + 10; // 210 — crosses threshold
      const tailLen = 40;
      const finalLen = chunkLen + tailLen; // 250
      const chunk = "a".repeat(chunkLen);
      const finalText = "a".repeat(finalLen);

      session.emit({ type: "message_start", message: textMessage("") });
      session.emit({ type: "message_update", message: textMessage(chunk) });
      session.emit({ type: "message_end", message: textMessage(finalText) });

      expect(onDisplay).toHaveBeenCalledTimes(2);
      // First emit: the full chunk (stream.len was 0)
      expect(onDisplay).toHaveBeenNthCalledWith(1, {
        role: "orchestrator",
        kind: "text",
        text: chunk,
      });
      // Second emit: the unflushed tail
      expect(onDisplay).toHaveBeenNthCalledWith(2, {
        role: "orchestrator",
        kind: "text",
        text: finalText.slice(chunkLen),
      });
    });

    // ── Case 2 ─────────────────────────────────────────────────
    it("message_update below the threshold emits nothing mid-stream; full text emits once at message_end", () => {
      // What only this case pins: the sub-threshold no-flush
      // fallback — that a sub-threshold partial produces zero
      // intermediate emits, and the new message_end tail
      // (slice(0)) is byte-identical to the legacy whole-text
      // emit. This is the no-regression proof for the
      // pre-streaming path inside the new streaming suite.
      const session = makeSession();
      const state = new SessionState({ cap: null, model: null });
      const onDisplay = vi.fn();

      attachSessionEventHandler({
        session: session as never,
        state,
        role: "orchestrator",
        onDisplay,
      });

      const short = THRESHOLD - 1; // 199 — below threshold
      const finalText = "a".repeat(short);

      session.emit({ type: "message_start", message: textMessage("") });
      session.emit({ type: "message_update", message: textMessage(finalText) });
      session.emit({ type: "message_end", message: textMessage(finalText) });

      // Only one emit: the message_end tail (= full text, since
      // stream.len never moved)
      expect(onDisplay).toHaveBeenCalledTimes(1);
      expect(onDisplay).toHaveBeenNthCalledWith(1, {
        role: "orchestrator",
        kind: "text",
        text: finalText,
      });
    });

    // ── Case 3 ─────────────────────────────────────────────────
    it("flushes exactly the new suffix on each threshold crossing", () => {
      // What only this case pins: multi-chunk continuity — that
      // consecutive chunks each emit *exactly* the new suffix
      // and never re-flush the prefix (case 1 only crosses once,
      // so it cannot prove the stream.len advances across two
      // message_updates).
      const session = makeSession();
      const state = new SessionState({ cap: null, model: null });
      const onDisplay = vi.fn();

      attachSessionEventHandler({
        session: session as never,
        state,
        role: "orchestrator",
        onDisplay,
      });

      const chunk1 = THRESHOLD + 10; // 210 — crosses threshold
      const chunk2Gain = THRESHOLD; // 200 — crosses threshold again
      const tailGain = 40;
      const finalLen = chunk1 + chunk2Gain + tailGain;

      const partial1 = "a".repeat(chunk1);
      const partial2 = "a".repeat(chunk1 + chunk2Gain);
      const finalText = "a".repeat(finalLen);

      session.emit({ type: "message_start", message: textMessage("") });
      session.emit({ type: "message_update", message: textMessage(partial1) });
      session.emit({ type: "message_update", message: textMessage(partial2) });
      session.emit({ type: "message_end", message: textMessage(finalText) });

      expect(onDisplay).toHaveBeenCalledTimes(3);
      expect(onDisplay).toHaveBeenNthCalledWith(1, {
        role: "orchestrator",
        kind: "text",
        text: partial1, // first chunk: slice(0, chunk1)
      });
      expect(onDisplay).toHaveBeenNthCalledWith(2, {
        role: "orchestrator",
        kind: "text",
        text: partial2.slice(chunk1), // second chunk: slice(chunk1, chunk1+chunk2Gain)
      });
      expect(onDisplay).toHaveBeenNthCalledWith(3, {
        role: "orchestrator",
        kind: "text",
        text: finalText.slice(chunk1 + chunk2Gain), // tail: slice(chunk1+chunk2Gain)
      });
    });

    // ── Case 4 ─────────────────────────────────────────────────
    it("resets the accumulator across consecutive messages", () => {
      // What only this case pins: the per-message reset — neither
      // case 1 nor 3 spans two messages, so neither can detect a
      // stale stream.len leaking from one turn into the next.
      const session = makeSession();
      const state = new SessionState({ cap: null, model: null });
      const onDisplay = vi.fn();

      attachSessionEventHandler({
        session: session as never,
        state,
        role: "orchestrator",
        onDisplay,
      });

      const msg1Text = "a".repeat(THRESHOLD + 10); // 210 — crosses threshold
      const msg1Tail = "a".repeat(THRESHOLD + 20); // 220 — final for msg1
      const msg2Text = "short"; // 5 chars, no update

      // Message 1: streamed with a threshold-crossing update
      session.emit({ type: "message_start", message: textMessage("") });
      session.emit({ type: "message_update", message: textMessage(msg1Text) });
      session.emit({ type: "message_end", message: textMessage(msg1Tail) });

      // Message 2: standalone (no message_update)
      session.emit({ type: "message_start", message: textMessage("") });
      session.emit({ type: "message_end", message: textMessage(msg2Text) });

      // Message 1: chunk + tail = 2 emits
      // Message 2: full text (slice(0), not slice(lenFromMsg1)) = 1 emit
      // Total: 3 emits
      expect(onDisplay).toHaveBeenCalledTimes(3);

      // Message 1 chunk
      expect(onDisplay).toHaveBeenNthCalledWith(1, {
        role: "orchestrator",
        kind: "text",
        text: msg1Text,
      });
      // Message 1 tail
      expect(onDisplay).toHaveBeenNthCalledWith(2, {
        role: "orchestrator",
        kind: "text",
        text: msg1Tail.slice(msg1Text.length),
      });
      // Message 2 full text (not sliced by msg1's len)
      expect(onDisplay).toHaveBeenNthCalledWith(3, {
        role: "orchestrator",
        kind: "text",
        text: msg2Text,
      });
    });

    // ── Case 5 ─────────────────────────────────────────────────
    it("toolcall message_updates with no text growth emit nothing", () => {
      // What only this case pins: that a tool-call-only
      // message_update (no new text) does NOT trip a spurious
      // flush — the suffix-length guard is computed on
      // extractAssistantText output, not on event presence.
      const session = makeSession();
      const state = new SessionState({ cap: null, model: null });
      const onDisplay = vi.fn();

      attachSessionEventHandler({
        session: session as never,
        state,
        role: "orchestrator",
        onDisplay,
      });

      const text = "This is a short assistant response";

      // message_start
      session.emit({ type: "message_start", message: textMessage("") });
      // message_update with a tool_use block AND the same text
      // as the start partial (no new text) — formatted text
      // doesn't grow, so no flush
      session.emit({
        type: "message_update",
        message: {
          role: "assistant",
          content: [
            { type: "text", text },
            { type: "tool_use", name: "bash", input: { command: "ls" } },
          ],
        } as AssistantMessage,
      });
      // message_end with the same text
      session.emit({ type: "message_end", message: textMessage(text) });

      // Only one emit: the message_end tail (= full text, since
      // no threshold flush ever fired). The message_update
      // contributed 0 new chars (extractAssistantText still
      // returns the same text length), so its guard computed
      // delta < threshold.
      expect(onDisplay).toHaveBeenCalledTimes(1);
      expect(onDisplay).toHaveBeenNthCalledWith(1, {
        role: "orchestrator",
        kind: "text",
        text,
      });
    });

    // ── Case 6 ─────────────────────────────────────────────────
    it("error message_end does not flush the remainder (early-return preserved)", () => {
      // What only this case pins: the error-path early-return
      // runs before the new tail-flush — the reframed
      // message_end text block stays positioned after the
      // stopReason === "error" early-return.
      const session = makeSession();
      const state = new SessionState({ cap: null, model: null });
      const onDisplay = vi.fn();

      attachSessionEventHandler({
        session: session as never,
        state,
        role: "orchestrator",
        onDisplay,
      });

      const chunk = "a".repeat(THRESHOLD + 10); // 210 — crosses threshold
      const finalWithError = "a".repeat(THRESHOLD + 50); // longer, but never flushed because of error

      session.emit({ type: "message_start", message: textMessage("") });
      session.emit({ type: "message_update", message: textMessage(chunk) });
      session.emit({
        type: "message_end",
        message: { ...textMessage(finalWithError), stopReason: "error" } as AssistantMessage,
      });

      // Only the streamed chunk was displayed; the error message_end
      // skipped the tail flush due to early-return.
      expect(onDisplay).toHaveBeenCalledTimes(1);
      expect(onDisplay).toHaveBeenNthCalledWith(1, {
        role: "orchestrator",
        kind: "text",
        text: chunk,
      });
    });
  });
});
