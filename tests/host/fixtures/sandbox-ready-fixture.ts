import type { ToolExecutionSandboxReadyRecord } from "../../../src/persistence/sandbox-execution.js";
import type { SandboxProcessObservation } from "../../../src/persistence/sandbox-process.js";
import type { ToolExecutionStartedRecord } from "../../../src/persistence/tool-execution.js";

export function sandboxReadyFixture(runId = "run", executionId = "execution") {
  const observation = (pid: number, base: number, nspid: number[]): SandboxProcessObservation => ({
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
  });
  const owner = {
    child_id: "child",
    descriptor: {
      backend: "bubblewrap" as const,
      execution_policy_digest: "a".repeat(64),
      runtime_digest: "b".repeat(64),
      materialization_id: "materialization",
    },
  };
  const identity = {
    run_id: runId,
    execution_id: executionId,
    supervision_id: `${executionId}-supervision`,
    logical_session_id: "logical",
    role_session_id: "child",
    tool_call_id: `${executionId}-call`,
    tool_name: "bash",
  };
  const started: ToolExecutionStartedRecord = {
    ...identity,
    type: "tool_execution_started",
    schema_version: 1,
    timeout_ms: 1000,
    recovery_count: 0,
    sandbox: owner,
    ts: 1,
  };
  const ready: ToolExecutionSandboxReadyRecord = {
    ...identity,
    type: "tool_execution_sandbox_ready",
    schema_version: 1,
    sandbox: owner,
    boot_id: "11111111-1111-1111-1111-111111111111",
    host_observer: { process: observation(10, 10, [10]), time_namespace: "time:[50]" },
    launcher: { pid: 20, start_time: "100" },
    early_init: observation(30, 100, [30, 1]),
    final_init: observation(30, 100, [30, 1]),
    startup_pid_namespace: 100,
    verified_binary: {
      path: "/opt/bwrap",
      digest: "c".repeat(64),
      approval_id: "approved",
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
    },
    output_ref: "22222222-2222-4222-8222-222222222222",
    ts: 2,
  };
  return { started, ready };
}
