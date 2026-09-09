import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantMessageEventStream,
  SimpleStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  type InlineExtension,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  type CompactionObservation,
  createOrchestratorCompactionController,
} from "../../src/host/orchestrator-context-compaction.js";
import {
  captureCompactionSettings,
  createPinnedCompactionSettings,
} from "../../src/host/orchestrator-context-settings.js";
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

function seedHistory(manager: SessionManager): void {
  for (let index = 0; index < 4; index += 1) {
    manager.appendMessage({
      role: "user",
      content: `old ${index} ${"x".repeat(10_000)}`,
      timestamp: index,
    });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `old answer ${index}` }],
      api: "anthropic-messages",
      provider: "stub",
      model: "stub-model",
      usage: { ...USAGE, totalTokens: 5000, cost: { ...USAGE.cost, total: 0 } },
      stopReason: "stop",
      timestamp: index,
    });
  }
  manager.appendMessage({ role: "user", content: `current ${"y".repeat(100_000)}`, timestamp: 99 });
}

async function createFixture(
  streamFn: Parameters<typeof createOrchestratorCompactionController>[0]["streamFn"],
  observations: CompactionObservation[],
  usages: Array<Usage | null>,
  options: {
    readonly requestId?: () => string;
    readonly onUsage?: (usage: Usage | null) => void;
    readonly onStart?: (start: { readonly requestId: string }) => void | Promise<void>;
  } = {},
) {
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  const base = makeStubStreamFunction({
    steps: [{ kind: "emit_text", text: "summary" }],
    usage: USAGE,
  });
  registry.registerProvider("stub", {
    api: "anthropic-messages",
    apiKey: "stub-key",
    streamSimple: base,
  });
  const manager = SessionManager.inMemory();
  const controller = createOrchestratorCompactionController({
    requestId: options.requestId ?? (() => "compaction-1"),
    onStart: (start) => options.onStart?.(start),
    onUsage: (_requestId, usage) => {
      usages.push(usage);
      options.onUsage?.(usage);
    },
    onObservation: (observation) => {
      observations.push(observation);
    },
    ...(streamFn === undefined ? {} : { streamFn }),
  });
  const extension: InlineExtension = {
    name: "orchestrator-context-compaction",
    factory: controller.extensionFactory,
  };
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: makeAndTrackIsolatedAgentDir("orchestrator-context-loader-"),
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
    agentDir: makeAndTrackIsolatedAgentDir("orchestrator-context-agent-"),
    noTools: "all",
  });
  seedHistory(manager);
  return { controller, manager, session };
}

