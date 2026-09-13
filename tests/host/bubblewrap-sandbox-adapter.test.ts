import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentProfile } from "../../src/manifest/types.js";

const mocks = vi.hoisted(() => ({
  pin: vi.fn(),
  capture: vi.fn(),
  read: vi.fn(),
  probe: vi.fn(),
}));

vi.mock("../../src/host/execution/sandbox/policy-pin.js", () => ({
  pinSandboxPolicy: mocks.pin,
}));
vi.mock("../../src/host/execution/sandbox/admission-store.js", () => ({
  captureSandboxAdmission: mocks.capture,
  readSandboxAdmission: mocks.read,
}));
vi.mock("../../src/host/execution/sandbox/probe-runner.js", () => ({
  runSandboxCapabilityProbe: mocks.probe,
}));

afterAll(() => {
  vi.doUnmock("../../src/host/execution/sandbox/policy-pin.js");
  vi.doUnmock("../../src/host/execution/sandbox/admission-store.js");
  vi.doUnmock("../../src/host/execution/sandbox/probe-runner.js");
  vi.resetModules();
});

let createSandboxAdmissionAdapter: typeof import("../../src/host/delegation/sandbox-admission.js").createSandboxAdmissionAdapter;

const sandbox = {
  backend: "bubblewrap" as const,
  execution_policy_digest: "1".repeat(64),
  runtime_digest: "2".repeat(64),
  materialization_id: "12345678-1234-4123-8123-123456789abc",
};
const admission = { runId: "run-1", childId: "child-1", sandbox };

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.pin.mockReturnValue({ digest: "policy" });
  mocks.capture.mockResolvedValue(admission);
  mocks.read.mockResolvedValue(admission);
  mocks.probe.mockResolvedValue({});
  ({ createSandboxAdmissionAdapter } = await import(
    "../../src/host/delegation/sandbox-admission.js"
  ));
});

describe("host-owned sandbox admission adapter", () => {
  it("rejects inconsistent host checkout protection at construction", () => {
    const value = options();
    value.hostProtection.primaryCheckout = "/other";
    expect(() => createSandboxAdmissionAdapter(value)).toThrow("host protection");
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("pins, captures, and probes before returning sandbox authority", async () => {
    const adapter = createSandboxAdmissionAdapter(options());
    const result = await adapter.capture(captureInput());
    expect(result).toEqual({ sandbox });
    expect(mocks.capture.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.probe.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.probe).toHaveBeenCalledWith(expect.objectContaining({ admission }));
  });

  it("does not return authority when the fixed capability probe fails", async () => {
    mocks.probe.mockRejectedValue(new Error("probe rejected"));
    const adapter = createSandboxAdmissionAdapter(options());
    await expect(adapter.capture(captureInput())).rejects.toThrow("probe rejected");
  });

  it("rejects cross-run and cross-checkout capture before host I/O", async () => {
    const adapter = createSandboxAdmissionAdapter(options());
    await expect(adapter.capture({ ...captureInput(), runId: "other" })).rejects.toThrow("run");
    await expect(adapter.capture({ ...captureInput(), primaryCheckout: "/other" })).rejects.toThrow(
      "checkout",
    );
    expect(mocks.pin).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("requires explicit execution authority before pinning", async () => {
    const adapter = createSandboxAdmissionAdapter(options());
    const { execution: _execution, ...withoutExecution } = profile();
    await expect(adapter.capture({ ...captureInput(), profile: withoutExecution })).rejects.toThrow(
      "explicit profile execution",
    );
    expect(mocks.pin).not.toHaveBeenCalled();
  });

  it("reopens retained authority and refreshes the probe without manifest input", async () => {
    const adapter = createSandboxAdmissionAdapter(options());
    await adapter.verify({ childId: "child-1", sandbox });
    expect(mocks.read).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRunId: "run-1",
        expectedChildId: "child-1",
        expectedSandbox: sandbox,
      }),
    );
    expect(mocks.probe).toHaveBeenCalledWith(expect.objectContaining({ admission }));
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("copies host approvals so caller mutation cannot alter later authority", async () => {
    const mutable = options();
    const adapter = createSandboxAdmissionAdapter(mutable);
    const approvedFile = mutable.bootstrapApproval.files[0];
    if (approvedFile === undefined) throw new Error("fixture approval missing");
    approvedFile.sha256 = "f".repeat(64);
    mutable.approvedBuilds.splice(0);
    mutable.hostProtection.stateRoots[0] = "/changed";
    await adapter.capture(captureInput());
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        bootstrapApproval: expect.objectContaining({
          files: [expect.objectContaining({ sha256: "a".repeat(64) })],
        }),
        hostProtection: expect.objectContaining({ stateRoots: ["/state"] }),
      }),
    );
    expect(mocks.probe).toHaveBeenCalledWith(
      expect.objectContaining({ approvedBuilds: [expect.any(Object)] }),
    );
  });
});

function options() {
  return {
    runId: "run-1",
    runStateDir: "/state/run-1",
    primaryCheckout: "/checkout",
    manifestRoot: "/checkout",
    hostProtection: {
      primaryCheckout: "/checkout",
      stateRoots: ["/state"],
      childWorkspaceRoots: [] as string[],
    },
    bootstrapApproval: {
      approvalId: "runtime",
      files: [{ path: "bin/bash", sha256: "a".repeat(64) }],
    },
    binaryPath: "/opt/bwrap",
    approvedBuilds: [
      {
        kind: "upstream-release" as const,
        release: "0.12.0",
        binaryIdentity: identity(),
        sha256: "c".repeat(64),
        approvalId: "bwrap",
      },
    ],
    probeApproval: { approvalId: "probe", sha256: "b".repeat(64) },
  };
}

function captureInput() {
  return {
    childId: "child-1",
    runId: "run-1",
    primaryCheckout: "/checkout",
    profile: profile(),
    selectedPaths: ["src/a.ts"],
    trackedPaths: ["src/a.ts"],
    projectionRoots: ["src"],
  };
}

function profile(): SubagentProfile {
  return {
    name: "worker",
    models: [{ model: "provider/model", effort: "medium" }],
    max_session_cost_usd: 1,
    system_prompt: "worker.md",
    completion_protocol: "report_result",
    execution: { backend: "bubblewrap", runtime_root: ".pi/runtime", writable_paths: [] },
  };
}

function identity() {
  return {
    device: 1,
    inode: 2,
    mode: 0o100755,
    uid: 0,
    gid: 0,
    size: 1,
    mtimeMs: 1,
    ctimeMs: 1,
  };
}
