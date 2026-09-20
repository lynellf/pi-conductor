import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnChildConfig } from "../../src/host/delegation/delegate-tool.js";
import type { DelegateToolFactoryOptions } from "../../src/host/delegation/delegate-tool-factory.js";
import { DelegationManager } from "../../src/host/delegation/manager.js";
import { pinVerificationRecipe } from "../../src/manifest/verification-recipes.js";

const config = {
  childId: "child-1",
  taskId: "task-1",
  profile: {
    name: "worker",
    models: [{ model: "stub:model", effort: "medium" as const }],
    max_session_cost_usd: 1,
    system_prompt: "prompt",
    completion_protocol: "minimal" as const,
    execution: { backend: "bubblewrap" as const, runtime_root: "runtime", writable_paths: [] },
  },
  objective: "objective",
  expectedOutput: "output",
  worktreePath: "/state/worktrees/child-1",
  branch: "conductor/child-1",
  baseCommit: "a".repeat(40),
  contextArtifacts: [],
  taskFingerprint: "1".repeat(64),
  projectionFingerprint: { kind: "exact" as const, path_count: 1, sha256: "2".repeat(64) },
  sandbox: {
    backend: "bubblewrap" as const,
    execution_policy_digest: "3".repeat(64),
    runtime_digest: "4".repeat(64),
    materialization_id: "550e8400-e29b-41d4-a716-446655440000",
  },
  systemPrompt: "prompt",
} satisfies SpawnChildConfig;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("@earendil-works/pi-coding-agent");
  vi.doUnmock("../../src/host/delegation/sandbox-child-context.js");
  vi.resetModules();
});