describe("orchestrator context compaction controller", () => {
  it("meters the public SDK compaction stream and emits before/after tips", async () => {
    const observations: CompactionObservation[] = [];
    const usages: Array<Usage | null> = [];
    const fixture = await createFixture(undefined, observations, usages);
    await expect(fixture.session.compact()).resolves.toMatchObject({ summary: "summary" });
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({ totalTokens: 22 });
    expect(observations).toHaveLength(1);
    expect(observations[0]?.usage).toMatchObject({ tokens: 22 });
    expect(observations[0]?.afterTip).toBeDefined();
    fixture.controller.assertHealthy();
    fixture.session.dispose();
  });

  it("cancels and sticks an actionable error when the stream cannot produce usage", async () => {
    const observations: CompactionObservation[] = [];
    const usages: Array<Usage | null> = [];
    const throwing = (): AssistantMessageEventStream => {
      throw new Error("provider unavailable");
    };
    const fixture = await createFixture(throwing, observations, usages);
    await expect(fixture.session.compact()).rejects.toThrow();
    expect(usages).toEqual([null]);
    expect(fixture.controller.getStickyError()?.message).toContain("compaction");
    expect(observations.at(-1)?.usage).toBeNull();
    fixture.session.dispose();
  });

  it("retains nonzero usage from a failed assistant response", async () => {
    const observations: CompactionObservation[] = [];
    const usages: Array<Usage | null> = [];
    const failing = makeStubStreamFunction({
      steps: [{ kind: "fail", errorMessage: "provider rejected compaction" }],
      usage: USAGE,
    });
    const fixture = await createFixture(failing, observations, usages);
    await expect(fixture.session.compact()).rejects.toThrow();
    expect(usages).toEqual([USAGE]);
    expect(observations.at(-1)?.usage).toMatchObject({ tokens: 22, cost: 0.022 });
    fixture.session.dispose();
  });

  it("forwards the effective thinking level into the public stream", async () => {
    const observations: CompactionObservation[] = [];
    const usages: Array<Usage | null> = [];
    const seen: SimpleStreamOptions[] = [];
    const base = makeStubStreamFunction({
      steps: [{ kind: "emit_text", text: "summary" }],
      usage: USAGE,
    });
    const forwarding = (
      model: Parameters<typeof base>[0],
      context: Parameters<typeof base>[1],
      options?: SimpleStreamOptions,
    ) => {
      seen.push(options ?? {});
      return base(model, context, options);
    };
    const fixture = await createFixture(forwarding, observations, usages);
    await expect(fixture.session.compact()).resolves.toMatchObject({ summary: "summary" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeDefined();
    fixture.session.dispose();
  });

  it("pins all compaction fields without changing project settings bytes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orchestrator-context-settings-"));
    const agentDir = await mkdtemp(join(tmpdir(), "orchestrator-context-agent-"));
    const projectDir = join(cwd, ".pi");
    await mkdir(projectDir, { recursive: true });
    const settingsPath = join(projectDir, "settings.json");
    await writeFile(
      settingsPath,
      '{"compaction":{"enabled":true,"reserveTokens":12,"keepRecentTokens":34}}\n',
    );
    const before = await readFile(settingsPath);
    try {
      const settings = createPinnedCompactionSettings(cwd, agentDir, {
        enabled: false,
        reserveTokens: 321,
        keepRecentTokens: 654,
      });
      expect(captureCompactionSettings(settings)).toEqual({
        enabled: false,
        reserveTokens: 321,
        keepRecentTokens: 654,
      });
      expect(await readFile(settingsPath)).toEqual(before);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("cancels request identity and usage callback failures", async () => {
    const observations: CompactionObservation[] = [];
    const usages: Array<Usage | null> = [];
    const requestFailure = await createFixture(undefined, observations, usages, {
      requestId: () => {
        throw new Error("request identity unavailable");
      },
    });
    await expect(requestFailure.session.compact()).rejects.toThrow();
    expect(requestFailure.controller.getStickyError()?.cause).toBeInstanceOf(Error);
    requestFailure.session.dispose();

    const callbackFailure = await createFixture(undefined, observations, usages, {
      onUsage: () => {
        throw new Error("meter sink unavailable");
      },
    });
    await expect(callbackFailure.session.compact()).rejects.toThrow();
    expect(callbackFailure.controller.getStickyError()?.message).toContain("observation");
    callbackFailure.session.dispose();
  });

  it("waits for durable start acknowledgement and cancels when it is rejected", async () => {
    const observations: CompactionObservation[] = [];
    const usages: Array<Usage | null> = [];
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deferred = await createFixture(undefined, observations, usages, {
      onStart: async () => started,
    });
    const compacting = deferred.session.compact();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(usages).toHaveLength(0);
    release();
    await expect(compacting).resolves.toMatchObject({ summary: "summary" });
    deferred.session.dispose();

    observations.length = 0;
    const rejected = await createFixture(undefined, observations, usages, {
      onStart: async () => {
        throw new Error("durable start rejected");
      },
    });
    await expect(rejected.session.compact()).rejects.toThrow();
    expect(rejected.controller.getStickyError()?.cause).toBeInstanceOf(Error);
    expect(observations).toHaveLength(0);
    rejected.session.dispose();
  });

  it("meters both sequential split-summary streams and preserves the first charge on failure", async () => {
    const observations: CompactionObservation[] = [];
    const usages: Array<Usage | null> = [];
    const base = makeStubStreamFunction({
      steps: [
        { kind: "emit_text", text: "summary one" },
        { kind: "fail", errorMessage: "prefix summary failed" },
      ],
      usage: USAGE,
    });
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    registry.registerProvider("stub", {
      api: "anthropic-messages",
      apiKey: "stub-key",
      streamSimple: base,
    });
    const manager = SessionManager.inMemory();
    const beforeHandlers: Array<
      (event: SessionBeforeCompactEvent, context: ExtensionContext) => Promise<unknown>
    > = [];
    const afterHandlers: Array<
      (event: SessionCompactEvent, context: ExtensionContext) => Promise<void>
    > = [];
    const controller = createOrchestratorCompactionController({
      requestId: () => "split-1",
      onStart: () => undefined,
      onUsage: (_chargeId, usage) => usages.push(usage),
      onObservation: (observation) => {
        observations.push(observation);
      },
    });
    const fakePi = {
      getThinkingLevel: () => "medium" as const,
      on: (event: string, handler: unknown) => {
        if (event === "session_before_compact")
          beforeHandlers.push(
            handler as (
              event: SessionBeforeCompactEvent,
              context: ExtensionContext,
            ) => Promise<unknown>,
          );
        if (event === "session_compact")
          afterHandlers.push(
            handler as (event: SessionCompactEvent, context: ExtensionContext) => Promise<void>,
          );
      },
    } as unknown as ExtensionAPI;
    controller.extensionFactory(fakePi);
    const context = {
      model: makeStubModel(),
      modelRegistry: registry,
      sessionManager: manager,
      abort: () => undefined,
    } as unknown as ExtensionContext;
    const preparation = {
      firstKeptEntryId: "kept",
      messagesToSummarize: [{ role: "user", content: "old", timestamp: 1 }],
      turnPrefixMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "prefix" }],
          api: "anthropic-messages",
          provider: "stub",
          model: "stub-model",
          usage: USAGE,
          stopReason: "stop",
          timestamp: 2,
        },
      ],
      isSplitTurn: true,
      tokensBefore: 100,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 10, keepRecentTokens: 10 },
    } as SessionBeforeCompactEvent["preparation"];
    const result = await beforeHandlers[0]?.(
      {
        type: "session_before_compact",
        preparation,
        branchEntries: [],
        reason: "manual",
        willRetry: false,
        signal: new AbortController().signal,
      },
      context,
    );
    expect(result).toMatchObject({ cancel: true });
    expect(usages).toEqual([USAGE, USAGE]);
    expect(observations.at(-1)?.usage).toMatchObject({ tokens: 44, cost: 0.044 });
    expect(afterHandlers).toHaveLength(1);

    const successObservations: CompactionObservation[] = [];
    const successBase = makeStubStreamFunction({
      steps: [
        { kind: "emit_text", text: "summary one" },
        { kind: "emit_text", text: "summary two" },
      ],
      usage: USAGE,
    });
    const successController = createOrchestratorCompactionController({
      requestId: () => "split-success",
      onStart: () => undefined,
      onUsage: () => undefined,
      onObservation: (observation) => {
        successObservations.push(observation);
      },
      streamFn: successBase,
    });
    beforeHandlers.length = 0;
    afterHandlers.length = 0;
    successController.extensionFactory(fakePi);
    const successResult = await beforeHandlers[0]?.(
      {
        type: "session_before_compact",
        preparation,
        branchEntries: [],
        reason: "manual",
        willRetry: false,
        signal: new AbortController().signal,
      },
      context,
    );
    expect(successResult).toMatchObject({ compaction: { summary: expect.any(String) } });
    await successController.settle();
    expect(successController.getStickyError()?.message).toContain("did not commit");
    const observationsBeforeLateEvent = successObservations.length;
    await afterHandlers[0]?.(
      {
        type: "session_compact",
        compactionEntry: {
          type: "compaction",
          id: "late",
          parentId: null,
          timestamp: new Date().toISOString(),
          summary: "late",
          firstKeptEntryId: "kept",
          tokensBefore: 100,
        },
        fromExtension: true,
        reason: "manual",
        willRetry: false,
      },
      context,
    );
    expect(successObservations).toHaveLength(observationsBeforeLateEvent);
  });
});
