/**
 * Phase 2 Task 3 — host display forwarding.
 *
 * Updated for Phase 1 (open-issues-round-2): text no longer streams
 * progressively. One `"text"` display event is emitted per assistant
 * turn at `message_end` with the full extracted text. Tool events
 * (`tool_call` / `tool_result`) remain per-event (unchanged).
 *
 * Phase 1 (open-issues-round-3, issue #12): `tool_result` events
 * for `write` and `edit` carry an optional `files` field with
 * `{ path, additions, deletions }` entries.
 *
 * Phase 2 (open-issues-round-3, issue #13): `files[].hunks` is
 * populated for `edit` (synchronous) and `write` (async, deferred
 * ~1–5 ms). The Phase 1 integration tests for `edit` now include
 * `hunks` in their assertions.
 *
 * Pins the additive display tap on `attachSessionEventHandler`:
 * assistant text and combined tool-completed lines flow to the
 * optional display sink without changing the cost / terminal-reason
 * logic.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    sessionId: "display-session-1",
    sessionFile: "/tmp/display-session-1.jsonl",
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

// Temp directory for write-file tests (shared across describe blocks)
let tmpDir: string;
beforeEach(async () => {
  tmpDir = `${tmpdir()}/conductor-display-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await mkdir(tmpDir, { recursive: true });
});
afterEach(async () => {
  await rm(tmpDir, { force: true, recursive: true }).catch(() => {
    /* ignore cleanup errors */
  });
});

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

    expect(onDisplay).toHaveBeenCalledTimes(2);
    expect(onDisplay).toHaveBeenNthCalledWith(1, {
      role: "orchestrator",
      kind: "text",
      text: "Hello \n\n> planning the response\n\nworld",
    });
    expect(onDisplay).toHaveBeenNthCalledWith(2, {
      role: "orchestrator",
      kind: "tool_result",
      text: "✓ bash: ls",
    });
  });

  it("includes non-redacted thinking content in the text display event", () => {
    const session = makeSession();
    const state = new SessionState({ cap: null, model: null });
    const onDisplay = vi.fn();
    attachSessionEventHandler({ session: session as never, state, role: "worker", onDisplay });
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
    attachSessionEventHandler({ session: session as never, state, role: "worker", onDisplay });

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

  it("skips redacted thinking blocks", () => {
    const session = makeSession();
    const state = new SessionState({ cap: null, model: null });
    const onDisplay = vi.fn();
    attachSessionEventHandler({ session: session as never, state, role: "worker", onDisplay });
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
    attachSessionEventHandler({ session: session as never, state, role: "worker", onDisplay });
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

  it("buffers start and emits nothing until end", () => {
    const session = makeSession();
    const state = new SessionState({ cap: null, model: null });
    const onDisplay = vi.fn();
    attachSessionEventHandler({ session: session as never, state, role: "worker", onDisplay });
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
    attachSessionEventHandler({ session: session as never, state, role: "worker", onDisplay });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "call-orphan",
      toolName: "bash",
      result: "permission denied",
      isError: true,
    });
    expect(onDisplay).not.toHaveBeenCalled();
  });

  it("suppresses handoff tool events", () => {
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
    expect(onDisplay).not.toHaveBeenCalled();
  });

  it("suppresses end tool events", () => {
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
      attachSessionEventHandler({ session: session as never, state, role: "worker" }),
    ).not.toThrow();
  });

  // ─── Post-streaming (Phase 1) ──────────────────────────────────

  describe("Single-emit per turn", () => {
    function textMessage(text: string): AssistantMessage {
      return { role: "assistant", content: [{ type: "text", text }] } as AssistantMessage;
    }

    it("emits one text event per assistant turn with the full text, regardless of length", () => {
      const session = makeSession();
      const state = new SessionState({ cap: null, model: null });
      const onDisplay = vi.fn();
      attachSessionEventHandler({
        session: session as never,
        state,
        role: "orchestrator",
        onDisplay,
      });

      const longText = "a".repeat(500);
      session.emit({ type: "message_start", message: textMessage("") });
      session.emit({ type: "message_update", message: textMessage(longText) });
      session.emit({ type: "message_end", message: textMessage(longText) });

      expect(onDisplay).toHaveBeenCalledTimes(1);
      expect(onDisplay).toHaveBeenNthCalledWith(1, {
        role: "orchestrator",
        kind: "text",
        text: longText,
      });
    });

    it("emits one text event per assistant turn even without message_update", () => {
      const session = makeSession();
      const state = new SessionState({ cap: null, model: null });
      const onDisplay = vi.fn();
      attachSessionEventHandler({ session: session as never, state, role: "worker", onDisplay });

      const shortText = "Hello world";
      session.emit({ type: "message_start", message: textMessage("") });
      session.emit({ type: "message_end", message: textMessage(shortText) });

      expect(onDisplay).toHaveBeenCalledTimes(1);
      expect(onDisplay).toHaveBeenNthCalledWith(1, {
        role: "worker",
        kind: "text",
        text: shortText,
      });
    });

    it("emits no text event for empty assistant message (tool_use only)", () => {
      const session = makeSession();
      const state = new SessionState({ cap: null, model: null });
      const onDisplay = vi.fn();
      attachSessionEventHandler({
        session: session as never,
        state,
        role: "orchestrator",
        onDisplay,
      });

      session.emit({ type: "message_start", message: textMessage("") });
      session.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "bash", input: { command: "ls" } }],
        } as unknown as AssistantMessage,
      });

      const textEvents = onDisplay.mock.calls.filter(([event]) => event.kind === "text");
      expect(textEvents).toHaveLength(0);
    });

    it("tool events still emit per-event (unchanged)", () => {
      const session = makeSession();
      const state = new SessionState({ cap: null, model: null });
      const onDisplay = vi.fn();
      attachSessionEventHandler({ session: session as never, state, role: "worker", onDisplay });

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
      session.emit({
        type: "tool_execution_start",
        toolCallId: "call-2",
        toolName: "read",
        args: { path: "foo.ts" },
      });
      session.emit({
        type: "tool_execution_end",
        toolCallId: "call-2",
        toolName: "read",
        result: "file content",
        isError: false,
      });

      expect(onDisplay).toHaveBeenCalledTimes(2);
      expect(onDisplay).toHaveBeenNthCalledWith(1, {
        role: "worker",
        kind: "tool_result",
        text: "✓ bash: ls",
      });
      expect(onDisplay).toHaveBeenNthCalledWith(2, {
        role: "worker",
        kind: "tool_result",
        text: "✓ read: foo.ts",
      });
    });
  });

  // ─── Issue #12: DisplayEvent.files ──────────────────────────────

  describe("DisplayEvent.files — issue #12", () => {
    it("attaches files for a successful write tool_result", () => {
      const session = makeSession();
      const state = new SessionState({ cap: null, model: null });
      const onDisplay = vi.fn();
      attachSessionEventHandler({ session: session as never, state, role: "worker", onDisplay });
      session.emit({
        type: "tool_execution_start",
        toolCallId: "call-write",
        toolName: "write",
        args: { path: "/app/config.ts", content: "const x = 1" },
      });
      session.emit({
        type: "tool_execution_end",
        toolCallId: "call-write",
        toolName: "write",
        result: { ok: true },
        isError: false,
      });
      expect(onDisplay).toHaveBeenCalledTimes(1);
      expect(onDisplay).toHaveBeenNthCalledWith(1, {
        role: "worker",
        kind: "tool_result",
        text: "✓ write: /app/config.ts",
        // Issue #13: non-existent path → new file → all-`add` hunks
        files: [
          {
            path: "/app/config.ts",
            additions: 11,
            deletions: 0,
            hunks: [{ lineNumber: 1, content: "+const x = 1", kind: "add" }],
          },
        ],
      });
    });

    // Phase 2 update: `edit` now emits `files[].hunks` (synchronous, pure)
    it("attaches files with hunks for a successful edit tool_result with multiple edits", () => {
      const session = makeSession();
      const state = new SessionState({ cap: null, model: null });
      const onDisplay = vi.fn();
      attachSessionEventHandler({ session: session as never, state, role: "worker", onDisplay });
      session.emit({
        type: "tool_execution_start",
        toolCallId: "call-edit",
        toolName: "edit",
        args: {
          path: "/app/main.ts",
          edits: [
            { oldText: "aaa", newText: "bbbbb" },
            { oldText: "cc", newText: "d" },
          ],
        },
      });
      session.emit({
        type: "tool_execution_end",
        toolCallId: "call-edit",
        toolName: "edit",
        result: { ok: true },
        isError: false,
      });
      expect(onDisplay).toHaveBeenCalledTimes(1);
      // biome: ok — ?? never hit at runtime (toHaveBeenCalledTimes(1) guards)
      const event = onDisplay.mock.calls[0]?.[0] ?? (undefined as unknown);
      expect(event).toMatchObject({
        role: "worker",
        kind: "tool_result",
        text: "✓ edit: /app/main.ts (2 edits)",
      });
      expect(event.files).toBeDefined();
      expect(event.files).toHaveLength(1);
      expect(event.files?.[0]).toMatchObject({
        path: "/app/main.ts",
        additions: 6,
        deletions: 5,
      });
      // Phase 2: hunks are present
      expect(event.files?.[0].hunks).toBeDefined();
      expect(event.files?.[0].hunks?.length).toBeGreaterThan(0);
    });

    it("does not attach files for read/grep/find/ls (read-only tools)", () => {
      const session = makeSession();
      const state = new SessionState({ cap: null, model: null });
      const onDisplay = vi.fn();
      attachSessionEventHandler({ session: session as never, state, role: "worker", onDisplay });
      session.emit({
        type: "tool_execution_start",
        toolCallId: "call-read",
        toolName: "read",
        args: { path: "/app/main.ts" },
      });
      session.emit({
        type: "tool_execution_end",
        toolCallId: "call-read",
        toolName: "read",
        result: "file content",
        isError: false,
      });
      expect(onDisplay).toHaveBeenCalledTimes(1);
      expect(onDisplay).toHaveBeenNthCalledWith(1, {
        role: "worker",
        kind: "tool_result",
        text: "✓ read: /app/main.ts",
        // No `files` field — read is read-only
      });
      // Assert no `files` key present
      // biome: ok — ?? never hit at runtime (toHaveBeenCalledTimes(1) guards)
      const event = onDisplay.mock.calls[0]?.[0] ?? (undefined as unknown);
      expect("files" in event).toBe(false);
    });

    it("does not attach files for handoff/end/ask_user (machine tools)", () => {
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
      // handoff is suppressed entirely (no emit)
      expect(onDisplay).not.toHaveBeenCalled();
    });

    it("does not attach files for an errored tool_result", () => {
      const session = makeSession();
      const state = new SessionState({ cap: null, model: null });
      const onDisplay = vi.fn();
      attachSessionEventHandler({ session: session as never, state, role: "worker", onDisplay });
      session.emit({
        type: "tool_execution_start",
        toolCallId: "call-write-err",
        toolName: "write",
        args: { path: "/app/config.ts", content: "new content" },
      });
      session.emit({
        type: "tool_execution_end",
        toolCallId: "call-write-err",
        toolName: "write",
        result: "permission denied",
        isError: true,
      });
      expect(onDisplay).toHaveBeenCalledTimes(1);
      // biome: ok — ?? never hit at runtime (toHaveBeenCalledTimes(1) guards)
      const event = onDisplay.mock.calls[0]?.[0] ?? (undefined as unknown);
      expect(event.kind).toBe("tool_result");
      expect("files" in event).toBe(false);
    });

    it("does not attach files when args are malformed (write missing content)", () => {
      const session = makeSession();
      const state = new SessionState({ cap: null, model: null });
      const onDisplay = vi.fn();
      attachSessionEventHandler({ session: session as never, state, role: "worker", onDisplay });
      session.emit({
        type: "tool_execution_start",
        toolCallId: "call-write-bad",
        toolName: "write",
        args: { path: "/app/config.ts" }, // content missing
      });
      session.emit({
        type: "tool_execution_end",
        toolCallId: "call-write-bad",
        toolName: "write",
        result: { ok: true },
        isError: false,
      });
      expect(onDisplay).toHaveBeenCalledTimes(1);
      // biome: ok — ?? never hit at runtime (toHaveBeenCalledTimes(1) guards)
      const event = onDisplay.mock.calls[0]?.[0] ?? (undefined as unknown);
      expect(event.kind).toBe("tool_result");
      // Malformed args → extractFileMutations returns [] → field omitted
      expect("files" in event).toBe(false);
    });

    it("text events never carry files", () => {
      const session = makeSession();
      const state = new SessionState({ cap: null, model: null });
      const onDisplay = vi.fn();
      attachSessionEventHandler({ session: session as never, state, role: "worker", onDisplay });
      const msg: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
      } as AssistantMessage;
      session.emit({ type: "message_end", message: msg });
      expect(onDisplay).toHaveBeenCalledTimes(1);
      // biome: ok — ?? never hit at runtime (toHaveBeenCalledTimes(1) guards)
      const event = onDisplay.mock.calls[0]?.[0] ?? (undefined as unknown);
      expect(event.kind).toBe("text");
      expect("files" in event).toBe(false);
    });
  });
});

