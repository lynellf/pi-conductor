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
  it("forwards assistant text, tool calls, and tool results to the display sink", () => {
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
      text: "Hello \n\nplanning the response\n\nworld",
    });
    expect(onDisplay).toHaveBeenNthCalledWith(2, {
      role: "orchestrator",
      kind: "tool_call",
      text: 'bash: {"command":"ls"}',
    });
    expect(onDisplay).toHaveBeenNthCalledWith(3, {
      role: "orchestrator",
      kind: "tool_result",
      text: 'bash: {"ok":true}',
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
      text: "Hello \n\nplanning the response\n\nworld",
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
