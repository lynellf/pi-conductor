import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

function roleExecution(roleSessionId: string, executionId: string, ts: number) {
  const common = {
    schema_version: 1 as const,
    run_id: "run-1",
    execution_id: executionId,
    supervision_id: `${executionId}-supervision`,
    logical_session_id: `${roleSessionId}-logical`,
    role_session_id: roleSessionId,
    tool_call_id: `${executionId}-call`,
    tool_name: "bash",
  };
  return [
    {
      type: "tool_execution_started" as const,
      ...common,
      timeout_ms: 100,
      recovery_count: 0,
      ts,
    },
    {
      type: "tool_execution_finished" as const,
      ...common,
      elapsed_ms: 1,
      recovery_count: 0,
      outcome: "completed" as const,
      cleanup: "confirmed" as const,
      ts: ts + 1,
    },
  ];
}

describe("record-backed child continuity authority", () => {
  it("verifies canonical repository evidence when a host checkout is supplied", async () => {
    const commit = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const content = execFileSync("/usr/bin/git", ["show", `${commit}:package.json`]);
    const authority = recordBackedContinuityAuthority(
      [],
      { run_id: "run-1", role: "orchestrator", visit_index: 1 },
      { repositoryPath: process.cwd() },
    );

    const repositoryRef = {
      kind: "repository" as const,
      commit,
      path: "package.json",
      sha256: createHash("sha256").update(content).digest("hex"),
    };
    await expect(resolveSingleEvidence(authority, repositoryRef)).resolves.toMatchObject({
      status: "verified",
      resolved_path: "package.json",
      resolved_commit: commit,
    });
  });

  it("scopes role-visit execution evidence to the emitting role session", async () => {
    const records = [
      {
        type: "session_started" as const,
        run_id: "run-1",
        role: "orchestrator" as const,
        visit_index: 1,
        state: "orchestrator" as const,
        model: "test",
        session_file: "orchestrator.jsonl",
        role_session_id: "orchestrator-session",
        parent_session: null,
        ts: 1,
      },
      {
        type: "session_started" as const,
        run_id: "run-1",
        role: "implementer" as const,
        visit_index: 1,
        state: "implementer" as const,
        model: "test",
        session_file: "implementer.jsonl",
        role_session_id: "implementer-session",
        parent_session: "orchestrator.jsonl",
        ts: 2,
      },
      ...roleExecution("orchestrator-session", "exec-orchestrator", 3),
      ...roleExecution("implementer-session", "exec-implementer", 5),
    ] as PersistedRecord[];
    const authority = recordBackedContinuityAuthority(records, {
      run_id: "run-1",
      role: "orchestrator",
      visit_index: 1,
    });

    await expect(
      resolveSingleEvidence(authority, {
        kind: "tool_execution",
        execution_id: "exec-orchestrator",
      }),
    ).resolves.toMatchObject({ status: "verified" });
    await expect(
      resolveSingleEvidence(authority, {
        kind: "tool_execution",
        execution_id: "exec-implementer",
      }),
    ).resolves.toMatchObject({ status: "missing" });
  });

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

  it("denies orphan tool execution authority before any child lifecycle grant", async () => {
    const authority = recordBackedContinuityAuthority(
      execution("child-a", "exec-a") as PersistedRecord[],
      { run_id: "run-1", child: { child_id: "child-a", task_id: "task-a" } },
    );
    await expect(
      resolveSingleEvidence(authority, { kind: "tool_execution", execution_id: "exec-a" }),
    ).resolves.toMatchObject({ status: "missing" });
  });

  it("denies duplicated or wrong-task child starts as ambiguous authority", async () => {
    const duplicate = [
      childStart("child-a", "task-a"),
      childStart("child-a", "task-a"),
      ...execution("child-a", "exec-a"),
    ] as PersistedRecord[];
    const wrongTask = recordBackedContinuityAuthority(duplicate, {
      run_id: "run-1",
      child: { child_id: "child-a", task_id: "task-other" },
    });
    const duplicateAuthority = recordBackedContinuityAuthority(duplicate, {
      run_id: "run-1",
      child: { child_id: "child-a", task_id: "task-a" },
    });
    await expect(
      resolveSingleEvidence(duplicateAuthority, { kind: "tool_execution", execution_id: "exec-a" }),
    ).resolves.toMatchObject({ status: "missing" });
    await expect(
      resolveSingleEvidence(wrongTask, {
        kind: "context_artifact",
        artifact_id: "artifact-child-a",
        sha256: "c".repeat(64),
      }),
    ).resolves.toMatchObject({ status: "missing" });
  });

  it("binds execution evidence to the currently active retry attempt", async () => {
    const records = [
      childStart("child-a", "task-a"),
      ...execution("child-a", "exec-old"),
      {
        type: "subagent_failed" as const,
        run_id: "run-1",
        child_id: "child-a",
        task_id: "task-a",
        subagent: "worker",
        model: "test",
        status: "failed" as const,
        failure_reason: "retryable failure",
        branch: "child",
        worktree_path: "/tmp/child",
        base_commit: "a".repeat(40),
        head_commit: null,
        session_file: null,
        usage: null,
        ts: 4,
      },
      childStart("child-a", "task-a"),
      ...execution("child-a", "exec-new"),
    ] as PersistedRecord[];
    const authority = recordBackedContinuityAuthority(records, {
      run_id: "run-1",
      child: { child_id: "child-a", task_id: "task-a" },
    });

    await expect(
      resolveSingleEvidence(authority, { kind: "tool_execution", execution_id: "exec-old" }),
    ).resolves.toMatchObject({ status: "missing" });
    await expect(
      resolveSingleEvidence(authority, { kind: "tool_execution", execution_id: "exec-new" }),
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
