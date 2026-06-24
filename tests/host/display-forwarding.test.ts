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
});
