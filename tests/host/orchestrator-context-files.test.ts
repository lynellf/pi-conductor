import { readFile, writeFile } from "node:fs/promises";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  captureOrchestratorContextBoundary,
  restoreOrchestratorContextBoundary,
} from "../../src/host/orchestrator-context-files.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

function appendAssistant(manager: SessionManager, text: string, timestamp: number): string {
  return manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "stub",
    model: "stub-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  });
}

function appendToolExchange(manager: SessionManager, timestamp: number): void {
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name: "old_tool", arguments: {} }],
    api: "anthropic-messages",
    provider: "stub",
    model: "stub-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp,
  });
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "old_tool",
    content: [{ type: "text", text: "historical result" }],
    isError: false,
    timestamp: timestamp + 1,
  });
}

async function makeSessionFile(): Promise<{ manager: SessionManager; file: string; tip: string }> {
  const directory = makeAndTrackIsolatedAgentDir("pi-context-files-source-");
  const manager = SessionManager.create(process.cwd(), directory);
  manager.appendMessage({ role: "user", content: "history", timestamp: 1 });
  appendAssistant(manager, "answer", 2);
  const tip = manager.appendMessage({ role: "user", content: "committed boundary", timestamp: 3 });
  appendAssistant(manager, "settled answer", 4);
  const file = manager.getSessionFile();
  if (!file) throw new Error("expected persisted session file");
  return { manager, file, tip: manager.getLeafId() ?? tip };
}

