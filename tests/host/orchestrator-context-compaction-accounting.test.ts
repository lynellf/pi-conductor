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
import { createOrchestratorCompactionController } from "../../src/host/orchestrator-context-compaction.js";
import { makeStubModel, makeStubStreamFunction } from "../../src/host/stub-provider.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

const USAGE: Usage = {
  input: 17,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 22,
  cost: { input: 0.017, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.022 },
};

describe("orchestrator compaction usage aggregation", () => {
  it("keeps later known usage after an earlier unknown result", async () => {
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    const base = makeStubStreamFunction({
      steps: [
        { kind: "emit_text", text: "unknown summary" },
        { kind: "emit_text", text: "known summary" },
      ],
      usage: USAGE,
    });
    let invocation = 0;
    const streamFn = (
      model: Parameters<typeof base>[0],
      context: Parameters<typeof base>[1],
      options: Parameters<typeof base>[2],
    ): AssistantMessageEventStream => {
      const stream = base(model, context, options);
      if (invocation++ !== 0) return stream;
      const originalResult = stream.result.bind(stream);
      return new Proxy(stream, {
        get(target, property, receiver) {
          if (property === "result") {
            return async () => ({
              ...(await originalResult()),
              usage: null as unknown as Usage,
            });
          }
          return Reflect.get(target, property, receiver);
        },
      });
    };
    registry.registerProvider("stub", {
      api: "anthropic-messages",
      apiKey: "stub-key",
      streamSimple: streamFn,
    });
    const manager = SessionManager.inMemory();
    const observations: unknown[] = [];
    const controller = createOrchestratorCompactionController({
      requestId: (() => {
        let index = 0;
        return () => `compaction-${++index}`;
      })(),
      onStart: () => undefined,
      onUsage: () => undefined,
      onObservation: (observation) => {
        observations.push(observation);
      },
      streamFn,
    });
    const extension: InlineExtension = {
      name: "compaction-accounting-regression",
      factory: controller.extensionFactory,
    };
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: makeAndTrackIsolatedAgentDir("compaction-accounting-loader-"),
      extensionFactories: [extension],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const { session } = await createAgentSession({
      model: { ...makeStubModel(), contextWindow: 1_000, maxTokens: 100 },
      modelRegistry: registry,
      sessionManager: manager,
      resourceLoader: loader,
      agentDir: makeAndTrackIsolatedAgentDir("compaction-accounting-agent-"),
      noTools: "all",
    });
    manager.appendMessage({ role: "user", content: "history".repeat(30_000), timestamp: 1 });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      api: "anthropic-messages",
      provider: "stub",
      model: "stub-model",
      usage: USAGE,
      stopReason: "stop",
      timestamp: 2,
    });
    manager.appendMessage({ role: "user", content: "current".repeat(30_000), timestamp: 3 });

    await expect(session.compact()).resolves.toBeDefined();
    manager.appendMessage({
      role: "user",
      content: "second history".repeat(30_000),
      timestamp: 3,
    });
    await expect(session.compact()).resolves.toBeDefined();
    expect(observations).toHaveLength(2);
    expect(controller.getCompactionUsage()).toMatchObject({ tokens: 22, cost: 0.022 });
    session.dispose();
  });
});
