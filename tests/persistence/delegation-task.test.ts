import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { FileRecordLog } from "../../src/host/log-file.js";
import {
  acceptedDelegationResults,
  assertDelegationSubmissionAccepted,
  assertDelegationTaskTimeline,
  DelegationTaskRecordError,
  delegationSubmissionId,
  pendingDelegationChildren,
  spentDelegationSlots,
} from "../../src/persistence/delegation-task.js";
import { InMemoryRecordLog, type PersistedRecord } from "../../src/persistence/log.js";

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
const terminal = {
  type: "subagent_failed" as const,
  run_id: "run-1",
  child_id: child.child_id,
  task_id: child.task_id,
  subagent: child.subagent,
  model: child.model,
  status: "cancelled" as const,
  failure_reason: "queued cancellation",
  branch: child.branch,
  worktree_path: child.worktree_path,
  base_commit: child.base_commit,
  head_commit: null,
  session_file: null,
  usage: null,
  ts: 2,
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
  completion_protocol: "report_result" as const,
  model: child.model,
  session_file: "/tmp/child-1.jsonl",
  worktree_path: child.worktree_path,
  branch: child.branch,
  base_commit: child.base_commit,
  ts: 2,
};

describe("delegation submission acceptance ledger", () => {
  it("validates one atomic batch and derives pending, result, and spent state", () => {
    assertDelegationSubmissionAccepted(accepted);
    const records = [accepted, terminal] satisfies readonly PersistedRecord[];
    expect(pendingDelegationChildren([accepted])).toEqual([child]);
    expect(pendingDelegationChildren(records)).toEqual([]);
    expect(acceptedDelegationResults(records)).toEqual([terminal]);
    expect(spentDelegationSlots(records, "parent-1")).toBe(1);
  });

  it("rejects duplicate, orphan-prefix, and mismatched accepted lifecycles", () => {
    expect(() => assertDelegationTaskTimeline([accepted, accepted])).toThrow(
      DelegationTaskRecordError,
    );
    expect(() => assertDelegationTaskTimeline([terminal, accepted])).toThrow("orphan");
    expect(() =>
      assertDelegationTaskTimeline([accepted, { ...terminal, task_id: "other" }]),
    ).toThrow("identity");
    expect(() => assertDelegationTaskTimeline([accepted, terminal, terminal])).toThrow("duplicate");
    expect(() => assertDelegationTaskTimeline([started, accepted])).toThrow("orphan");
    expect(() => assertDelegationTaskTimeline([accepted, started, started])).toThrow("duplicate");
    expect(() =>
      assertDelegationTaskTimeline([
        accepted,
        started,
        { ...terminal, session_file: "/tmp/other.jsonl" },
      ]),
    ).toThrow("session");
  });

  it("permits a running child to be cancelled with its real session and usage", () => {
    const runningTerminal = {
      ...terminal,
      session_file: started.session_file,
      usage: { input: 1, output: 2, cache_read: 0, cache_write: 0, tokens: 3, cost: 0.1 },
    };
    expect(() => assertDelegationTaskTimeline([accepted, started, runningTerminal])).not.toThrow();
  });

  it("accepts the complete normalized completion-evidence shape", () => {
    const completed = {
      type: "subagent_completed" as const,
      run_id: "run-1",
      child_id: child.child_id,
      task_id: child.task_id,
      subagent: child.subagent,
      model: child.model,
      branch: child.branch,
      worktree_path: child.worktree_path,
      base_commit: child.base_commit,
      status: "completed" as const,
      summary: "done",
      session_file: started.session_file,
      head_commit: child.base_commit,
      usage: { input: 1, output: 0, cache_read: 0, cache_write: 0, tokens: 1, cost: 0 },
      ts: 3,
      completion_evidence: {
        completion_protocol: "report_result" as const,
        completion_source: "host" as const,
        normalization_reason: "report_result_completed_clean" as const,
        report_result_called: true,
        reported_status: "completed" as const,
        final_response_present: true,
        summary_truncated: false,
        worktree_state: "clean" as const,
        changed_path_count: 0,
        changed_paths: [],
        changed_paths_truncated: false,
        file_tool_calls: { read: 1, grep: 0, find: 0, ls: 0, edit: 0, write: 0 },
        duplicate_read_calls: 0,
      },
    };
    expect(() => assertDelegationTaskTimeline([accepted, started, completed])).not.toThrow();
  });

  it("rejects malformed accepted-child terminal usage", () => {
    const completed = {
      ...terminal,
      type: "subagent_completed" as const,
      status: "completed" as const,
      summary: "done",
      session_file: started.session_file,
      head_commit: child.base_commit,
      usage: {} as never,
    };
    expect(() => assertDelegationTaskTimeline([accepted, started, completed])).toThrow();
  });

  it.each([
    ["verification", { verification: [1] }],
    ["completion evidence", { completion_evidence: { normalization_reason: "unknown" } }],
  ] as const)("rejects malformed accepted-child %s", (_name, change) => {
    const completed = {
      ...terminal,
      type: "subagent_completed" as const,
      status: "completed" as const,
      summary: "done",
      session_file: started.session_file,
      head_commit: child.base_commit,
      usage: { input: 1, output: 0, cache_read: 0, cache_write: 0, tokens: 1, cost: 0 },
      ...change,
    } as unknown as PersistedRecord;
    expect(() => assertDelegationTaskTimeline([accepted, started, completed])).toThrow();
  });

  it.each([
    ["missing parent role", { parent_role: undefined }],
    ["missing parent visit", { parent_visit_index: undefined }],
    ["empty session", { session_file: "" }],
    ["invalid start timestamp", { ts: Number.NaN }],
  ] as const)("rejects malformed accepted-child start: %s", (_name, change) => {
    expect(() =>
      assertDelegationTaskTimeline([
        accepted,
        { ...started, ...change } as unknown as PersistedRecord,
      ]),
    ).toThrow();
  });

  it("rejects a terminal from a different run", () => {
    expect(() =>
      assertDelegationTaskTimeline([accepted, { ...terminal, run_id: "other" }]),
    ).toThrow("identity");
  });

  it("leaves legacy terminal records outside the accepted ledger", () => {
    expect(() => assertDelegationTaskTimeline([terminal])).not.toThrow();
  });

  it("enforces the same acceptance and lifecycle rules on reopen", () => {
    const dir = mkdtempSync(`${tmpdir()}/pi-conductor-delegation-task-`);
    try {
      const first = new FileRecordLog({ baseDir: dir });
      first.append(accepted);
      first.append(terminal);
      const reopened = new FileRecordLog({ baseDir: dir });
      expect(reopened.records("run-1")).toEqual([accepted, terminal]);
      expect(() => reopened.append(terminal)).toThrow("duplicate");
      writeFileSync(
        `${dir}/run-1.jsonl`,
        `${JSON.stringify(accepted)}\n${JSON.stringify({ ...terminal, usage: {} })}\n`,
        "utf8",
      );
      expect(() => new FileRecordLog({ baseDir: dir }).records("run-1")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces lifecycle rules through the in-memory adapter", () => {
    const log = new InMemoryRecordLog();
    log.append(accepted);
    log.append(terminal);
    expect(() => log.append(terminal)).toThrow("duplicate");
  });
});
