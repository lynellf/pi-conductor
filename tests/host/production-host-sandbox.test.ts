import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxAdmissionAdapter } from "../../src/host/delegation/delegate-tool.js";
import type { SandboxHostApproval } from "../../src/host/execution/sandbox/host-approval.js";
import type { LoadedManifest } from "../../src/host/manifest.js";

const createAdmission = vi.hoisted(() => vi.fn(() => ({ capture: vi.fn(), verify: vi.fn() })));
const initializeLayout = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../src/host/delegation/sandbox-admission.js", () => ({
  createSandboxAdmissionAdapter: createAdmission,
}));
afterEach(() => {
  vi.doUnmock("../../src/host/delegation/sandbox-admission.js");
  vi.doUnmock("../../src/host/execution/sandbox/protected-run-layout.js");
  vi.resetModules();
  createAdmission.mockReset();
  initializeLayout.mockReset();
});

describe("production sandbox delegation wiring", () => {
  it("binds approval to the actual parent checkout", async () => {
    vi.resetModules();
    vi.doMock("../../src/host/delegation/sandbox-admission.js", () => ({
      createSandboxAdmissionAdapter: createAdmission,
    }));
    vi.doMock("../../src/host/execution/sandbox/protected-run-layout.js", () => ({
      initializeProtectedRunLayout: initializeLayout,
    }));
    const { createDelegateTool } = await import("../../src/host/production-host-delegation.js");
    const approval = { binaryPath: "/opt/bwrap" } as unknown as SandboxHostApproval;
    const createTool = vi.fn(async (options: Record<string, unknown>) => options);
    const loadedManifest = { manifestDir: "/manifest", manifest: {} } as unknown as LoadedManifest;
    await createDelegateTool(
      context(loadedManifest, approval, createTool),
      "parent",
      roleConfig(),
      "/projected/parent",
      1,
      1,
    );
    expect(createAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        primaryCheckout: "/projected/parent",
        manifestRoot: "/manifest",
        binaryPath: "/opt/bwrap",
      }),
    );
    expect(createTool).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxAdmission: expect.anything(),
        sandboxHostApproval: approval,
      }),
      expect.any(String),
    );
    expect(initializeLayout).not.toHaveBeenCalled();
  });

  it("initializes fixed roots only when a sandbox child is captured", async () => {
    vi.resetModules();
    const capture = vi.fn(async () => ({ sandbox: {} }));
    createAdmission.mockReturnValue({ capture, verify: vi.fn() });
    vi.doMock("../../src/host/delegation/sandbox-admission.js", () => ({
      createSandboxAdmissionAdapter: createAdmission,
    }));
    vi.doMock("../../src/host/execution/sandbox/protected-run-layout.js", () => ({
      initializeProtectedRunLayout: initializeLayout,
    }));
    const { createDelegateTool } = await import("../../src/host/production-host-delegation.js");
    const createTool = vi.fn(async (options: Record<string, unknown>) => options);
    await createDelegateTool(
      context(
        { manifestDir: "/manifest", manifest: {} } as unknown as LoadedManifest,
        { binaryPath: "/opt/bwrap" } as unknown as SandboxHostApproval,
        createTool,
      ),
      "parent",
      roleConfig(),
      "/projected/parent",
      1,
      1,
    );

    const options = createTool.mock.calls[0]?.[0] as { sandboxAdmission: SandboxAdmissionAdapter };
    await options.sandboxAdmission.capture({} as never);

    expect(initializeLayout).toHaveBeenCalledWith("/host/.pi-conductor/runs/run-1");
    expect(capture).toHaveBeenCalledOnce();
  });
});

function roleConfig() {
  return {
    name: "parent",
    tools: ["delegate"],
    delegation: { allowed_subagents: ["child"], max_children_per_session: 1, max_parallel: 1 },
  } as never;
}

function context(
  loadedManifest: LoadedManifest,
  approval: SandboxHostApproval,
  createTool: ReturnType<typeof vi.fn>,
) {
  return {
    loadedManifest,
    sandboxHostApproval: approval,
    runId: "run-1",
    cwd: "/host",
    agentDir: "/agent",
    sessionDir: "/sessions",
    modelRegistry: {} as never,
    displaySink: undefined,
    log: {} as never,
    delegation: { createTool } as never,
    runCostSoFar: () => 0,
    persistRecord: () => {},
    adaptDelegateToolResult: (result: unknown) => result as never,
  };
}
