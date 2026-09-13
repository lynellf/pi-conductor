import { describe, expect, it, vi } from "vitest";
import { SandboxProcessObservationError } from "../../src/host/execution/sandbox/process-observation.js";
import {
  inspectSandboxCleanup,
  type SandboxRecoveryReader,
} from "../../src/host/execution/sandbox/recovery.js";
import {
  reconstructToolExecutionTimeline,
  type ToolExecutionCleanupConfirmedRecord,
} from "../../src/persistence/tool-execution.js";
import { sandboxReadyFixture } from "./fixtures/sandbox-ready-fixture.js";

function fixture() {
  const entry = sandboxReadyFixture();
  const observer = structuredClone(entry.ready.host_observer);
  observer.process.pid = 99;
  observer.process.nspid = [99];
  observer.process.startTime = "200";
  const origin = { bootId: entry.ready.boot_id, observer };
  const access: SandboxRecoveryReader = {
    origin: vi.fn(async () => origin),
    classify: vi.fn(async () => "missing" as const),
    observe: vi.fn(async () => entry.ready.final_init),
  };
  return { entry, access, origin };
}

describe("original-host sandbox recovery", () => {
  it("reports missing READY without observing any process", async () => {
    const f = fixture();
    expect(await inspectSandboxCleanup({ started: f.entry.started }, f.access)).toMatchObject({
      status: "missing_ready",
    });
    expect(f.access.origin).not.toHaveBeenCalled();
    expect(f.access.classify).not.toHaveBeenCalled();
  });

  it.each([
    "missing",
    "reused",
    "settled",
  ] as const)("requires attestation for %s init, even from a new observer", async (state) => {
    const f = fixture();
    vi.mocked(f.access.classify).mockResolvedValue(state);
    const result = await inspectSandboxCleanup(f.entry, f.access);
    expect(result).toMatchObject({
      status: "attestation_required",
      outputRef: f.entry.ready.output_ref,
      evidence: { init_observation: state, observer: { process: { pid: 99 } } },
    });
    expect(vi.mocked(f.access.classify).mock.calls.map(([identity]) => identity.pid)).toEqual([
      30, 20,
    ]);
    expect(
      reconstructToolExecutionTimeline([f.entry.started, f.entry.ready]).unresolved,
    ).toHaveLength(1);
    if (result.evidence === undefined) throw new Error("expected cleanup evidence");
    const record: ToolExecutionCleanupConfirmedRecord = {
      type: "tool_execution_cleanup_confirmed",
      schema_version: 1,
      run_id: "run",
      execution_id: "execution",
      supervision_id: "execution-supervision",
      logical_session_id: "logical",
      role_session_id: "child",
      tool_call_id: "execution-call",
      tool_name: "bash",
      verification: "operator_confirmed_sandbox_cleanup",
      sandbox: result.evidence,
      cleanup: "confirmed",
      operator: "operator",
      operator_note: "All original writers and partial effects inspected.",
      ts: 3,
    };
    expect(
      reconstructToolExecutionTimeline([f.entry.started, f.entry.ready, record]).unresolved,
    ).toEqual([]);
    expect(() =>
      reconstructToolExecutionTimeline([f.entry.started, { ...record, ts: 1 }]),
    ).toThrow();
    expect(() =>
      reconstructToolExecutionTimeline([f.entry.started, f.entry.ready, { ...record, ts: 1 }]),
    ).toThrow("timestamp");
    const changed = structuredClone(record);
    changed.sandbox.output_ref = "33333333-3333-4333-8333-333333333333";
    expect(() =>
      reconstructToolExecutionTimeline([f.entry.started, f.entry.ready, changed]),
    ).toThrow("mismatches durable READY");
  });

  it.each([
    "pid",
    "mnt",
    "user",
    "net",
    "ipc",
    "uts",
  ] as const)("refuses a changed %s origin before PID observation", async (name) => {
    const f = fixture();
    f.origin.observer.process.namespaces[name] = `${name}:[999]`;
    expect(await inspectSandboxCleanup(f.entry, f.access)).toMatchObject({
      status: "origin_mismatch",
    });
    expect(f.access.classify).not.toHaveBeenCalled();
  });

  it.each(["boot", "time"])("refuses changed %s origin", async (kind) => {
    const f = fixture();
    if (kind === "boot") f.origin.bootId = "99999999-9999-9999-9999-999999999999";
    else f.origin.observer.time_namespace = "time:[999]";
    expect(await inspectSandboxCleanup(f.entry, f.access)).toMatchObject({
      status: "origin_mismatch",
    });
  });

  it("refuses live init even when the launcher is missing", async () => {
    const f = fixture();
    vi.mocked(f.access.classify).mockResolvedValueOnce("alive").mockResolvedValueOnce("missing");
    expect(await inspectSandboxCleanup(f.entry, f.access)).toMatchObject({
      status: "live",
      init: { pid: 30 },
      launcher: { state: "missing" },
    });
    expect(f.access.observe).toHaveBeenCalledWith(30);
  });

  it("exposes the exact failing procfs operation without accepting EACCES as death", async () => {
    const f = fixture();
    vi.mocked(f.access.classify).mockRejectedValue(
      new SandboxProcessObservationError("read_stat", 30, { code: "EACCES" }),
    );
    expect(await inspectSandboxCleanup(f.entry, f.access)).toMatchObject({
      status: "unreadable",
      diagnostic: { operation: "read_stat", code: "EACCES", pid: 30 },
      guidance: expect.stringContaining("Restore authorized procfs observation"),
    });
  });
});
