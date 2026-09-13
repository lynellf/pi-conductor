import { describe, expect, it, vi } from "vitest";
import { ToolExecutionController } from "../../src/host/execution/tool-execution-controller.js";
import type { SandboxToolExecutionAdapter } from "../../src/host/execution/tool-execution-lifecycle.js";
import { DEFAULT_TOOL_EXECUTION_POLICY } from "../../src/manifest/execution-policy.js";
import type {
  SandboxExecutionOwner,
  SandboxReadyEvidence,
} from "../../src/persistence/sandbox-execution.js";
import type { SandboxProcessObservation } from "../../src/persistence/sandbox-process.js";
import {
  reconstructToolExecutionTimeline,
  type ToolExecutionRecord,
} from "../../src/persistence/tool-execution.js";

const owner: SandboxExecutionOwner = {
  child_id: "child",
  descriptor: {
    backend: "bubblewrap",
    execution_policy_digest: "a".repeat(64),
    runtime_digest: "b".repeat(64),
    materialization_id: "materialization",
  },
};
function processObservation(pid: number, base: number, nspid: number[]): SandboxProcessObservation {
  return {
    pid,
    startTime: "100",
    nspid,
    namespaces: {
      pid: `pid:[${base}]`,
      mnt: `mnt:[${base + 1}]`,
      user: `user:[${base + 2}]`,
      net: `net:[${base + 3}]`,
      ipc: `ipc:[${base + 4}]`,
      uts: `uts:[${base + 5}]`,
    },
  };
}
function evidence(): SandboxReadyEvidence {
  return {
    sandbox: structuredClone(owner),
    boot_id: "11111111-1111-1111-1111-111111111111",
    host_observer: { process: processObservation(20, 10, [20]), time_namespace: "time:[50]" },
    launcher: { pid: 30, start_time: "100" },
    early_init: processObservation(40, 100, [40, 1]),
    final_init: processObservation(40, 100, [40, 1]),
    startup_pid_namespace: 100,
    verified_binary: {
      identity: {
        device: 1,
        inode: 1,
        mode: 0o100755,
        uid: 0,
        gid: 0,
        size: 1,
        mtimeMs: 1,
        ctimeMs: 1,
      },
      digest: "c".repeat(64),
      path: "/opt/bwrap",
      approval_id: "approval",
    },
    output_ref: "22222222-2222-4222-8222-222222222222",
  };
}
function fixture(persistFault?: (record: ToolExecutionRecord) => void) {
  const records: ToolExecutionRecord[] = [],
    events: string[] = [];
  const controller = new ToolExecutionController({
    runId: "run",
    logicalSessionId: "logical",
    roleSessionId: "role",
    policy: { ...DEFAULT_TOOL_EXECUTION_POLICY, timeout_seconds: 1, termination_grace_seconds: 1 },
    persist: (record) => {
      persistFault?.(record);
      records.push(record);
      events.push(record.type);
    },
  });
  const adapter: SandboxToolExecutionAdapter<number> = {
    terminalEvidence: () => ({
      category: events.includes("settle")
        ? "command_status"
        : events.includes("authorize")
          ? "authorization_ambiguous"
          : "setup_failed",
      normalized_status: events.includes("settle") ? 17 : null,
      signal: "unknown",
      cleanup: "confirmed",
      termination_requested: events.includes("terminate"),
      output_ref: evidence().output_ref,
      output: {
        schemaVersion: 1,
        outputRef: evidence().output_ref,
        capture: "complete",
        stdout: { byteCount: 0, retainedVerified: true, sha256: "a".repeat(64) },
        stderr: { byteCount: 0, retainedVerified: true, sha256: "a".repeat(64) },
      },
    }),
    prepare: async () => {
      events.push("prepare");
      return evidence();
    },
    authorize: async () => {
      events.push("authorize");
    },
    settle: async () => {
      events.push("settle");
      return 17;
    },
    terminate: async () => {
      events.push("terminate");
      return "confirmed";
    },
  };
  return { controller, adapter, records, events };
}
describe("controller sandbox readiness", () => {
  it("pins start authority and persists correlated readiness before releasing", async () => {
    const f = fixture();
    await expect(f.controller.runLifecycle("bash", "call", owner, f.adapter)).resolves.toBe(17);
    expect(f.events).toEqual([
      "tool_execution_started",
      "prepare",
      "tool_execution_sandbox_ready",
      "authorize",
      "settle",
      "tool_execution_finished",
    ]);
    expect(reconstructToolExecutionTimeline(f.records).unresolved).toEqual([]);
    expect(f.records[0]).toMatchObject({ sandbox: owner });
    expect(f.records.at(-1)).toMatchObject({
      sandbox: { normalized_status: 17, signal: "unknown", output_ref: evidence().output_ref },
    });
  });
  it("never releases mismatched sandbox authority", async () => {
    const f = fixture();
    f.adapter.prepare = async () => ({ ...evidence(), sandbox: { ...owner, child_id: "sibling" } });
    await expect(f.controller.runLifecycle("bash", "call", owner, f.adapter)).rejects.toMatchObject(
      { code: "tool_failed" },
    );
    expect(f.events).not.toContain("authorize");
    expect(f.events).toContain("terminate");
  });
  it("waits for termination after an ambiguous ready append and closes admission", async () => {
    const f = fixture((record) => {
      if (record.type === "tool_execution_sandbox_ready") throw new Error("disk failure");
    });
    await expect(f.controller.runLifecycle("bash", "call", owner, f.adapter)).rejects.toMatchObject(
      { code: "tool_persistence_ambiguous" },
    );
    expect(f.events).not.toContain("authorize");
    expect(f.events).toContain("terminate");
    await expect(f.controller.run("read", "later", async () => 1)).rejects.toMatchObject({
      code: "tool_closed",
    });
  });
  it("rejects marker admission on the sandbox path before starting", async () => {
    const f = fixture();
    await expect(
      f.controller.runLifecycle("bash", "call", owner, f.adapter, {
        captureAdmission: async () => {
          throw new Error("should not be called");
        },
      }),
    ).rejects.toMatchObject({ code: "tool_input_invalid" });
    expect(f.events).toEqual([]);
  });

  it("records pre-aborted admission without starting physical setup", async () => {
    const f = fixture();
    const abort = new AbortController();
    abort.abort();
    await expect(
      f.controller.runLifecycle("bash", "call", owner, f.adapter, { signal: abort.signal }),
    ).rejects.toMatchObject({ code: "tool_aborted" });
    expect(f.events).toEqual(["tool_execution_started", "tool_execution_finished"]);
    expect(f.records.at(-1)).toMatchObject({
      outcome: "aborted",
      sandbox: { category: "setup_failed", normalized_status: null, cleanup: "confirmed" },
    });
    expect(reconstructToolExecutionTimeline(f.records).unresolved).toEqual([]);
  });

  it("records exactly one timeout after managed cancellation settles", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.adapter.settle = () => new Promise<number>(() => undefined);
      const pending = f.controller.runLifecycle("bash", "call", owner, f.adapter);
      const assertion = expect(pending).rejects.toMatchObject({
        code: "tool_timeout",
        cleanup: "confirmed",
      });
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      const terminals = f.records.filter((record) => record.type === "tool_execution_finished");
      expect(terminals).toHaveLength(1);
      expect(terminals[0]).toMatchObject({ outcome: "timed_out" });
      expect(reconstructToolExecutionTimeline(f.records).entries[0]?.ready).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains readiness and failure when release may have reached the command", async () => {
    const f = fixture();
    f.adapter.authorize = async () => {
      f.events.push("authorize");
      throw new Error("release callback failed");
    };
    await expect(f.controller.runLifecycle("bash", "call", owner, f.adapter)).rejects.toMatchObject(
      { code: "tool_failed" },
    );
    const entry = reconstructToolExecutionTimeline(f.records).entries[0];
    expect(entry?.ready).toBeDefined();
    expect(entry?.finished?.outcome).toBe("failed");
    expect(f.events).toContain("terminate");
  });

  it("rejects a setup-failure claim after durable readiness", async () => {
    const f = fixture();
    f.adapter.authorize = async () => {
      throw new Error("invalid backend state");
    };
    await expect(f.controller.runLifecycle("bash", "call", owner, f.adapter)).rejects.toMatchObject(
      { code: "tool_cleanup_unconfirmed" },
    );
  });

  it("does not return a result if cancellation arrives as settlement resolves", async () => {
    const f = fixture();
    const abort = new AbortController();
    f.adapter.settle = async () => {
      abort.abort();
      return 0;
    };
    await expect(
      f.controller.runLifecycle("bash", "call", owner, f.adapter, { signal: abort.signal }),
    ).rejects.toMatchObject({ code: "tool_aborted" });
    expect(f.records.filter((record) => record.type === "tool_execution_finished")).toMatchObject([
      { outcome: "aborted" },
    ]);
  });

  it("never retries an ambiguous terminal append", async () => {
    let attempts = 0;
    const f = fixture((record) => {
      if (record.type === "tool_execution_finished") {
        attempts++;
        throw new Error("terminal disk failure");
      }
    });
    await expect(f.controller.runLifecycle("bash", "call", owner, f.adapter)).rejects.toMatchObject(
      { code: "tool_persistence_ambiguous" },
    );
    expect(attempts).toBe(1);
    expect(reconstructToolExecutionTimeline(f.records).unresolved).toHaveLength(1);
  });

  it("preserves an unresolved execution when backend output ownership is inconsistent", async () => {
    const f = fixture();
    const original = f.adapter.terminalEvidence;
    f.adapter.terminalEvidence = () => ({
      ...original(),
      output_ref: "33333333-3333-4333-8333-333333333333",
    });
    await expect(f.controller.runLifecycle("bash", "call", owner, f.adapter)).rejects.toMatchObject(
      { code: "tool_cleanup_unconfirmed" },
    );
    expect(f.records.filter((record) => record.type === "tool_execution_finished")).toEqual([]);
    expect(reconstructToolExecutionTimeline(f.records).unresolved).toHaveLength(1);
    await expect(f.controller.run("read", "later", async () => 1)).rejects.toMatchObject({
      code: "tool_closed",
    });
  });

  it("downgrades terminal certainty when cleanup exceeds the controller window", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.adapter.settle = () => new Promise<number>(() => undefined);
      f.adapter.terminate = () => new Promise<"confirmed">(() => undefined);
      const pending = f.controller.runLifecycle("bash", "call", owner, f.adapter);
      const assertion = expect(pending).rejects.toMatchObject({
        code: "tool_cleanup_unconfirmed",
      });
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
      expect(f.records.at(-1)).toMatchObject({
        outcome: "cleanup_unconfirmed",
        sandbox: { category: "cleanup_unconfirmed", cleanup: "unconfirmed" },
      });
      expect(reconstructToolExecutionTimeline(f.records).unresolved).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
