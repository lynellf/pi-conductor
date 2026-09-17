import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnChildConfig } from "../../src/host/delegation/delegate-tool.js";
import type { SandboxHostApproval } from "../../src/host/execution/sandbox/host-approval.js";
import type { SandboxAdmissionRecord } from "../../src/persistence/sandbox-admission.js";
import type { SandboxProjectMaterializationDescriptor } from "../../src/persistence/sandbox-materialization.js";

const mocks = vi.hoisted(() => ({
  readAdmission: vi.fn(),
  createWorktree: vi.fn(),
  inspectWorktree: vi.fn(),
  materialize: vi.fn(),
  ingest: vi.fn(),
  fileTools: vi.fn(),
  commandTools: vi.fn(),
  createIndependentWorktree: vi.fn(),
  configureIndependentSparse: vi.fn(),
  inspectIndependentWorktree: vi.fn(),
}));
let createSandboxChildContext: typeof import("../../src/host/delegation/sandbox-child-context.js").createSandboxChildContext;

beforeEach(async () => {
  vi.resetModules();
  vi.doMock("../../src/host/execution/sandbox/admission-store.js", () => ({
    readSandboxAdmission: mocks.readAdmission,
  }));
  vi.doMock("../../src/host/execution/sandbox/trusted-git.js", () => ({
    createTrustedProjectedWorktree: mocks.createWorktree,
    inspectTrustedProjectedWorktree: mocks.inspectWorktree,
  }));
  vi.doMock("../../src/host/execution/sandbox/project-materialization.js", () => ({
    materializeSandboxProject: mocks.materialize,
  }));
  vi.doMock("../../src/host/execution/sandbox/project-ingestion.js", () => ({
    ingestSandboxProject: mocks.ingest,
  }));
  vi.doMock("../../src/host/execution/sandbox/file-tools.js", () => ({
    createSandboxFileTools: mocks.fileTools,
  }));
  vi.doMock("../../src/host/execution/sandbox/command-tools.js", () => ({
    createSandboxCommandTools: mocks.commandTools,
  }));
  vi.doMock("../../src/host/delegation/worktree.js", () => ({
    createIndependentSourceWorktree: mocks.createIndependentWorktree,
    configureExactSparseWorktree: mocks.configureIndependentSparse,
    inspectChildWorktree: mocks.inspectIndependentWorktree,
  }));

  ({ createSandboxChildContext } = await import(
    "../../src/host/delegation/sandbox-child-context.js"
  ));
});

afterEach(() => {
  vi.doUnmock("../../src/host/execution/sandbox/admission-store.js");
  vi.doUnmock("../../src/host/execution/sandbox/trusted-git.js");
  vi.doUnmock("../../src/host/execution/sandbox/project-materialization.js");
  vi.doUnmock("../../src/host/execution/sandbox/project-ingestion.js");
  vi.doUnmock("../../src/host/execution/sandbox/file-tools.js");
  vi.doUnmock("../../src/host/execution/sandbox/command-tools.js");
  vi.doUnmock("../../src/host/delegation/worktree.js");
  vi.resetModules();
});

const descriptor = {
  backend: "bubblewrap",
  execution_policy_digest: "a".repeat(64),
  runtime_digest: "b".repeat(64),
  materialization_id: "12345678-1234-4123-8123-123456789abc",
} as const;
const admission = {
  runId: "run-1",
  childId: "child-1",
  sandbox: descriptor,
  policy: { selectedPaths: ["src/a.ts", "package.json"] },
} as unknown as SandboxAdmissionRecord;
const project = {
  runId: "run-1",
  childId: "child-1",
} as unknown as SandboxProjectMaterializationDescriptor;
const worktree = {
  workTree: "/state/worktrees/child-1",
  branch: "conductor/child-1",
  baseCommit: "1".repeat(40),
};

