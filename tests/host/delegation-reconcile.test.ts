import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { reconcileDelegationChildren } from "../../src/host/delegation/reconcile.js";
import { ToolExecutionError } from "../../src/host/execution/tool-execution-controller.js";
import { FileRecordLog } from "../../src/host/log-file.js";
import { delegationSubmissionId } from "../../src/persistence/delegation-task.js";

const child = {
  child_id: "child-1",
  task_id: "task-1",
  subagent: "worker",
  model: "stub:model",
  branch: "delegation/child-1",
  worktree_path: "/tmp/worktree-1",
  base_commit: "a".repeat(40),
  task_fingerprint: "1".repeat(64),
  profile_fingerprint: "2".repeat(64),
  context_fingerprint: "3".repeat(64),
  prompt_fingerprint: "4".repeat(64),
  projection_fingerprint: { kind: "exact" as const, path_count: 1, sha256: "5".repeat(64) },
};
const accepted = {
  type: "delegation_submission_accepted" as const,
  schema_version: 1 as const,
  run_id: "run-1",
  submission_id: delegationSubmissionId("run-1", "parent-1", "call-1"),
  logical_parent_id: "parent-1",
  parent_role: "orchestrator",
  parent_visit_index: 1,
  tool_call_id: "call-1",
  input_fingerprint: "6".repeat(64),
  children: [child],
  ts: 1,
};
const started = {
  type: "subagent_started" as const,
  run_id: "run-1",
  child_id: child.child_id,
  task_id: child.task_id,
  subagent: child.subagent,
  parent_role: "orchestrator",
  parent_visit_index: 1,
  task_fingerprint: child.task_fingerprint,
  projection_fingerprint: child.projection_fingerprint,
  model: child.model,
  session_file: "/tmp/child-1.jsonl",
  worktree_path: child.worktree_path,
  branch: child.branch,
  base_commit: child.base_commit,
  ts: 2,
};
const completed = {
  type: "subagent_completed" as const,
  run_id: "run-1",
  child_id: child.child_id,
  task_id: child.task_id,
  subagent: child.subagent,
  model: child.model,
  status: "completed" as const,
  summary: "done",
  branch: child.branch,
  worktree_path: child.worktree_path,
  base_commit: child.base_commit,
  head_commit: child.base_commit,
  session_file: started.session_file,
  usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, tokens: 2, cost: 0 },
  ts: 3,
};
const unfinishedTool = {
  type: "tool_execution_started" as const,
  schema_version: 1 as const,
  run_id: "run-1",
  execution_id: "execution-1",
  supervision_id: "supervision-1",
  logical_session_id: "logical-1",
  role_session_id: started.session_file,
  tool_call_id: "call-tool-1",
  tool_name: "read",
  timeout_ms: 1000,
  recovery_count: 0,
  ts: 2,
};

function withLog(records: readonly object[]): { log: FileRecordLog; dir: string } {
  const dir = mkdtempSync(`${tmpdir()}/pi-conductor-delegation-reconcile-`);
  const log = new FileRecordLog({ baseDir: dir });
  for (const record of records) log.append(record as never);
  return { log, dir };
}

describe("delegation reconciliation", () => {
  it("terminalizes an accepted queued child exactly once with null session and usage", () => {
    const { log, dir } = withLog([accepted]);
    try {
      reconcileDelegationChildren("run-1", log);
      reconcileDelegationChildren("run-1", log);
      const failures = log.records("run-1").filter((record) => record.type === "subagent_failed");
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        failure_reason: "delegation_interrupted",
        status: "cancelled",
        session_file: null,
        usage: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses before writes when an unfinished executable is unknown", () => {
    const { log, dir } = withLog([accepted, started, unfinishedTool]);
    try {
      expect(() => reconcileDelegationChildren("run-1", log)).toThrow(ToolExecutionError);
      expect(log.records("run-1").filter((record) => record.type === "subagent_failed")).toEqual(
        [],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not terminalize completed accepted children or add usage", () => {
    const { log, dir } = withLog([accepted, started, completed]);
    try {
      reconcileDelegationChildren("run-1", log);
      expect(log.records("run-1").filter((record) => record.type === "subagent_failed")).toEqual(
        [],
      );
      expect(
        log.records("run-1").filter((record) => record.type === "subagent_completed"),
      ).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("interrupts an accepted started child after ownership is settled", () => {
    const { log, dir } = withLog([accepted, started]);
    try {
      reconcileDelegationChildren("run-1", log);
      expect(log.records("run-1").at(-1)).toMatchObject({
        type: "subagent_failed",
        failure_reason: "delegation_interrupted",
        session_file: started.session_file,
        usage: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retains delegated cleanup confirmations when checking child execution ownership", () => {
    const { log, dir } = withLog([
      accepted,
      started,
      {
        ...unfinishedTool,
        role_session_id: child.child_id,
        tool_call_id: "call-tool-1",
        tool_name: "read",
      },
      {
        type: "tool_execution_finished",
        schema_version: 1,
        run_id: "run-1",
        execution_id: "execution-1",
        supervision_id: "supervision-1",
        logical_session_id: "logical-1",
        role_session_id: child.child_id,
        tool_call_id: "call-tool-1",
        tool_name: "read",
        elapsed_ms: 1,
        recovery_count: 0,
        outcome: "cleanup_unconfirmed",
        cleanup: "unconfirmed",
        ts: 3,
      },
      {
        type: "tool_execution_cleanup_confirmed",
        schema_version: 1,
        run_id: "run-1",
        execution_id: "execution-1",
        supervision_id: "supervision-1",
        logical_session_id: "logical-1",
        role_session_id: child.child_id,
        tool_call_id: "call-tool-1",
        tool_name: "read",
        cleanup: "confirmed",
        verification: "operator_confirmed_owner_marker_absent",
        operator_note: "inspected original host and namespace",
        operator: "operator",
        ts: 4,
      },
    ]);
    try {
      reconcileDelegationChildren("run-1", log);
      expect(log.records("run-1").at(-1)).toMatchObject({
        type: "subagent_failed",
        failure_reason: "delegation_interrupted",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
