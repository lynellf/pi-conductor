import { readFile, writeFile } from "node:fs/promises";

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { OrchestratorContextCoordinator } from "../../src/host/orchestrator-context-coordinator.js";
import { InMemoryRecordLog } from "../../src/persistence/log.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

function appendUser(manager: SessionManager, text: string, timestamp: number): string {
  return manager.appendMessage({ role: "user", content: text, timestamp });
}

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

async function makeAttachment() {
  const log = new InMemoryRecordLog();
  const runId = `context-coordinator-${Math.random()}`;
  const coordinator = new OrchestratorContextCoordinator({
    log,
    persistRecord: (record) => log.append(record),
    runId,
    role: "orchestrator",
    sessionDir: makeAndTrackIsolatedAgentDir("pi-context-coordinator-session-"),
    cwd: process.cwd(),
    agentDir: makeAndTrackIsolatedAgentDir("pi-context-coordinator-agent-"),
    compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 1 },
  });
  const prepared = await coordinator.prepare();
  const manager = prepared.sessionManager;
  appendUser(manager, "existing history", 1);
  appendAssistant(manager, "history answer", 2);
  const sessionFile = manager.getSessionFile();
  if (sessionFile === undefined) throw new Error("expected a session file");
  const attachment = coordinator.attach(prepared, {
    roleSessionId: "role-session",
    conversationId: manager.getSessionId(),
    sessionFile,
    model: null,
  });
  return { attachment, log, manager, runId, sessionFile };
}

describe("orchestrator context coordinator seed provenance", () => {
  it("requires the first new user message to equal the delivered seed", async () => {
    const { attachment, log, manager, runId } = await makeAttachment();

    await expect(
      attachment.prompt("seed", async () => {
        appendUser(manager, "mutated seed", 2);
        appendUser(manager, "seed", 3);
      }),
    ).rejects.toThrow("did not append its seed message");
    expect(
      log.records(runId).filter((record) => record.type === "context_delivery_committed"),
    ).toHaveLength(0);
  });

  it("records the first matching leaf when later user text repeats the seed", async () => {
    const { attachment, log, manager, runId } = await makeAttachment();
    const firstSeedLeaf = appendUser(manager, "seed", 2);
    appendUser(manager, "seed", 3);

    await attachment.prompt("seed", async () => undefined);

    const delivery = log
      .records(runId)
      .find((record) => record.type === "context_delivery_committed");
    if (delivery?.type !== "context_delivery_committed") {
      throw new Error("expected a committed delivery");
    }
    expect(delivery.leaf_id).toBe(firstSeedLeaf);
  });

  it("rechecks the exact delivered seed on the captured boundary branch", async () => {
    const { attachment, manager, sessionFile } = await makeAttachment();
    appendUser(manager, "seed", 2);
    appendAssistant(manager, "answer", 3);
    await attachment.prompt("seed", async () => undefined);

    const records = (await readFile(sessionFile, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const seedRecord = records.find(
      (record) =>
        record.type === "message" &&
        typeof record.message === "object" &&
        record.message !== null &&
        (record.message as { role?: unknown }).role === "user" &&
        (record.message as { content?: unknown }).content === "seed",
    );
    if (!seedRecord || typeof seedRecord.message !== "object" || seedRecord.message === null) {
      throw new Error("expected persisted seed message");
    }
    seedRecord.message = {
      ...(seedRecord.message as Record<string, unknown>),
      content: "tampered",
    };
    await writeFile(
      sessionFile,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );

    await expect(attachment.retainedContext.captureBoundary()).rejects.toThrow(
      "does not match the delivered seed",
    );
  });
});