describe("sandbox child context", () => {
  it("binds trusted projection setup and returns only the eight confined tools", async () => {
    arrange();
    const context = await createSandboxChildContext(options());
    expect(mocks.readAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRunId: "run-1",
        expectedChildId: "child-1",
        expectedSandbox: descriptor,
      }),
    );
    expect(mocks.createWorktree).toHaveBeenCalledWith({
      hostWorktreePath: "/primary",
      generatedWorktreePath: "/state/worktrees/child-1",
      generatedBranch: "conductor/child-1",
      baseCommit: "1".repeat(40),
      selectedPaths: ["src/a.ts", "package.json"],
    });
    expect(context.tools.map((tool) => tool.name)).toEqual([
      "read",
      "write",
      "edit",
      "ls",
      "find",
      "grep",
      "bash",
      "read_execution_output",
    ]);
  });

  it("materializes a source-backed sandbox child in an independent repository (#118)", async () => {
    arrange();
    const setupSignal = new AbortController().signal;
    const sourceConfig = {
      ...options(),
      config: {
        ...options().config,
        sourceWorkspace: {
          ref: `source-workspace/v1/${"d".repeat(64)}/${"e".repeat(64)}`,
          source_id: "approved-source",
          head_commit: "1".repeat(40),
          tree_id: "2".repeat(40),
          inventory_digest: "3".repeat(64),
          policy_digest: "4".repeat(64),
          audience: [{ kind: "native", profile_id: "worker" }],
        },
        sourceCheckoutPath: "/sealed/source-checkout",
        setupSignal,
      } as SpawnChildConfig,
    };

    await createSandboxChildContext(sourceConfig);

    expect(mocks.createWorktree).not.toHaveBeenCalled();
    expect(mocks.createIndependentWorktree).toHaveBeenCalledWith(
      "/state/worktrees/child-1",
      "conductor/child-1",
      "1".repeat(40),
      "/sealed/source-checkout",
      setupSignal,
    );
    expect(mocks.configureIndependentSparse).toHaveBeenCalledWith(
      "/state/worktrees/child-1",
      "conductor/child-1",
      "1".repeat(40),
      ["src/a.ts", "package.json"],
      setupSignal,
    );
  });

  it("close aborts running and future tool calls without sealing later ingestion", async () => {
    let activeSignal: AbortSignal | undefined;
    arrange({
      fileTools: [
        tool("read", async (signal) => {
          activeSignal = signal;
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
          return result("aborted");
        }),
        ...namedTools(["write", "edit", "ls", "find", "grep"]),
      ],
    });
    const context = await createSandboxChildContext(options());
    const running = call(context.tools, "read");
    await vi.waitFor(() => expect(activeSignal).toBeDefined());
    await context.closeToolAdmission();
    expect(activeSignal?.aborted).toBe(true);
    await expect(running).resolves.toMatchObject({ content: [{ text: "aborted" }] });
    await expect(call(context.tools, "write")).rejects.toThrow("tool aborted");
    expect(mocks.ingest).not.toHaveBeenCalled();
    await expect(context.ingestAndInspect()).resolves.toMatchObject({ state: "clean" });
  });

  it("derives bounded changed paths from the persisted stage and verifies Git twice", async () => {
    const paths = Array.from({ length: 70 }, (_, index) => `src/${String(index)}.ts`);
    arrange({ stagePaths: paths });
    const context = await createSandboxChildContext(options());
    const inspected = await context.ingestAndInspect();
    expect(inspected).toEqual({
      state: "changed",
      headCommit: "1".repeat(40),
      changedPathCount: 70,
      changedPaths: paths.slice(0, 64),
      changedPathsTruncated: true,
    });
    expect(mocks.inspectWorktree).toHaveBeenCalledTimes(2);
  });

  it("cancel aborts and awaits in-flight integration idempotently", async () => {
    let integrationSignal: AbortSignal | undefined;
    arrange({
      ingest: async (input) => {
        integrationSignal = input.signal;
        await new Promise<void>((_resolve, reject) =>
          input.signal.addEventListener("abort", () => reject(new Error("integration aborted"))),
        );
        throw new Error("unreachable");
      },
    });
    const context = await createSandboxChildContext(options());
    const integration = context.ingestAndInspect();
    await vi.waitFor(() => expect(integrationSignal).toBeDefined());
    await expect(context.cancel()).resolves.toBeUndefined();
    await expect(integration).rejects.toThrow("integration aborted");
    await expect(context.cancel()).resolves.toBeUndefined();
  });

  it("cancel preserves a failed final inspection after the patch was applied", async () => {
    arrange();
    const failure = new Error("Git identity changed after application");
    let rejectInspection: ((cause: unknown) => void) | undefined;
    mocks.inspectWorktree.mockImplementationOnce(async () => ({ headCommit: worktree.baseCommit }));
    mocks.inspectWorktree.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectInspection = reject;
        }),
    );
    const context = await createSandboxChildContext(options());
    const integration = context.ingestAndInspect();
    void integration.catch(() => undefined);
    await vi.waitFor(() => expect(rejectInspection).toBeDefined());
    const cancellation = context.cancel();
    rejectInspection?.(failure);
    await expect(cancellation).rejects.toBe(failure);
    await expect(integration).rejects.toBe(failure);
  });

  it("cancel surfaces an integration that crossed the apply boundary", async () => {
    let integrationSignal: AbortSignal | undefined;
    const incomplete = Object.assign(new Error("integration incomplete"), {
      integration: "integration_incomplete" as const,
    });
    arrange({
      ingest: async (input) => {
        integrationSignal = input.signal;
        await new Promise<void>((_resolve, reject) =>
          input.signal.addEventListener("abort", () => reject(incomplete)),
        );
        throw new Error("unreachable");
      },
    });
    const context = await createSandboxChildContext(options());
    const integration = context.ingestAndInspect();
    void integration.catch(() => undefined);
    await vi.waitFor(() => expect(integrationSignal).toBeDefined());
    await expect(context.cancel()).rejects.toBe(incomplete);
    await expect(integration).rejects.toBe(incomplete);
  });
});

