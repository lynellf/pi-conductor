import type { AssistantMessageEventStream, Usage } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  compact,
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

  it("lets the public hook call exported compact with a local metered stream", async () => {
    const auth = AuthStorage.inMemory();
    const registry = ModelRegistry.inMemory(auth);
    const nativeCalls: number[] = [];
    registry.registerProvider("stub", {
      api: "anthropic-messages",
      apiKey: "stub-key",
      streamSimple: () => {
        nativeCalls.push(1);
        throw new Error("native provider must not be used by hook compaction");
      },
    });
    const usages: Usage[] = [];
    const local = meteredStream(
      makeStubStreamFunction({
        steps: [{ kind: "emit_text", text: "hook summary" }],
        usage: CANNED_USAGE,
      }),
      usages,
    );
    const manager = SessionManager.inMemory();
    const extension: InlineExtension = {
      name: "exported-compact-meter-spike",
      factory: (pi) => {
        pi.on("session_before_compact", async (event, context) => {
          if (!context.model) throw new Error("hook did not receive the active model");
          const result = await compact(
            event.preparation,
            context.model,
            undefined,
            undefined,
            event.customInstructions,
            event.signal,
            undefined,
            local.stream,
          );
          return { compaction: result };
        });
      },
    };
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: makeAndTrackIsolatedAgentDir("pi-context-exported-compact-"),
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
      agentDir: makeAndTrackIsolatedAgentDir("pi-context-exported-agent-"),
      noTools: "all",
    });
    seedHistory(manager);

    await expect(session.compact()).resolves.toMatchObject({ summary: "hook summary" });
    expect(nativeCalls).toHaveLength(0);
    expect(local.attempts()).toBe(1);
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({ totalTokens: 22 });
    session.dispose();
  });

  it("records nonzero usage from a failed final assistant response and diagnoses unknown usage", async () => {
    const auth = AuthStorage.inMemory();
    const registry = ModelRegistry.inMemory(auth);
    const usages: Usage[] = [];
    const local = meteredStream(
      makeStubStreamFunction({
        steps: [{ kind: "fail", errorMessage: "summary quota exhausted", usage: CANNED_USAGE }],
      }),
      usages,
    );
    registry.registerProvider("stub", {
      api: "anthropic-messages",
      apiKey: "stub-key",
      streamSimple: () => {
        throw new Error("native provider must not be used");
      },
    });
    const manager = SessionManager.inMemory();
    let diagnostic: string | undefined;
    const extension: InlineExtension = {
      name: "failed-compact-meter-spike",
      factory: (pi) => {
        pi.on("session_before_compact", async (event, context) => {
          if (!context.model) throw new Error("hook did not receive the active model");
          try {
            await compact(
              event.preparation,
              context.model,
              undefined,
              undefined,
              undefined,
              event.signal,
              undefined,
              local.stream,
            );
          } catch (_error: unknown) {
            const usage = usages[0];
            diagnostic = usage?.totalTokens
              ? `failed-after-${usage.totalTokens}-tokens`
              : "unknown-usage";
            return { cancel: true };
          }
          return { cancel: true };
        });
      },
    };
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: makeAndTrackIsolatedAgentDir("pi-context-failed-compact-"),
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
      agentDir: makeAndTrackIsolatedAgentDir("pi-context-failed-agent-"),
      noTools: "all",
    });
    seedHistory(manager);

    await expect(session.compact()).rejects.toThrow();
    expect(local.attempts()).toBe(1);
    expect(usages).toHaveLength(1);
    expect(usages[0]?.totalTokens).toBe(22);
    expect(diagnostic).toBe("failed-after-22-tokens");
    session.dispose();
  });

  it("reopens the durable tip without changing the restored branch", async () => {
    const sessionDir = makeAndTrackIsolatedAgentDir("pi-context-durable-session-");
    const manager = SessionManager.create(process.cwd(), sessionDir);
    const first = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "first answer" }],
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
      timestamp: 2,
    });
    const tip = manager.appendMessage({ role: "user", content: "tip", timestamp: 3 });
    const sessionFile = manager.getSessionFile();
    if (!sessionFile) throw new Error("expected durable session file");
    const reopened = SessionManager.open(sessionFile);
    expect(first).not.toBe(tip);
    expect(reopened.getLeafId()).toBe(tip);
    expect(reopened.getBranch().map((entry) => entry.id)).toContain(tip);
    const { session } = await createAgentSession({
      model: { ...makeStubModel(), id: "override-model", name: "Override Model" },
      sessionManager: reopened,
      agentDir: makeAndTrackIsolatedAgentDir("pi-context-restored-model-"),
      noTools: "all",
    });
    expect(session.model?.id).toBe("override-model");
    const modelOverrideTip = reopened.getLeafId();
    expect(modelOverrideTip).not.toBe(tip);
    const restoredBranch = reopened.getBranch();
    expect(restoredBranch.map((entry) => entry.id)).toContain(tip);
    session.dispose();
  });
});