describe("sandbox child SDK lifecycle", () => {
  it("uses only private sandbox tools, settles them, ingests, then disposes", async () => {
    const events: string[] = [];
    const tools = [
      "read",
      "grep",
      "find",
      "ls",
      "edit",
      "write",
      "bash",
      "read_execution_output",
    ].map((name) => ({ name }) as ToolDefinition);
    const context = {
      tools,
      closeToolAdmission: vi.fn(async () => {
        events.push("close-tools");
      }),
      cancel: vi.fn(async () => {
        events.push("cancel");
      }),
      ingestAndInspect: vi.fn(async () => {
        events.push("ingest");
        return {
          state: "changed" as const,
          headCommit: config.baseCommit,
          changedPathCount: 1,
          changedPaths: ["src/a.ts"],
          changedPathsTruncated: false,
        };
      }),
    };
    vi.doMock("../../src/host/delegation/sandbox-child-context.js", () => ({
      createSandboxChildContext: vi.fn(async () => context),
    }));
    let subscriber: ((event: AgentSessionEvent) => void) | undefined;
    let createOptions: { tools?: string[]; customTools?: ToolDefinition[] } | undefined;
    const session = {
      sessionFile: "/state/session.jsonl",
      subscribe: (listener: (event: AgentSessionEvent) => void) => {
        subscriber = listener;
        return () => {};
      },
      prompt: vi.fn(async (text: string) => {
        expect(text).toContain("/workspace");
        subscriber?.({ type: "agent_end", willRetry: false } as AgentSessionEvent);
      }),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(async () => {
        events.push("dispose");
      }),
    };
    vi.doMock("@earendil-works/pi-coding-agent", async () => {
      const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
        "@earendil-works/pi-coding-agent",
      );
      return {
        ...actual,
        DefaultResourceLoader: class {
          async reload(): Promise<void> {}
        },
        SessionManager: { create: () => ({}) },
        createAgentSession: async (options: typeof createOptions) => {
          createOptions = options;
          return { session };
        },
      };
    });
    const { buildSpawnCallback } = await import("../../src/host/delegation/child-session.js");
    const result = await buildSpawnCallback(options(new DelegationManager()))(config);

    expect(createOptions?.tools).toEqual(tools.map((tool) => tool.name));
    expect(createOptions?.customTools).toEqual(tools);
    expect(result.worktreeInspection).toMatchObject({ state: "changed", changedPathCount: 1 });
    expect(events).toEqual(["close-tools", "ingest", "dispose"]);
  });

  it("passes the exact projected SDK names plus completion protocol", async () => {
    const events: string[] = [];
    const tools = ["read", "verify"].map((name) => ({ name }) as ToolDefinition);
    const context = {
      ...sandboxContext(events),
      tools,
    };
    vi.doMock("../../src/host/delegation/sandbox-child-context.js", () => ({
      createSandboxChildContext: vi.fn(async () => context),
    }));
    let createOptions: { tools?: string[]; customTools?: ToolDefinition[] } | undefined;
    const session = mockSession(events, true);
    vi.doMock("@earendil-works/pi-coding-agent", async () => {
      const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
        "@earendil-works/pi-coding-agent",
      );
      return {
        ...actual,
        DefaultResourceLoader: class {
          async reload(): Promise<void> {}
        },
        SessionManager: { create: () => ({}) },
        createAgentSession: async (options: typeof createOptions) => {
          createOptions = options;
          return { session };
        },
      };
    });
    const { buildSpawnCallback } = await import("../../src/host/delegation/child-session.js");
    const configured = {
      ...config,
      profile: { ...config.profile, completion_protocol: "report_result" as const },
      effectiveTools: ["read", "verify"] as const,
      verificationRecipe: pinVerificationRecipe({
        name: "focused",
        commands: [{ executable: "/usr/bin/test", args: [] }],
        evaluation: "report_only",
        required_paths: ["package.json"],
        timeout_seconds: 10,
        max_calls: 1,
      }),
    } satisfies SpawnChildConfig;
    const result = await buildSpawnCallback(options(new DelegationManager()))(configured);
    expect(createOptions?.tools).toEqual(["read", "verify", "report_result"]);
    expect(createOptions?.customTools?.map((tool) => tool.name)).toEqual([
      "read",
      "verify",
      "report_result",
    ]);
    expect(result.worktreeInspection).toMatchObject({ state: "no_changes" });
  });

  it("cancels and settles sandbox ownership before disposal when start persistence fails", async () => {
    const events: string[] = [];
    const context = sandboxContext(events);
    vi.doMock("../../src/host/delegation/sandbox-child-context.js", () => ({
      createSandboxChildContext: vi.fn(async () => context),
    }));
    const session = mockSession(events);
    mockSdk(session);
    const { buildSpawnCallback } = await import("../../src/host/delegation/child-session.js");
    const opts = options(new DelegationManager());
    const spawn = buildSpawnCallback({
      ...opts,
      persistRecord: () => {
        throw new Error("append uncertain");
      },
    });

    await expect(spawn(config)).rejects.toThrow("start persistence is ambiguous");
    expect(events).toEqual(["cancel", "sdk-abort", "close-tools", "dispose"]);
  });

  it("marks the child cancelled when cancellation races with completed integration", async () => {
    const events: string[] = [];
    let finishIngest: (() => void) | undefined;
    const ingestStarted = new Promise<void>((resolve) => {
      finishIngest = resolve;
    });
    let releaseIngest: (() => void) | undefined;
    const context = sandboxContext(events, async () => {
      finishIngest?.();
      await new Promise<void>((resolve) => {
        releaseIngest = resolve;
      });
    });
    vi.doMock("../../src/host/delegation/sandbox-child-context.js", () => ({
      createSandboxChildContext: vi.fn(async () => context),
    }));
    const session = mockSession(events, true);
    mockSdk(session);
    const manager = new DelegationManager();
    const { buildSpawnCallback } = await import("../../src/host/delegation/child-session.js");
    const resultPromise = buildSpawnCallback(options(manager))(config);
    await ingestStarted;

    const abortPromise = manager.abort(config.childId);
    releaseIngest?.();
    await abortPromise;
    const result = await resultPromise;

    expect(result.cancelled).toBe(true);
    expect(result.sessionError).toBe("child cancelled during sandbox integration");
    expect(events).toEqual(["close-tools", "ingest", "cancel", "sdk-abort", "dispose"]);
  });

  it("preserves incomplete integration as an ownership failure during cancellation", async () => {
    const events: string[] = [];
    const manager = new DelegationManager();
    const incomplete = Object.assign(new Error("partial apply"), {
      integration: "integration_incomplete",
    });
    const context = sandboxContext(events, async () => {
      await manager.abort(config.childId);
      throw incomplete;
    });
    context.cancel.mockRejectedValue(incomplete);
    vi.doMock("../../src/host/delegation/sandbox-child-context.js", () => ({
      createSandboxChildContext: vi.fn(async () => context),
    }));
    mockSdk(mockSession(events, true));
    const { buildSpawnCallback } = await import("../../src/host/delegation/child-session.js");
    await expect(buildSpawnCallback(options(manager))(config)).rejects.toThrow(
      "cancelled sandbox integration cleanup is ambiguous",
    );
    expect(context.cancel).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toBe("dispose");
  });

  it("retains manager ownership while SDK disposal is pending", async () => {
    const events: string[] = [];
    const context = sandboxContext(events);
    vi.doMock("../../src/host/delegation/sandbox-child-context.js", () => ({
      createSandboxChildContext: vi.fn(async () => context),
    }));
    const session = mockSession(events, true);
    let finishDisposal: (() => void) | undefined;
    session.dispose.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDisposal = resolve;
        }),
    );
    mockSdk(session);
    const manager = new DelegationManager();
    const { buildSpawnCallback } = await import("../../src/host/delegation/child-session.js");
    const result = buildSpawnCallback(options(manager))(config);
    await vi.waitFor(() => expect(finishDisposal).toBeDefined());
    await manager.abortAll();
    expect(context.cancel).toHaveBeenCalledOnce();
    expect(session.abort).toHaveBeenCalledOnce();
    finishDisposal?.();
    await result;
  });

  it("surfaces tool-admission cleanup failure after cancelling owned sandbox work", async () => {
    const events: string[] = [];
    const context = sandboxContext(events);
    context.closeToolAdmission.mockImplementationOnce(async () => {
      events.push("close-tools");
      throw new Error("gate settlement uncertain");
    });
    vi.doMock("../../src/host/delegation/sandbox-child-context.js", () => ({
      createSandboxChildContext: vi.fn(async () => context),
    }));
    const session = mockSession(events, true);
    mockSdk(session);
    const { buildSpawnCallback } = await import("../../src/host/delegation/child-session.js");

    await expect(buildSpawnCallback(options(new DelegationManager()))(config)).rejects.toThrow(
      "tool admission cleanup failed",
    );
    expect(events).toEqual(["close-tools", "cancel", "dispose"]);
  });
});

