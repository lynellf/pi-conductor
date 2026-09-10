import { describe, expect, it, vi } from "vitest";
import { SupervisedProcessError } from "../../src/host/execution/supervised-process.js";
import { ToolExecutionController } from "../../src/host/execution/tool-execution-controller.js";
import { DEFAULT_TOOL_EXECUTION_POLICY } from "../../src/manifest/execution-policy.js";
import {
  assertToolExecutionRecord,
  type ToolExecutionRecord,
} from "../../src/persistence/tool-execution.js";

const admission = {
  schema_version: 1 as const,
  boot_id: "12345678-1234-1234-1234-123456789abc",
  pid_namespace: "pid:[100]",
  time_namespace: "time:[101]",
  network_namespace: "net:[102]",
  init_start_time: "1",
  preexisting_before: "500",
};

function fixture(persist?: (record: ToolExecutionRecord) => void) {
  const records: ToolExecutionRecord[] = [];
  const controller = new ToolExecutionController({
    runId: "run",
    logicalSessionId: "logical",
    roleSessionId: "role",
    policy: DEFAULT_TOOL_EXECUTION_POLICY,
    persist: (record) => {
      assertToolExecutionRecord(record);
      persist?.(record);
      records.push(record);
    },
  });
  return { controller, records };
}

describe("durable tool admission", () => {
  it("records an aborted attempt without invoking the operation when capture overlaps abort", async () => {
    const { controller, records } = fixture();
    const abort = new AbortController();
    const operation = vi.fn();
    await expect(
      controller.run("bash", "aborted", operation, {
        signal: abort.signal,
        captureAdmission: async () => {
          abort.abort();
          return admission;
        },
      }),
    ).rejects.toMatchObject({ code: "tool_aborted" });
    expect(operation).not.toHaveBeenCalled();
    expect(records).toMatchObject([
      { type: "tool_execution_started", admission },
      { type: "tool_execution_finished", outcome: "aborted", cleanup: "confirmed" },
    ]);
  });

  it("does not append a late start after another execution closes admission", async () => {
    const { controller, records } = fixture();
    let release!: (value: typeof admission) => void;
    const capture = new Promise<typeof admission>((resolve) => {
      release = resolve;
    });
    const operation = vi.fn();
    const pending = controller.run("bash", "waiting", operation, {
      captureAdmission: () => capture,
    });
    await expect(
      controller.run("bash", "fatal", async () => {
        throw new SupervisedProcessError(
          "supervised-process-spawn-failed",
          "unknown cleanup",
          "unconfirmed",
          null,
        );
      }),
    ).rejects.toMatchObject({ code: "tool_cleanup_unconfirmed" });
    const before = [...records];
    release(admission);
    await expect(pending).rejects.toMatchObject({ code: "tool_closed" });
    expect(operation).not.toHaveBeenCalled();
    expect(records).toEqual(before);
  });

  it("persists captured admission before the operation is allowed to begin", async () => {
    const { controller, records } = fixture();
    let release!: (value: typeof admission) => void;
    const captured = new Promise<typeof admission>((resolve) => {
      release = resolve;
    });
    const operation = vi.fn(async () => {
      expect(records[0]).toMatchObject({ type: "tool_execution_started", admission });
      return "done";
    });
    const result = controller.run("bash", "call", operation, { captureAdmission: () => captured });
    await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();
    expect(records).toEqual([]);
    release(admission);
    await expect(result).resolves.toBe("done");
  });

  it("does not launch an operation when capture fails", async () => {
    const { controller, records } = fixture();
    const operation = vi.fn();
    await expect(
      controller.run("bash", "call", operation, {
        captureAdmission: async () => {
          throw new Error("observation unavailable");
        },
      }),
    ).rejects.toThrow("observation unavailable");
    expect(operation).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });

  it("does not launch an operation when admission persistence fails", async () => {
    const { controller } = fixture(() => {
      throw new Error("disk failed");
    });
    const operation = vi.fn();
    await expect(
      controller.run("bash", "call", operation, {
        captureAdmission: async () => admission,
      }),
    ).rejects.toMatchObject({ code: "tool_persistence_ambiguous" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("preserves legacy start records without admission evidence", async () => {
    const { controller, records } = fixture();
    await controller.run("bash", "call", async () => "done");
    expect(records[0]).not.toHaveProperty("admission");
    expect(() => assertToolExecutionRecord(records[0])).not.toThrow();
  });
});