describe("file-mutation telemetry — issue #22", () => {
  it("persists a successful edit with role, session, and hunk context", () => {
    const session = makeSession();
    const state = new SessionState({ cap: null, model: null });
    const persist = vi.fn();
    attachSessionEventHandler({
      session: session as never,
      state,
      role: "worker",
      fileMutation: {
        runId: "run-22",
        sessionId: "display-session-1",
        sessionFile: "/tmp/display-session-1.jsonl",
        persist,
      },
    });

    session.emit({
      type: "tool_execution_start",
      toolCallId: "call-telemetry-edit",
      toolName: "edit",
      args: { path: "/app/main.ts", edits: [{ oldText: "before", newText: "after" }] },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "call-telemetry-edit",
      toolName: "edit",
      result: { ok: true },
      isError: false,
    });

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({
      type: "file_mutation",
      run_id: "run-22",
      role: "worker",
      session_id: "display-session-1",
      session_file: "/tmp/display-session-1.jsonl",
      tool_name: "edit",
      files: [
        {
          path: "/app/main.ts",
          additions: 5,
          deletions: 6,
          hunks: [
            { lineNumber: 1, content: "-before", kind: "del" },
            { lineNumber: 1, content: "+after", kind: "add" },
          ],
        },
      ],
      ts: expect.any(Number),
    });
  });

  it("does not persist failed or malformed file mutations", () => {
    const session = makeSession();
    const state = new SessionState({ cap: null, model: null });
    const persist = vi.fn();
    attachSessionEventHandler({
      session: session as never,
      state,
      role: "worker",
      fileMutation: {
        runId: "run-22",
        sessionId: "display-session-1",
        sessionFile: "/tmp/display-session-1.jsonl",
        persist,
      },
    });

    session.emit({
      type: "tool_execution_start",
      toolCallId: "call-failed-write",
      toolName: "write",
      args: { path: "/app/blocked.ts", content: "blocked" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "call-failed-write",
      toolName: "write",
      result: "permission denied",
      isError: true,
    });
    session.emit({
      type: "tool_execution_start",
      toolCallId: "call-malformed-write",
      toolName: "write",
      args: { path: "/app/incomplete.ts" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "call-malformed-write",
      toolName: "write",
      result: { ok: true },
      isError: false,
    });

    expect(persist).not.toHaveBeenCalled();
  });
});

// Flush helper: yields to the microtask queue so async handlers settle
async function _flushPromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("DisplayEvent.files[].hunks — issue #13", () => {
  it("edit tool_result emits files[].hunks synchronously", () => {
    const session = makeSession();
    const state = new SessionState({ cap: null, model: null });
    const onDisplay = vi.fn();
    attachSessionEventHandler({ session: session as never, state, role: "worker", onDisplay });
    session.emit({
      type: "tool_execution_start",
      toolCallId: "call-edit-hunks",
      toolName: "edit",
      args: {
        path: "/app/main.ts",
        edits: [{ oldText: "foo", newText: "bar" }],
      },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "call-edit-hunks",
      toolName: "edit",
      result: { ok: true },
      isError: false,
    });
    expect(onDisplay).toHaveBeenCalledTimes(1);
    // biome: ok — ?? never hit at runtime
    const event = onDisplay.mock.calls[0]?.[0] ?? (undefined as unknown);
    expect(event.kind).toBe("tool_result");
    expect(event.files).toBeDefined();
    expect(event.files?.length).toBe(1);
    expect(event.files?.[0].hunks).toBeDefined();
    expect(event.files?.[0].hunks?.length).toBe(2);
    expect(event.files?.[0].hunks?.[0]).toMatchObject({
      lineNumber: 1,
      content: "-foo",
      kind: "del",
    });
    expect(event.files?.[0].hunks?.[1]).toMatchObject({
      lineNumber: 1,
      content: "+bar",
      kind: "add",
    });
  });

  it("edit tool_result with multiple edits emits all hunks", () => {
    const session = makeSession();
    const state = new SessionState({ cap: null, model: null });
    const onDisplay = vi.fn();
    attachSessionEventHandler({ session: session as never, state, role: "worker", onDisplay });
    session.emit({
      type: "tool_execution_start",
      toolCallId: "call-edit-multi",
      toolName: "edit",
      args: {
        path: "/app/main.ts",
        edits: [
          { oldText: "aaa", newText: "bbbbb" },
          { oldText: "cc", newText: "d" },
        ],
      },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "call-edit-multi",
      toolName: "edit",
      result: { ok: true },
      isError: false,
    });
    expect(onDisplay).toHaveBeenCalledTimes(1);
    // biome: ok — ?? never hit at runtime
    const event = onDisplay.mock.calls[0]?.[0] ?? (undefined as unknown);
    expect(event.files?.[0].hunks).toBeDefined();
    // extractFileHunks: all del-lines first, then all add-lines
    // ("aaa"=1 del, "bbbbb"=1 del, "cc"=2 del, "d"=1 add) → del:[1,2,3], add:[1,2,3,4,5,6,7]
    // Per-edit interleaved: for each edit, all its dels then all its adds.
    // Each edit's oldText/newText is single-line → 1 del + 1 add per edit = 4 total.
    expect(event.files?.[0].hunks?.map((h: { kind: string }) => h.kind)).toEqual([
      "del",
      "add",
      "del",
      "add",
    ]);
  });

  // loadWriteHunksForArgs is synchronous (uses readFileSync), so the
  // hunks are available immediately at tool_execution_end — no deferral.
  it("write tool_result emits files[].hunks synchronously after disk read", async () => {
    // Create a real temp file so the disk read succeeds
    const filePath = `${tmpDir}/existing.txt`;
    await writeFile(filePath, "original\ncontent", "utf8");

    const session = makeSession();
    const state = new SessionState({ cap: null, model: null });
    const onDisplay = vi.fn();
    attachSessionEventHandler({ session: session as never, state, role: "worker", onDisplay });

    // tool_execution_start captures the pre-mutation content synchronously
    session.emit({
      type: "tool_execution_start",
      toolCallId: "call-write-hunks",
      toolName: "write",
      args: { path: filePath, content: "new\ncontent\nhere" },
    });

    // tool_execution_end emits synchronously (writeHunks already computed)
    session.emit({
      type: "tool_execution_end",
      toolCallId: "call-write-hunks",
      toolName: "write",
      result: { ok: true },
      isError: false,
    });

    // Single synchronous emission with hunks from diffing against pre-write content
    expect(onDisplay).toHaveBeenCalledTimes(1);
    // biome: ok — ?? never hit at runtime
    const event = onDisplay.mock.calls[0]?.[0] ?? (undefined as unknown);
    expect(event.kind).toBe("tool_result");
    expect(event.files).toBeDefined();
    expect(event.files?.[0].hunks).toBeDefined();
    expect(event.files?.[0].hunks?.length).toBeGreaterThan(0);
    // Hunks include both add and del (file had content)
    const kinds = event.files?.[0].hunks?.map((h: { kind: string }) => h.kind);
    expect(kinds).toContain("add");
  });

  it("read/grep/find/ls tool_results never carry hunks", () => {
    const session = makeSession();
    const state = new SessionState({ cap: null, model: null });
    const onDisplay = vi.fn();
    attachSessionEventHandler({ session: session as never, state, role: "worker", onDisplay });
    for (const toolName of ["read", "grep", "find", "ls"] as const) {
      const id = `call-${toolName}-hunks`;
      session.emit({ type: "tool_execution_start", toolCallId: id, toolName, args: {} });
      session.emit({
        type: "tool_execution_end",
        toolCallId: id,
        toolName,
        result: "ok",
        isError: false,
      });
    }
    expect(onDisplay).toHaveBeenCalledTimes(4);
    for (const call of onDisplay.mock.calls) {
      const event = call[0];
      expect("files" in event && event.files).toBeFalsy();
    }
  });

  it("text events never carry hunks", () => {
    const session = makeSession();
    const state = new SessionState({ cap: null, model: null });
    const onDisplay = vi.fn();
    attachSessionEventHandler({ session: session as never, state, role: "worker", onDisplay });
    const msg: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    } as AssistantMessage;
    session.emit({ type: "message_end", message: msg });
    expect(onDisplay).toHaveBeenCalledTimes(1);
    // biome: ok — ?? never hit at runtime
    const event = onDisplay.mock.calls[0]?.[0] ?? (undefined as unknown);
    expect(event.kind).toBe("text");
    expect("files" in event && event.files).toBeFalsy();
  });
});