function arrange(overrides?: {
  fileTools?: readonly ToolDefinition[];
  stagePaths?: readonly string[];
  ingest?: (input: {
    readonly signal: AbortSignal;
    readonly verifyWorktree: () => Promise<void>;
  }) => Promise<never>;
}): void {
  vi.clearAllMocks();
  mocks.readAdmission.mockResolvedValue(admission);
  mocks.createWorktree.mockResolvedValue(worktree);
  mocks.inspectWorktree.mockResolvedValue({
    branch: worktree.branch,
    headCommit: worktree.baseCommit,
  });
  mocks.materialize.mockResolvedValue(project);
  mocks.ingest.mockImplementation(
    overrides?.ingest ??
      (async (input: { readonly verifyWorktree: () => Promise<void> }) => {
        await input.verifyWorktree();
        return {
          entries: (overrides?.stagePaths ?? []).map((path) => ({ path, operation: "delete" })),
        };
      }),
  );
  mocks.fileTools.mockReturnValue(
    overrides?.fileTools ?? namedTools(["read", "write", "edit", "ls", "find", "grep"]),
  );
  mocks.commandTools.mockReturnValue(namedTools(["bash", "read_execution_output"]));
  mocks.createIndependentWorktree.mockResolvedValue(undefined);
  mocks.configureIndependentSparse.mockResolvedValue(undefined);
  mocks.inspectIndependentWorktree.mockResolvedValue({
    state: "clean",
    headCommit: worktree.baseCommit,
    changedPathCount: 0,
    changedPaths: [],
    changedPathsTruncated: false,
  });
}

function namedTools(names: readonly string[]): ToolDefinition[] {
  return names.map((name) =>
    tool(name, async (signal) => {
      if (signal.aborted) throw new Error("tool aborted");
      return result(name);
    }),
  );
}

function tool(
  name: string,
  execute: (signal: AbortSignal) => Promise<AgentToolResult<unknown>>,
): ToolDefinition {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {} },
    execute: async (_id: string, _params: unknown, signal: AbortSignal | undefined) =>
      execute(signal ?? new AbortController().signal),
  } as unknown as ToolDefinition;
}

async function call(tools: readonly ToolDefinition[], name: string) {
  const candidate = tools.find((tool) => tool.name === name);
  if (candidate === undefined) throw new Error(`missing ${name}`);
  return candidate.execute("call", {}, undefined, undefined, {} as never);
}

function result(text: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details: {} };
}

function options() {
  return {
    config: {
      childId: "child-1",
      worktreePath: "/state/worktrees/child-1",
      branch: "conductor/child-1",
      baseCommit: "1".repeat(40),
      sandbox: descriptor,
    } as unknown as SpawnChildConfig,
    runId: "run-1",
    primaryCheckout: "/primary",
    runStateDir: "/state",
    hostApproval: {
      bootstrapApproval: { approvalId: "runtime", files: [] },
    } as unknown as SandboxHostApproval,
    getController: () => null,
  };
}
