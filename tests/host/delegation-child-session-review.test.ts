import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSpawnCallback } from "../../src/host/delegation/child-session.js";
import type { SpawnChildConfig } from "../../src/host/delegation/delegate-tool.js";
import type { DelegateToolFactoryOptions } from "../../src/host/delegation/delegate-tool-factory.js";
import { DelegationManager } from "../../src/host/delegation/manager.js";

const config = {
  childId: "child-1",
  taskId: "task-1",
  profile: {
    name: "worker",
    models: [{ model: "stub:model", effort: "medium" as const }],
    max_session_cost_usd: 1,
    system_prompt: "prompt",
    completion_protocol: "minimal" as const,
  },
  objective: "objective",
  expectedOutput: "output",
  worktreePath: "/tmp/worktree",
  branch: "branch",
  baseCommit: "base",
  contextArtifacts: [],
  taskFingerprint: "1".repeat(64),
  projectionFingerprint: { kind: "exact" as const, path_count: 0, sha256: "2".repeat(64) },
  systemPrompt: "prompt",
} satisfies SpawnChildConfig;

function options(manager: DelegationManager, persisted: unknown[]): DelegateToolFactoryOptions {
  return {
    role: { name: "orchestrator", is_orchestrator: true },
    subagents: [],
    remainingChildren: 1,
    runId: "run-1",
    parentRole: "orchestrator",
    parentVisitIndex: 1,
    primaryCheckout: "/tmp/checkout",
    runStateDir: "/tmp/state",
    persistRecord: (record) => persisted.push(record),
    agentDir: "/tmp/agent",
    systemPromptRoot: "/tmp/prompts",
    modelRegistry: {} as DelegateToolFactoryOptions["modelRegistry"],
    sessionDir: "/tmp/sessions",
    manager,
  };
}

