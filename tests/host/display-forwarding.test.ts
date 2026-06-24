/**
 * Phase 2 Task 3 — host display forwarding.
 *
 * Pins the additive display tap on `attachSessionEventHandler`:
 * assistant text, tool calls, and tool results flow to the optional
 * display sink without changing the cost / terminal-reason logic.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { SessionState } from "../../src/host/cost.js";
import { attachSessionEventHandler } from "../../src/host/session-event-handler.js";

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
  it("forwards assistant text, compact tool summaries, and success/error indicators to the display sink", () => {
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

    expect(onDisplay).toHaveBeenCalledTimes(3);
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
    // Compact tool summary (formatToolCallSummary):
    // "bash: ls" instead of the old JSON flood
    expect(onDisplay).toHaveBeenNthCalledWith(2, {
      role: "orchestrator",
      kind: "tool_call",
      text: "bash: ls",
    });
    // Success indicator (formatToolResultSummary):
    // "✓" instead of the old JSON flood
    expect(onDisplay).toHaveBeenNthCalledWith(3, {
      role: "orchestrator",
      kind: "tool_result",
      text: "✓",
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

  it("forwards tool_error with a ✗ <first line> indicator for error results", () => {
    const session = makeSession();
    const state = new SessionState({ cap: null, model: null });
    const onDisplay = vi.fn();

    attachSessionEventHandler({
      session: session as never,
      state,
      role: "worker",
      onDisplay,
    });

    // Multi-line string error result
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
      text: "✗ permission denied",
    });
  });

  it("forwards tool_error with an object result coerced to ✗ <first line>", () => {
    const session = makeSession();
    const state = new SessionState({ cap: null, model: null });
    const onDisplay = vi.fn();

    attachSessionEventHandler({
      session: session as never,
      state,
      role: "worker",
      onDisplay,
    });

    // Object result (Open concern A): the error path stringifies
    // the object and takes the first line.
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
      text: expect.stringMatching(/^✗ /),
    });
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
});
