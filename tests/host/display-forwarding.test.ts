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
      { type: "thinking", thinking: "not shown" },
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
      text: "Hello world",
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