describe("child SDK session lifecycle boundary", () => {
  it("does not create or prompt a child cancelled before SDK creation", async () => {
    const manager = new DelegationManager();
    await manager.abort(config.childId);
    const persisted: unknown[] = [];
    const result = await buildSpawnCallback(options(manager, persisted))(config);
    expect(result.started).toBe(false);
    expect(result.sessionFile).toBeNull();
    expect(persisted).toEqual([]);
  });

  afterEach(() => {
    vi.doUnmock("@earendil-works/pi-coding-agent");
    vi.resetModules();
  });

  async function mockedChildSession(overrides: {
    readonly append: (record: unknown) => void;
    readonly createGate?: Promise<void>;
    readonly subscribe?: () => () => void;
    readonly abort?: () => Promise<void>;
    readonly dispose?: () => Promise<void>;
  }) {
    const session = {
      sessionFile: "/tmp/child-session.jsonl",
      subscribe: overrides.subscribe ?? (() => () => {}),
      prompt: vi.fn(async () => {}),
      abort: vi.fn(overrides.abort ?? (async () => {})),
      dispose: vi.fn(overrides.dispose ?? (async () => {})),
    };
    vi.doMock("@earendil-works/pi-coding-agent", async () => {
      const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
        "@earendil-works/pi-coding-agent",
      );
      class FakeLoader {
        async reload(): Promise<void> {}
      }
      return {
        ...actual,
        DefaultResourceLoader: FakeLoader,
        SessionManager: { create: () => ({}) },
        createAgentSession: async () => {
          if (overrides.createGate !== undefined) await overrides.createGate;
          return { session };
        },
      };
    });
    vi.resetModules();
    const childSession = await import("../../src/host/delegation/child-session.js");
    const persisted: unknown[] = [];
    const manager = new DelegationManager();
    const opts = options(manager, persisted);
    const configured = {
      ...opts,
      persistRecord: (record: unknown) => {
        persisted.push(record);
        overrides.append(record);
      },
      modelRegistry: { find: () => ({}) } as unknown as DelegateToolFactoryOptions["modelRegistry"],
    } satisfies DelegateToolFactoryOptions;
    return { childSession, configured, manager, persisted, session };
  }

  it.each([
    [
      "before",
      (records: unknown[]) => {
        records.length = 0;
        throw new Error("append failed");
      },
    ],
    [
      "after",
      (records: unknown[]) => {
        records.push("durable");
        throw new Error("ambiguous append");
      },
    ],
  ] as const)("cleans up when start persistence fails %s write", async (_mode, append) => {
    const ctx = await mockedChildSession({ append: () => append([]) });
    await expect(ctx.childSession.buildSpawnCallback(ctx.configured)(config)).rejects.toMatchObject(
      {
        name: "DelegationOwnershipError",
      },
    );
    expect(ctx.session.prompt).not.toHaveBeenCalled();
    expect(ctx.session.abort).toHaveBeenCalled();
    expect(ctx.session.dispose).toHaveBeenCalledTimes(1);
  });

  it("persists a created child before cancelling during SDK creation", async () => {
    let release!: () => void;
    const createGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ctx = await mockedChildSession({ append: () => {}, createGate });
    const pending = ctx.childSession.buildSpawnCallback(ctx.configured)(config);
    await vi.waitFor(() => expect(ctx.session.prompt).not.toHaveBeenCalled());
    await ctx.manager.abort(config.childId);
    release();
    const result = await pending;
    expect(result.started).toBe(true);
    expect(result.sessionFile).toBe("/tmp/child-session.jsonl");
    expect(ctx.persisted).toHaveLength(1);
    expect(ctx.session.abort).toHaveBeenCalled();
    expect(ctx.session.dispose).toHaveBeenCalledTimes(1);
    expect(ctx.session.prompt).not.toHaveBeenCalled();
  });

  it("attempts disposal after abort fails and reports ownership ambiguity", async () => {
    const ctx = await mockedChildSession({
      append: () => {
        throw new Error("append failed");
      },
      abort: async () => {
        throw new Error("abort failed");
      },
    });
    await expect(ctx.childSession.buildSpawnCallback(ctx.configured)(config)).rejects.toMatchObject(
      {
        name: "DelegationOwnershipError",
      },
    );
    expect(ctx.session.dispose).toHaveBeenCalledTimes(1);
  });

  it("reports disposal failure as ownership ambiguity", async () => {
    const ctx = await mockedChildSession({
      append: () => {
        throw new Error("append failed");
      },
      dispose: async () => {
        throw new Error("dispose failed");
      },
    });
    await expect(ctx.childSession.buildSpawnCallback(ctx.configured)(config)).rejects.toMatchObject(
      {
        name: "DelegationOwnershipError",
      },
    );
    expect(ctx.session.abort).toHaveBeenCalled();
    expect(ctx.session.dispose).toHaveBeenCalledTimes(1);
  });

  it("cleans up when child initialization fails after SDK creation", async () => {
    const ctx = await mockedChildSession({
      append: () => {},
      subscribe: () => {
        throw new Error("event subscription failed");
      },
    });
    await expect(ctx.childSession.buildSpawnCallback(ctx.configured)(config)).rejects.toMatchObject(
      {
        name: "DelegationOwnershipError",
      },
    );
    expect(ctx.session.prompt).not.toHaveBeenCalled();
    expect(ctx.session.abort).toHaveBeenCalledTimes(1);
    expect(ctx.session.dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects active waiters when manager cancellation cannot abort the SDK", async () => {
    const ctx = await mockedChildSession({
      append: () => {},
      abort: async () => {
        throw new Error("provider abort failed");
      },
    });
    const pending = ctx.childSession.buildSpawnCallback(ctx.configured)(config);
    await vi.waitFor(() => expect(ctx.session.prompt).toHaveBeenCalledTimes(1));
    await ctx.manager.abort(config.childId);
    await expect(pending).rejects.toMatchObject({ name: "DelegationOwnershipError" });
    expect(ctx.session.dispose).toHaveBeenCalledTimes(1);
  });
});