function sandboxContext(events: string[], waitDuringIngest?: () => Promise<void>) {
  const tools = [
    "read",
    "grep",
    "find",
    "ls",
    "edit",
    "write",
    "bash",
    "read_execution_output",
  ].map((name) => ({ name }) as ToolDefinition);
  return {
    tools,
    closeToolAdmission: vi.fn(async () => {
      events.push("close-tools");
    }),
    cancel: vi.fn(async () => {
      events.push("cancel");
    }),
    ingestAndInspect: vi.fn(async () => {
      events.push("ingest");
      await waitDuringIngest?.();
      return { state: "no_changes" as const, headCommit: config.baseCommit };
    }),
  };
}

function mockSession(events: string[], finishOnPrompt = false) {
  let subscriber: ((event: AgentSessionEvent) => void) | undefined;
  return {
    sessionFile: "/state/session.jsonl",
    subscribe: (listener: (event: AgentSessionEvent) => void) => {
      subscriber = listener;
      return () => {};
    },
    prompt: vi.fn(async () => {
      if (finishOnPrompt)
        subscriber?.({ type: "agent_end", willRetry: false } as AgentSessionEvent);
    }),
    abort: vi.fn(async () => {
      events.push("sdk-abort");
    }),
    dispose: vi.fn(async () => {
      events.push("dispose");
    }),
  };
}

function mockSdk(session: ReturnType<typeof mockSession>): void {
  vi.doMock("@earendil-works/pi-coding-agent", async () => {
    const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
      "@earendil-works/pi-coding-agent",
    );
    return {
      ...actual,
      DefaultResourceLoader: class {
        async reload(): Promise<void> {}
      },
      SessionManager: { create: () => ({}) },
      createAgentSession: async () => ({ session }),
    };
  });
}

function options(manager: DelegationManager): DelegateToolFactoryOptions {
  return {
    role: { name: "orchestrator", is_orchestrator: true },
    subagents: [],
    remainingChildren: 1,
    runId: "run",
    parentRole: "orchestrator",
    parentVisitIndex: 1,
    primaryCheckout: "/checkout",
    runStateDir: "/state",
    persistRecord: () => {},
    agentDir: "/agent",
    systemPromptRoot: "/prompts",
    modelRegistry: { find: () => ({}) } as unknown as DelegateToolFactoryOptions["modelRegistry"],
    sessionDir: "/sessions",
    manager,
    sandboxHostApproval: {} as NonNullable<DelegateToolFactoryOptions["sandboxHostApproval"]>,
  };
}
