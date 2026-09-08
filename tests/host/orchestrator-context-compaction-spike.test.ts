import type { AssistantMessageEventStream, Usage } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  type InlineExtension,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { makeStubModel, makeStubStreamFunction } from "../../src/host/stub-provider.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

const CANNED_USAGE: Partial<Usage> = {
  input: 17,
  output: 5,
  totalTokens: 22,
  cost: { input: 0.017, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.022 },
};

function seedHistory(manager: SessionManager): void {
  for (let index = 0; index < 5; index += 1) {
    manager.appendMessage({
      role: "user",
      content: `historical user turn ${index} ${"x".repeat(10_000)}`,
      timestamp: index,
    });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `historical assistant turn ${index}` }],
      api: "anthropic-messages",
      provider: "stub",
      model: "stub-model",
      usage: {
        input: 100,
        output: 25,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 30_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: index,
    });
  }
  manager.appendMessage({
    role: "user",
    content: `current turn ${"y".repeat(100_000)}`,
    timestamp: 99,
  });
}

function meteredStream(base: ReturnType<typeof makeStubStreamFunction>, usages: Usage[]) {
  let attempts = 0;
  const stream = (
    model: Parameters<typeof base>[0],
    context: Parameters<typeof base>[1],
    options: Parameters<typeof base>[2],
  ): AssistantMessageEventStream => {
    attempts += 1;
    const result = base(model, context, options);
    void result.result().then((message) => usages.push(message.usage));
    return result;
  };
  return { stream, attempts: () => attempts };
}

describe("orchestrator context compaction SDK spike", () => {
  it("runs the public before hook and native compact path, metering only the new summary request", async () => {
    const auth = AuthStorage.inMemory();
    const registry = ModelRegistry.inMemory(auth);
    const usages: Usage[] = [];
    const observed: Array<{ reason: string; tokensBefore: number; messageCount: number }> = [];
    const base = makeStubStreamFunction({
      steps: [{ kind: "emit_text", text: "native summary" }],
      usage: CANNED_USAGE,
    });
    const measured = meteredStream(base, usages);
    registry.registerProvider("stub", {
      api: "anthropic-messages",
      apiKey: "stub-key",
      streamSimple: measured.stream,
    });

    const manager = SessionManager.inMemory();
    const extension: InlineExtension = {
      name: "compaction-meter-spike",
      factory: (pi) => {
        pi.on("session_before_compact", (event) => {
          observed.push({
            reason: event.reason,
            tokensBefore: event.preparation.tokensBefore,
            messageCount: event.preparation.messagesToSummarize.length,
          });
        });
      },
    };
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: makeAndTrackIsolatedAgentDir("pi-context-compaction-spike-"),
      extensionFactories: [extension],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const { session } = await createAgentSession({
      model: makeStubModel(),
      modelRegistry: registry,
      sessionManager: manager,
      resourceLoader: loader,
      agentDir: makeAndTrackIsolatedAgentDir("pi-context-compaction-agent-"),
      noTools: "all",
    });
    seedHistory(manager);

    await expect(session.compact()).resolves.toMatchObject({ summary: "native summary" });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ reason: "manual" });
    expect(observed[0]?.messageCount).toBeGreaterThan(0);
    expect(measured.attempts()).toBe(1);
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({ input: 17, output: 5, totalTokens: 22 });
    expect(usages[0]?.totalTokens).not.toBe(125);

    session.dispose();
  });

  it("surfaces provider failure while the metering boundary still records the attempted compaction", async () => {
    const auth = AuthStorage.inMemory();
    const registry = ModelRegistry.inMemory(auth);
    let attempts = 0;
    const failingStream = () => {
      attempts += 1;
      throw new Error("compaction provider unavailable");
    };
    registry.registerProvider("stub", {
      api: "anthropic-messages",
      apiKey: "stub-key",
      streamSimple: failingStream,
    });
    const manager = SessionManager.inMemory();
    const { session } = await createAgentSession({
      model: makeStubModel(),
      modelRegistry: registry,
      sessionManager: manager,
      agentDir: makeAndTrackIsolatedAgentDir("pi-context-compaction-failure-"),
      noTools: "all",
    });
    seedHistory(manager);

    await expect(session.compact()).rejects.toThrow("compaction provider unavailable");
    expect(attempts).toBe(1);
    expect(manager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
    session.dispose();
  });
});
