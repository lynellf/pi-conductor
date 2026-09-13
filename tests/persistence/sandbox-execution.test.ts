import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileRecordLog } from "../../src/host/log-file.js";
import type { ToolExecutionSandboxReadyRecord } from "../../src/persistence/sandbox-execution.js";
import {
  assertToolExecutionSandboxReadyRecord,
  SandboxExecutionRecordError,
} from "../../src/persistence/sandbox-execution.js";
import {
  assertToolExecutionRecord,
  reconstructToolExecutionTimeline,
  type ToolExecutionFinishedRecord,
  type ToolExecutionStartedRecord,
} from "../../src/persistence/tool-execution.js";

const descriptor = {
  backend: "bubblewrap" as const,
  execution_policy_digest: "a".repeat(64),
  runtime_digest: "b".repeat(64),
  materialization_id: "materialization-1",
};
const observation = (pid: number, nspid: number[], pidNamespace: number) => ({
  pid,
  startTime: "42",
  nspid,
  namespaces: {
    pid: `pid:[${pidNamespace}]`,
    mnt: "mnt:[2]",
    user: "user:[3]",
    net: "net:[4]",
    ipc: "ipc:[5]",
    uts: "uts:[6]",
  },
});
const started: ToolExecutionStartedRecord = {
  type: "tool_execution_started",
  schema_version: 1,
  run_id: "run-1",
  execution_id: "exec-1",
  supervision_id: "supervise-1",
  logical_session_id: "logical-1",
  role_session_id: "role-1",
  tool_call_id: "call-1",
  tool_name: "bash",
  timeout_ms: 1000,
  recovery_count: 0,
  ts: 10,
  sandbox: { child_id: "child-1", descriptor },
};
const ready: ToolExecutionSandboxReadyRecord = {
  type: "tool_execution_sandbox_ready",
  schema_version: 1,
  run_id: "run-1",
  execution_id: "exec-1",
  supervision_id: "supervise-1",
  logical_session_id: "logical-1",
  role_session_id: "role-1",
  tool_call_id: "call-1",
  tool_name: "bash",
  sandbox: { child_id: "child-1", descriptor },
  boot_id: "12345678-1234-1234-1234-123456789abc",
  host_observer: {
    process: {
      ...observation(10, [10, 5], 1),
      namespaces: {
        pid: "pid:[1]",
        mnt: "mnt:[20]",
        user: "user:[30]",
        net: "net:[40]",
        ipc: "ipc:[50]",
        uts: "uts:[60]",
      },
    },
    time_namespace: "time:[1]",
  },
  launcher: { pid: 20, start_time: "40" },
  early_init: observation(30, [30, 5], 7),
  final_init: observation(30, [30, 5, 1], 7),
  startup_pid_namespace: 7,
  verified_binary: {
    identity: {
      device: 1,
      inode: 2,
      mode: 0o100755,
      uid: 0,
      gid: 0,
      size: 1,
      mtimeMs: 1,
      ctimeMs: 1,
    },
    digest: "c".repeat(64),
    path: "/bin/bash",
    approval_id: "approval-1",
  },
  output_ref: "22345678-1234-4234-8234-123456789abc",
  ts: 20,
};

