/**
 * Issue #112: parent SDK retry settlement must clear only the transient
 * provider error recorded by the preceding assistant `message_end`.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { SessionState } from "../../src/host/cost.js";
import {
  attachSessionEventHandler,
  createCaptureRejector,
} from "../../src/host/session-event-handler.js";

function makeSession() {
  let listener: ((event: unknown) => void) | undefined;
  return {
    abort: vi.fn().mockResolvedValue(undefined),
    subscribe(fn: (event: unknown) => void) {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    emit(event: unknown) {
      listener?.(event);
    },
  };
}

function errorMessage(opts?: { cost?: number; timestamp?: number }): AssistantMessage {
  const cost = opts?.cost ?? 0.25;
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    content: [],
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    },
    stopReason: "error",
    errorMessage: "WebSocket idle timeout",
    timestamp: opts?.timestamp ?? 1,
  } as AssistantMessage;
}

function attach(state: SessionState) {
  const session = makeSession();
  attachSessionEventHandler({ session: session as never, state, role: "orchestrator" });
  return session;
}

describe("issue #112 parent SDK retry handling", () => {
  it("clears a retry-confirmed model error so later parent work can hand off while retaining failed-attempt usage", () => {
    const state = new SessionState({ cap: 10, model: "openai-codex:gpt-5.6-sol" });
    const rejector = createCaptureRejector();
    rejector.bindState(state);
    const session = attach(state);

    session.emit({ type: "message_end", message: errorMessage() });
    expect(state.terminalReason).toBe("model_error");

    // The SDK emits this after the failed assistant message, only once its
    // retry policy has accepted the attempt.
    session.emit({ type: "agent_end", messages: [], willRetry: true });
    session.emit({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: {},
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "read",
      result: {},
      isError: false,
    });

    expect(state.terminalReason).toBeNull();
    expect(state.failureDetail).toBeNull();
    expect(state.usage()).toMatchObject({ tokens: 15, cost: 0.25 });
    expect(rejector.shouldRejectCapture()).toBe(false);
  });

  it.each([
    ["non-retrying", false],
    ["exhausted", false],
  ] as const)("retains model_error when the SDK has %s settled", (_state, willRetry) => {
    const state = new SessionState({ cap: 10, model: null });
    const session = attach(state);

    session.emit({ type: "message_end", message: errorMessage() });
    session.emit({ type: "agent_end", messages: [], willRetry });

    expect(state.terminalReason).toBe("model_error");
    expect(state.failureDetail).toBe("WebSocket idle timeout");
  });

  it.each([
    "session_cost_cap_exceeded",
    "user_aborted",
    "tool_timeout_exhausted",
    "tool_cleanup_unconfirmed",
  ] as const)("does not clear a %s terminal cause when the SDK commits to retry", (reason) => {
    const state = new SessionState({ cap: 10, model: null });
    const session = attach(state);

    state.setTerminalReason(reason, `${reason} detail`);
    session.emit({ type: "agent_end", messages: [], willRetry: true });

    expect(state.terminalReason).toBe(reason);
    expect(state.failureDetail).toBe(`${reason} detail`);
  });

  it.each([
    "session_cost_cap_exceeded",
    "user_aborted",
    "tool_timeout_exhausted",
    "tool_cleanup_unconfirmed",
  ] as const)("does not let a later provider error replace an existing %s cause", (reason) => {
    const state = new SessionState({ cap: 10, model: null });
    const session = attach(state);

    state.setTerminalReason(reason, `${reason} detail`);
    session.emit({ type: "message_end", message: errorMessage() });

    expect(state.terminalReason).toBe(reason);
    expect(state.failureDetail).toBe(`${reason} detail`);
  });

  it("clears a superseded model-error diagnostic when a later failed attempt reaches the cost cap", () => {
    const state = new SessionState({ cap: 1, model: null });
    const session = attach(state);

    session.emit({ type: "message_end", message: errorMessage({ cost: 0.25, timestamp: 1 }) });
    session.emit({ type: "message_end", message: errorMessage({ cost: 0.75, timestamp: 2 }) });

    expect(state.terminalReason).toBe("session_cost_cap_exceeded");
    expect(state.failureDetail).toBeNull();
  });

  it("keeps retry state isolated to the parent invocation that received the SDK event", () => {
    const firstState = new SessionState({ cap: 10, model: null });
    const secondState = new SessionState({ cap: 10, model: null });
    const first = attach(firstState);
    const second = attach(secondState);

    first.emit({ type: "message_end", message: errorMessage({ timestamp: 1 }) });
    second.emit({ type: "message_end", message: errorMessage({ timestamp: 2 }) });
    first.emit({ type: "agent_end", messages: [], willRetry: true });

    expect(firstState.terminalReason).toBeNull();
    expect(secondState.terminalReason).toBe("model_error");
  });
});