describe("orchestrator context session file boundary", () => {
  it("captures a deterministic exact branch and restores it into a new file", async () => {
    const source = await makeSessionFile();
    const boundary = await captureOrchestratorContextBoundary({
      roleSessionId: "role-session-1",
      sessionFile: source.file,
      conversationId: source.manager.getSessionId(),
      leafId: source.tip,
    });
    const sourceBytes = await readFile(source.file);
    const restored = await restoreOrchestratorContextBoundary({
      boundary: boundary.reference,
      destinationSessionDir: makeAndTrackIsolatedAgentDir("pi-context-files-destination-"),
      cwd: process.cwd(),
    });

    expect(boundary.reference.conversation_id).toBe(source.manager.getSessionId());
    expect(boundary.reference.history_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(restored.manager.getLeafId()).toBe(source.tip);
    expect((await readFile(source.file)).equals(sourceBytes)).toBe(true);
    expect(restored.manager.buildSessionContext().messages).toHaveLength(4);
  });

  it("excludes an uncommitted suffix and rejects a changed source hash", async () => {
    const source = await makeSessionFile();
    const boundary = await captureOrchestratorContextBoundary({
      roleSessionId: "role-session-2",
      sessionFile: source.file,
      conversationId: source.manager.getSessionId(),
      leafId: source.tip,
    });
    appendAssistant(source.manager, "uncommitted suffix", 5);
    const restored = await restoreOrchestratorContextBoundary({
      boundary: boundary.reference,
      destinationSessionDir: makeAndTrackIsolatedAgentDir("pi-context-files-suffix-"),
      cwd: process.cwd(),
    });
    expect(
      restored.manager
        .buildSessionContext()
        .messages.some(
          (message) =>
            message.role === "assistant" &&
            message.content[0]?.type === "text" &&
            message.content[0].text === "uncommitted suffix",
        ),
    ).toBe(false);

    await expect(
      restoreOrchestratorContextBoundary({
        boundary: { ...boundary.reference, history_sha256: "0".repeat(64) },
        destinationSessionDir: makeAndTrackIsolatedAgentDir("pi-context-files-tamper-"),
        cwd: process.cwd(),
      }),
    ).rejects.toMatchObject({ code: "hash_mismatch" });
  });

  it.each([
    ["broken JSON", "{not-json\n", "malformed_jsonl"],
    ["wrong header", '{"type":"message"}\n', "invalid_header"],
  ])("rejects %s before SDK parsing", async (_label, content, code) => {
    const file = `${makeAndTrackIsolatedAgentDir("pi-context-files-invalid-")}/session.jsonl`;
    await writeFile(file, content, "utf8");
    await expect(
      captureOrchestratorContextBoundary({
        roleSessionId: "role-session-3",
        sessionFile: file,
        conversationId: "conversation",
        leafId: "missing",
      }),
    ).rejects.toMatchObject({ code });
  });

  it("rejects duplicate IDs, broken parents, and unresolved tool calls", async () => {
    const source = await makeSessionFile();
    const original = await readFile(source.file, "utf8");
    const records = original
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const entry = records[records.length - 1];
    if (!entry) throw new Error("expected session entry");
    await writeFile(
      source.file,
      `${original}${JSON.stringify({ ...entry, id: entry.id })}\n`,
      "utf8",
    );
    await expect(
      captureOrchestratorContextBoundary({
        roleSessionId: "role-session-4",
        sessionFile: source.file,
        conversationId: source.manager.getSessionId(),
        leafId: source.tip,
      }),
    ).rejects.toMatchObject({ code: "duplicate_id" });

    const unresolvedRecords = original
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const finalEntry = unresolvedRecords[unresolvedRecords.length - 1];
    if (
      finalEntry?.type !== "message" ||
      typeof finalEntry.message !== "object" ||
      finalEntry.message === null
    ) {
      throw new Error("expected final assistant message");
    }
    finalEntry.message = {
      ...(finalEntry.message as Record<string, unknown>),
      content: [{ type: "toolCall", id: "unresolved-call", name: "old_tool", arguments: {} }],
    };
    await writeFile(
      source.file,
      `${unresolvedRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    await expect(
      captureOrchestratorContextBoundary({
        roleSessionId: "role-session-4",
        sessionFile: source.file,
        conversationId: source.manager.getSessionId(),
        leafId: source.tip,
      }),
    ).rejects.toMatchObject({ code: "unresolved_tool_call" });
  });

  it.each([
    ["unknown tip", "unknown-tip", "unknown_tip"],
    ["wrong conversation", "wrong-conversation", "hash_mismatch"],
    ["wrong version", "version", "invalid_header"],
    ["broken parent", "broken-parent", "broken_parent_chain"],
    ["cyclic parent", "cycle", "cyclic_parent_chain"],
  ])("rejects %s before selecting a boundary", async (_label, mutation, code) => {
    const source = await makeSessionFile();
    const records = (await readFile(source.file, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    let conversationId = source.manager.getSessionId();
    let leafId = source.tip;
    if (mutation === "version") records[0] = { ...records[0], version: 2 };
    if (mutation === "broken-parent") records[1] = { ...records[1], parentId: "missing-parent" };
    if (mutation === "cycle") records[1] = { ...records[1], parentId: source.tip };
    if (mutation === "wrong-conversation") conversationId = "wrong-conversation";
    if (mutation === "unknown-tip") leafId = "unknown-tip";
    if (mutation !== "unknown-tip" && mutation !== "wrong-conversation") {
      await writeFile(
        source.file,
        `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
        "utf8",
      );
    }
    await expect(
      captureOrchestratorContextBoundary({
        roleSessionId: "role-session-table",
        sessionFile: source.file,
        conversationId,
        leafId,
      }),
    ).rejects.toMatchObject({ code });
  });

  it("accepts complete tool exchanges and compaction-visible history at an exact tip", async () => {
    const directory = makeAndTrackIsolatedAgentDir("pi-context-files-paired-");
    const manager = SessionManager.create(process.cwd(), directory);
    manager.appendMessage({ role: "user", content: "old request", timestamp: 1 });
    appendToolExchange(manager, 2);
    const kept = manager.appendMessage({ role: "user", content: "kept request", timestamp: 4 });
    manager.appendCompaction("old request summary", kept, 100);
    manager.appendMessage({ role: "user", content: "current request", timestamp: 6 });
    appendAssistant(manager, "current answer", 7);
    const file = manager.getSessionFile();
    const tip = manager.getLeafId();
    if (!file || !tip) throw new Error("expected persisted compacted session");
    const boundary = await captureOrchestratorContextBoundary({
      roleSessionId: "role-session-paired",
      sessionFile: file,
      conversationId: manager.getSessionId(),
      leafId: tip,
    });
    const restored = await restoreOrchestratorContextBoundary({
      boundary: boundary.reference,
      destinationSessionDir: makeAndTrackIsolatedAgentDir("pi-context-files-paired-destination-"),
      cwd: process.cwd(),
    });
    const messages = restored.manager.buildSessionContext().messages;
    expect(messages.some((message) => message.role === "compactionSummary")).toBe(true);
    expect(
      messages.some((message) => message.role === "toolResult" && message.toolCallId === "call-1"),
    ).toBe(false);
    const records = (await readFile(file, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const compaction = records.find((record) => record.type === "compaction");
    if (!compaction) throw new Error("expected compaction entry");
    compaction.firstKeptEntryId = tip;
    await writeFile(
      file,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    await expect(
      captureOrchestratorContextBoundary({
        roleSessionId: "future-compaction",
        sessionFile: file,
        conversationId: manager.getSessionId(),
        leafId: tip,
      }),
    ).rejects.toMatchObject({ code: "broken_parent_chain" });
  });

  it.each([
    "duplicate call id",
    "orphan result",
    "interleaved user message",
  ])("rejects %s in the selected provider context", async (caseName) => {
    const directory = makeAndTrackIsolatedAgentDir("pi-context-files-pairing-invalid-");
    const manager = SessionManager.create(process.cwd(), directory);
    manager.appendMessage({ role: "user", content: "request", timestamp: 1 });
    if (caseName === "orphan result") {
      manager.appendMessage({
        role: "toolResult",
        toolCallId: "orphan",
        toolName: "old_tool",
        content: [{ type: "text", text: "orphan" }],
        isError: false,
        timestamp: 2,
      });
    } else {
      manager.appendMessage({
        role: "assistant",
        content:
          caseName === "duplicate call id"
            ? [
                { type: "toolCall", id: "same", name: "old_tool", arguments: {} },
                { type: "toolCall", id: "same", name: "old_tool", arguments: {} },
              ]
            : [{ type: "toolCall", id: "interleaved", name: "old_tool", arguments: {} }],
        api: "anthropic-messages",
        provider: "stub",
        model: "stub-model",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 2,
      });
      if (caseName === "interleaved user message") {
        manager.appendMessage({ role: "user", content: "interleaved", timestamp: 3 });
      }
    }
    if (caseName !== "orphan result") {
      manager.appendMessage({
        role: "toolResult",
        toolCallId: caseName === "duplicate call id" ? "same" : "interleaved",
        toolName: "old_tool",
        content: [{ type: "text", text: "result" }],
        isError: false,
        timestamp: 4,
      });
    }
    const tip = appendAssistant(manager, "settled", 5);
    const file = manager.getSessionFile();
    if (!file) throw new Error("expected persisted pairing fixture");
    await expect(
      captureOrchestratorContextBoundary({
        roleSessionId: "role-session-pairing-invalid",
        sessionFile: file,
        conversationId: manager.getSessionId(),
        leafId: tip,
      }),
    ).rejects.toMatchObject({ code: "unresolved_tool_call" });
  });

  it.each([
    "negative token usage",
    "non-boolean tool error",
  ])("rejects %s message shape before provider context use", async (caseName) => {
    const source = await makeSessionFile();
    if (caseName === "negative token usage") {
      const records = (await readFile(source.file, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const finalEntry = records[records.length - 1];
      if (
        finalEntry?.type !== "message" ||
        typeof finalEntry.message !== "object" ||
        finalEntry.message === null
      )
        throw new Error("expected final message");
      const message = finalEntry.message as Record<string, unknown>;
      message.usage = { ...(message.usage as Record<string, unknown>), input: -1 };
      await writeFile(
        source.file,
        `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
        "utf8",
      );
      await expect(
        captureOrchestratorContextBoundary({
          roleSessionId: "shape",
          sessionFile: source.file,
          conversationId: source.manager.getSessionId(),
          leafId: source.tip,
        }),
      ).rejects.toMatchObject({ code: "invalid_entry" });
      return;
    }
    appendToolExchange(source.manager, 5);
    appendAssistant(source.manager, "after tool", 7);
    const records = (await readFile(source.file, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const resultEntry = records.find(
      (record) =>
        record.type === "message" &&
        typeof record.message === "object" &&
        record.message !== null &&
        (record.message as Record<string, unknown>).role === "toolResult",
    );
    if (!resultEntry || typeof resultEntry.message !== "object" || resultEntry.message === null)
      throw new Error("expected tool result");
    (resultEntry.message as Record<string, unknown>).isError = "false";
    await writeFile(
      source.file,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    await expect(
      captureOrchestratorContextBoundary({
        roleSessionId: "shape",
        sessionFile: source.file,
        conversationId: source.manager.getSessionId(),
        leafId: source.manager.getLeafId() ?? "",
      }),
    ).rejects.toMatchObject({ code: "invalid_entry" });
  });

  it("accepts valid empty text and thinking blocks", async () => {
    const directory = makeAndTrackIsolatedAgentDir("pi-context-files-empty-blocks-");
    const manager = SessionManager.create(process.cwd(), directory);
    manager.appendMessage({ role: "user", content: "empty blocks", timestamp: 1 });
    manager.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "" },
        { type: "thinking", thinking: "" },
      ],
      api: "anthropic-messages",
      provider: "stub",
      model: "stub-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    const file = manager.getSessionFile();
    const tip = manager.getLeafId();
    if (!file || !tip) throw new Error("expected empty-block session");
    await expect(
      captureOrchestratorContextBoundary({
        roleSessionId: "empty",
        sessionFile: file,
        conversationId: manager.getSessionId(),
        leafId: tip,
      }),
    ).resolves.toBeDefined();
  });

  it.each(["missing", "non-finite"])("rejects %s message timestamps", async (kind) => {
    const source = await makeSessionFile();
    const records = (await readFile(source.file, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const finalEntry = records[records.length - 1];
    if (
      finalEntry?.type !== "message" ||
      typeof finalEntry.message !== "object" ||
      finalEntry.message === null
    )
      throw new Error("expected final message");
    const message = finalEntry.message as Record<string, unknown>;
    if (kind === "missing") delete message.timestamp;
    else message.timestamp = -1;
    await writeFile(
      source.file,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    await expect(
      captureOrchestratorContextBoundary({
        roleSessionId: "timestamp",
        sessionFile: source.file,
        conversationId: source.manager.getSessionId(),
        leafId: source.tip,
      }),
    ).rejects.toMatchObject({ code: "invalid_entry" });
  });

  it("rejects a tool result whose name does not match its call", async () => {
    const source = await makeSessionFile();
    appendToolExchange(source.manager, 5);
    appendAssistant(source.manager, "after tool", 7);
    const records = (await readFile(source.file, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const resultEntry = records.find(
      (record) =>
        record.type === "message" &&
        typeof record.message === "object" &&
        record.message !== null &&
        (record.message as Record<string, unknown>).role === "toolResult",
    );
    if (!resultEntry || typeof resultEntry.message !== "object" || resultEntry.message === null)
      throw new Error("expected tool result");
    (resultEntry.message as Record<string, unknown>).toolName = "different_tool";
    await writeFile(
      source.file,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    await expect(
      captureOrchestratorContextBoundary({
        roleSessionId: "tool-name",
        sessionFile: source.file,
        conversationId: source.manager.getSessionId(),
        leafId: source.manager.getLeafId() ?? "",
      }),
    ).rejects.toMatchObject({ code: "unresolved_tool_call" });
  });
});