describe("sandbox READY persistence", () => {
  it.each([
    "pid",
    "mnt",
    "user",
    "net",
    "ipc",
    "uts",
  ] as const)("rejects a shared final %s namespace", (name) => {
    const changed = structuredClone(ready);
    changed.final_init.namespaces[name] = changed.host_observer.process.namespaces[name];
    expect(() => assertToolExecutionSandboxReadyRecord(changed)).toThrow();
  });

  it.each([
    ["non-init mapping", { ...ready.final_init, nspid: [30, 5, 2] }],
    ["wrong nesting depth", { ...ready.final_init, nspid: [30, 1] }],
    ["changed start time", { ...ready.final_init, startTime: "43" }],
  ] as const)("rejects %s", (_name, final_init) => {
    expect(() => assertToolExecutionSandboxReadyRecord({ ...ready, final_init })).toThrow();
  });

  it.each([0o100777, 0o104755, 0o100700, 0o040755])("rejects unsafe binary mode %i", (mode) => {
    expect(() =>
      assertToolExecutionSandboxReadyRecord({
        ...ready,
        verified_binary: {
          ...ready.verified_binary,
          identity: { ...ready.verified_binary.identity, mode },
        },
      }),
    ).toThrow();
  });

  it("accepts strict evidence and preserves it in the execution timeline", () => {
    assertToolExecutionSandboxReadyRecord(ready);
    const timeline = reconstructToolExecutionTimeline([started, ready]);
    expect(timeline.entries[0]?.ready).toEqual(ready);
  });

  it("round trips READY through the file log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-conductor-sandbox-ready-"));
    try {
      new FileRecordLog({ baseDir: dir }).append(started);
      new FileRecordLog({ baseDir: dir }).append(ready);
      const records = new FileRecordLog({ baseDir: dir }).records("run-1");
      expect(records[1]).toEqual(ready);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["unknown field", { ...ready, secret: "nope" }],
    ["early/final PID mismatch", { ...ready, final_init: observation(31, [31, 5, 1], 7) }],
  ] as const)("rejects %s", (_name, value) => {
    expect(() => assertToolExecutionSandboxReadyRecord(value)).toThrow(SandboxExecutionRecordError);
  });

  it("rejects legacy starts carrying both admission and sandbox owner", () => {
    expect(() =>
      assertToolExecutionRecord({
        ...started,
        admission: {
          schema_version: 1,
          boot_id: "12345678-1234-1234-1234-123456789abc",
          pid_namespace: "pid:[1]",
          time_namespace: "time:[1]",
          network_namespace: "net:[1]",
          init_start_time: "1",
          preexisting_before: "1",
        },
      }),
    ).toThrow("mutually exclusive");
  });

  it("requires READY before terminal and rejects duplicate READY", () => {
    const finished: ToolExecutionFinishedRecord = {
      type: "tool_execution_finished" as const,
      schema_version: 1,
      run_id: "run-1",
      execution_id: "exec-1",
      supervision_id: "supervise-1",
      logical_session_id: "logical-1",
      role_session_id: "role-1",
      tool_call_id: "call-1",
      tool_name: "bash",
      elapsed_ms: 1,
      outcome: "completed" as const,
      cleanup: "confirmed" as const,
      recovery_count: 0,
      ts: 30,
    };
    expect(() => reconstructToolExecutionTimeline([started, finished, ready])).toThrow();
    expect(() => reconstructToolExecutionTimeline([started, ready, ready])).toThrow();
    expect(() => reconstructToolExecutionTimeline([started, finished])).toThrow(
      "requires a preceding ready record",
    );
    const failed: ToolExecutionFinishedRecord = {
      ...finished,
      outcome: "failed",
      sandbox: {
        category: "setup_failed",
        normalized_status: null,
        signal: "unknown",
        termination_requested: false,
        cleanup: "confirmed",
      },
    };
    expect(reconstructToolExecutionTimeline([started, failed]).entries[0]?.finished).toEqual(
      failed,
    );
    expect(() => reconstructToolExecutionTimeline([started, failed, ready])).toThrow(
      "cannot follow terminal",
    );
  });

  it.each([
    "run_id",
    "execution_id",
    "supervision_id",
    "logical_session_id",
    "role_session_id",
    "tool_call_id",
    "tool_name",
  ] as const)("rejects READY correlation mismatch in %s", (field) => {
    expect(() =>
      reconstructToolExecutionTimeline([started, { ...ready, [field]: "other" }]),
    ).toThrow();
  });

  it.each([
    "execution_policy_digest",
    "runtime_digest",
    "materialization_id",
  ] as const)("rejects READY owner mismatch in %s", (field) => {
    expect(() =>
      reconstructToolExecutionTimeline([
        started,
        {
          ...ready,
          sandbox: {
            ...ready.sandbox,
            descriptor: {
              ...descriptor,
              [field]: field.endsWith("digest") ? "d".repeat(64) : "other",
            },
          },
        },
      ]),
    ).toThrow("sandbox ready mismatches sandbox owner");
  });
});
