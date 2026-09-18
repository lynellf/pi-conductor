import { describe, expect, it } from "vitest";
import { resolveSingleEvidence } from "../../src/host/continuity-evidence.js";
import { recordBackedContinuityAuthority } from "../../src/host/continuity-record-authority.js";
import type { PersistedRecord } from "../../src/persistence/log.js";

const descriptor = {
  backend: "bubblewrap" as const,
  execution_policy_digest: "a".repeat(64),
  runtime_digest: "b".repeat(64),
  materialization_id: "materialization",
};

function childStart(child_id: string, task_id: string, run_id = "run-1") {
  return {
    type: "subagent_started" as const,
    run_id,
    child_id,
    task_id,
    subagent: "worker",
    parent_role: "orchestrator" as const,
    parent_visit_index: 1,
    model: "test",
    session_file: `${child_id}.jsonl`,
    worktree_path: "/tmp/child",
    branch: "child",
    base_commit: "a".repeat(40),
    context_artifacts: {
      version: 1 as const,
      total_utf8_bytes: 1,
      artifacts: [
        {
          ordinal: 0,
          id: `artifact-${child_id}`,
          source: "inline" as const,
          provenance: { kind: "parent_inline" as const },
          byte_length: 1,
          sha256: "c".repeat(64),
          text: "x",
        },
      ],
    },
    ts: 1,
  };
}

function execution(child_id: string, execution_id: string) {
  const common = {
    schema_version: 1 as const,
    run_id: "run-1",
    execution_id,
    supervision_id: `${execution_id}-supervision`,
    logical_session_id: `${child_id}-logical`,
    role_session_id: `${child_id}-role`,
    tool_call_id: `${execution_id}-call`,
    tool_name: "bash",
  };
  return [
    {
      type: "tool_execution_started" as const,
      ...common,
      timeout_ms: 100,
      recovery_count: 0,
      sandbox: { child_id, descriptor },
      ts: 2,
    },
    {
      type: "tool_execution_finished" as const,
      ...common,
      elapsed_ms: 1,
      recovery_count: 0,
      outcome: "interrupted" as const,
      cleanup: "confirmed" as const,
      sandbox: {
        category: "interrupted" as const,
        normalized_status: null,
        signal: "unknown" as const,
        termination_requested: false,
        cleanup: "confirmed" as const,
      },
      ts: 3,
    },
  ];
}

describe("record-backed child continuity authority", () => {
  it("authorizes only the reconciled execution and artifact owned by the exact child task", async () => {
    const authority = recordBackedContinuityAuthority(
      [childStart("child-a", "task-a"), ...execution("child-a", "exec-a")] as PersistedRecord[],
      { run_id: "run-1", child: { child_id: "child-a", task_id: "task-a" } },
    );
    await expect(
      resolveSingleEvidence(authority, { kind: "tool_execution", execution_id: "exec-a" }),
    ).resolves.toMatchObject({ status: "verified" });
    await expect(
      resolveSingleEvidence(authority, {
        kind: "context_artifact",
        artifact_id: "artifact-child-a",
        sha256: "c".repeat(64),
      }),
    ).resolves.toMatchObject({ status: "verified" });
  });

  it("denies sibling, cross-run, and orphan child authority", async () => {
    const records = [
      childStart("child-a", "task-a"),
      childStart("child-b", "task-b"),
      ...execution("child-b", "exec-b"),
    ] as PersistedRecord[];
    const sibling = recordBackedContinuityAuthority(records, {
      run_id: "run-1",
      child: { child_id: "child-a", task_id: "task-a" },
    });
    const orphan = recordBackedContinuityAuthority(records, {
      run_id: "run-1",
      child: { child_id: "missing", task_id: "missing" },
    });
    await expect(
      resolveSingleEvidence(sibling, { kind: "tool_execution", execution_id: "exec-b" }),
    ).resolves.toMatchObject({ status: "missing" });
    await expect(
      resolveSingleEvidence(sibling, {
        kind: "context_artifact",
        artifact_id: "artifact-child-b",
        sha256: "c".repeat(64),
      }),
    ).resolves.toMatchObject({ status: "missing" });
    await expect(
      resolveSingleEvidence(orphan, {
        kind: "context_artifact",
        artifact_id: "artifact-child-a",
        sha256: "c".repeat(64),
      }),
    ).resolves.toMatchObject({ status: "missing" });
    await expect(
      resolveSingleEvidence(sibling, { kind: "tool_execution", execution_id: "exec-other-run" }),
    ).resolves.toMatchObject({ status: "missing" });
  });
});
