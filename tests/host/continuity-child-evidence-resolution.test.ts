/**
 * Child-produced continuity packets with evidence resolution under the
 * child's granted authority (durable-continuity spec §6.2, §7, §9).
 *
 * Each case binds `capture.continuityValidation` to a record-backed
 * `resolveEvidence` that mirrors the host's child/task authority semantics
 * over a fixture of `subagent_started` + `tool_execution_*` records, then
 * drives `buildReportResultTool` and asserts the resulting
 * `evidence_resolutions` shape.
 */

import { describe, expect, it } from "vitest";

import { createReportCapture } from "../../src/host/delegation/child-observation.js";
import { buildReportResultTool } from "../../src/host/delegation/child-sdk-tools.js";

// ─── Fixture record shapes ─────────────────────────────────────────────

const ARTIFACT_SHA = "c".repeat(64);
const ALT_ARTIFACT_SHA = "d".repeat(64);
const REPO_COMMIT = "a".repeat(40);

interface InlineArtifactEntry {
  readonly ordinal: number;
  readonly id: string;
  readonly source: "inline";
  readonly provenance: { readonly kind: "parent_inline" };
  readonly byte_length: number;
  readonly sha256: string;
  readonly text: string;
}

interface SubagentStartedFixture {
  readonly type: "subagent_started";
  readonly run_id: string;
  readonly child_id: string;
  readonly task_id: string;
  readonly subagent: string;
  readonly model: string;
  readonly session_file: string;
  readonly worktree_path: string;
  readonly branch: string;
  readonly base_commit: string;
  readonly ts: number;
  readonly context_artifacts?: {
    readonly version: 1;
    readonly total_utf8_bytes: number;
    readonly artifacts: readonly InlineArtifactEntry[];
  };
}

interface ToolExecutionStartedFixture {
  readonly type: "tool_execution_started";
  readonly schema_version: 1;
  readonly run_id: string;
  readonly execution_id: string;
  readonly supervision_id: string;
  readonly logical_session_id: string;
  readonly role_session_id: string;
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly timeout_ms: number;
  readonly recovery_count: number;
  readonly sandbox: {
    readonly child_id: string;
    readonly descriptor: {
      readonly backend: "bubblewrap";
      readonly execution_policy_digest: string;
      readonly runtime_digest: string;
      readonly materialization_id: string;
    };
  };
  readonly ts: number;
}

interface ToolExecutionFinishedFixture {
  readonly type: "tool_execution_finished";
  readonly schema_version: 1;
  readonly run_id: string;
  readonly execution_id: string;
  readonly outcome: "interrupted";
  readonly cleanup: "confirmed";
  readonly sandbox_cleanup: "confirmed";
  readonly ts: number;
}

type FixtureRecord =
  | SubagentStartedFixture
  | ToolExecutionStartedFixture
  | ToolExecutionFinishedFixture;

function childStart(child_id: string, task_id: string, run_id = "run-1"): SubagentStartedFixture {
  return {
    type: "subagent_started",
    run_id,
    child_id,
    task_id,
    subagent: "code",
    model: "test-model",
    session_file: `/tmp/pi/${child_id}.jsonl`,
    worktree_path: "/workspace",
    branch: "main",
    base_commit: "0".repeat(40),
    ts: 1,
    context_artifacts: {
      version: 1,
      total_utf8_bytes: 16,
      artifacts: [
        {
          ordinal: 0,
          id: `artifact-${child_id}`,
          source: "inline",
          provenance: { kind: "parent_inline" },
          byte_length: 16,
          sha256: ARTIFACT_SHA,
          text: "artifact-text",
        },
      ],
    },
  };
}

function toolExecutionRecords(
  child_id: string,
  execution_id: string,
  run_id = "run-1",
): readonly [ToolExecutionStartedFixture, ToolExecutionFinishedFixture] {
  return [
    {
      type: "tool_execution_started",
      schema_version: 1,
      run_id,
      execution_id,
      supervision_id: `sup-${execution_id}`,
      logical_session_id: `logical-${execution_id}`,
      role_session_id: `role-${execution_id}`,
      tool_call_id: `call-${execution_id}`,
      tool_name: "bash",
      timeout_ms: 30_000,
      recovery_count: 0,
      sandbox: {
        child_id,
        descriptor: {
          backend: "bubblewrap",
          execution_policy_digest: "a".repeat(64),
          runtime_digest: "b".repeat(64),
          materialization_id: `mat-${child_id}`,
        },
      },
      ts: 1,
    },
    {
      type: "tool_execution_finished",
      schema_version: 1,
      run_id,
      execution_id,
      outcome: "interrupted",
      cleanup: "confirmed",
      sandbox_cleanup: "confirmed",
      ts: 2,
    },
  ];
}

// ─── Capture + resolver ────────────────────────────────────────────────

interface ResolutionShape {
  readonly ref_key: string;
  readonly kind: string;
  readonly status: "verified" | "declared" | "missing";
  readonly diagnostic?: string;
  readonly message?: string;
}

interface BuildCaptureOptions {
  readonly records: readonly FixtureRecord[];
  readonly child_id: string;
  readonly task_id: string;
  readonly run_id?: string;
  readonly require_delegated_result?: boolean;
}

function buildChildCapture(options: BuildCaptureOptions) {
  const run_id = options.run_id ?? "run-1";
  const require_delegated_result = options.require_delegated_result ?? true;
  const starts = options.records.filter(
    (record): record is SubagentStartedFixture => record.type === "subagent_started",
  );
  const executions = options.records.filter(
    (record): record is ToolExecutionStartedFixture => record.type === "tool_execution_started",
  );

  // Reconciled execution set: anchored by a matching start in the same run
  // and scoped to the unique child's executions.
  const startedChildIds = new Set(
    starts
      .filter((s) => s.run_id === run_id && s.child_id === options.child_id)
      .map((s) => s.child_id),
  );
  const verifiedExecutionIds = new Set(
    executions
      .filter(
        (e) =>
          e.run_id === run_id &&
          e.sandbox.child_id === options.child_id &&
          startedChildIds.has(e.sandbox.child_id),
      )
      .map((e) => e.execution_id),
  );

  // Granted context-artifact inventory per child (run + child + task gated).
  const grantedArtifacts = new Map<string, readonly { id: string; sha256: string }[]>();
  for (const s of starts) {
    if (s.run_id !== run_id || s.child_id !== options.child_id || s.task_id !== options.task_id) {
      continue;
    }
    const inventory = (s.context_artifacts?.artifacts ?? []).map((a) => ({
      id: a.id,
      sha256: a.sha256,
    }));
    grantedArtifacts.set(s.child_id, inventory);
  }

  const resolveEvidence = (
    key: string,
    ref: {
      readonly kind: string;
    } & Record<string, unknown>,
  ): ResolutionShape => {
    if (ref.kind === "tool_execution") {
      const execution_id = ref.execution_id;
      if (typeof execution_id !== "string" || !verifiedExecutionIds.has(execution_id)) {
        return {
          ref_key: key,
          kind: "tool_execution",
          status: "missing",
          diagnostic: "tool_execution_not_found",
          message: "Tool execution evidence does not refer to a durable execution in this run.",
        };
      }
      return { ref_key: key, kind: "tool_execution", status: "verified" };
    }
    if (ref.kind === "context_artifact") {
      const inventory = grantedArtifacts.get(options.child_id) ?? [];
      const { artifact_id, sha256 } = ref;
      const granted =
        typeof artifact_id === "string" &&
        typeof sha256 === "string" &&
        inventory.some((a) => a.id === artifact_id && a.sha256 === sha256);
      if (!granted) {
        return {
          ref_key: key,
          kind: "context_artifact",
          status: "missing",
          diagnostic: "context_artifact_unauthorized",
          message:
            "Context artifact evidence is not in the emitting role/child's granted inventory.",
        };
      }
      return { ref_key: key, kind: "context_artifact", status: "verified" };
    }
    if (ref.kind === "external") {
      return {
        ref_key: key,
        kind: "external",
        status: "declared",
        diagnostic: "external_declared",
        message:
          "External evidence is declared; the host does not turn network access into a verified fact.",
      };
    }
    return {
      ref_key: key,
      kind: "repository",
      status: "declared",
      diagnostic: "repository_declared",
      message: "Repository evidence is declared without host authority to verify it.",
    };
  };
  return createReportCapture({
    continuityValidation: () => ({
      policy: {
        require_handoff: false,
        require_delegated_result,
        seed_max_utf8_bytes: 32_768,
      },
      knownItemIds: new Set<string>(),
      verifiedExecutionIds,
      evidenceVerifiedByKey: new Map<string, ResolutionShape>(),
      resolveEvidence,
    }),
  });
}

// ─── Packet builders ───────────────────────────────────────────────────

function finding(
  evidence: readonly Record<string, unknown>[],
  confidence: "observed" | "verified" | "inferred" = "observed",
) {
  return {
    id: "f",
    kind: "fact" as const,
    confidence,
    statement: "claim",
    evidence,
    supersedes: [],
  };
}

function packetWith(findings: readonly ReturnType<typeof finding>[]) {
  return {
    schema_version: 1 as const,
    summary: "child packet",
    findings,
    evaluations: [],
    open_questions: [],
    next_steps: [],
    okf_candidate_ids: [],
  };
}

// ─── Test execution helper ─────────────────────────────────────────────

interface ToolResult {
  readonly isError?: boolean;
  readonly content?: readonly { readonly type: string; readonly text: string }[];
}

async function executeReport(
  capture: ReturnType<typeof createReportCapture>,
  args: {
    readonly status: string;
    readonly summary: string;
    readonly continuity?: ReturnType<typeof packetWith>;
  },
): Promise<ToolResult> {
  const tool = buildReportResultTool(capture);
  return (await tool.execute(
    "call",
    args as unknown as Record<string, unknown>,
    undefined,
    undefined,
    {} as never,
  )) as ToolResult;
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe("delegated report_result evidence resolution", () => {
  it("verifies a tool_execution reference inside the child's reconciled set", async () => {
    const capture = buildChildCapture({
      records: [
        childStart("child-a", "task-a"),
        ...toolExecutionRecords("child-a", "exec-child-a"),
      ],
      child_id: "child-a",
      task_id: "task-a",
    });
    const result = await executeReport(capture, {
      status: "completed",
      summary: "done",
      continuity: packetWith([finding([{ kind: "tool_execution", execution_id: "exec-child-a" }])]),
    });
    expect(result).not.toMatchObject({ isError: true });
    expect(capture.continuity()?.evidence_resolutions).toEqual([
      { ref_key: "findings:f:0", kind: "tool_execution", status: "verified" },
    ]);
  });

  it("marks a tool_execution reference missing when the child start is absent", async () => {
    const capture = buildChildCapture({
      records: [...toolExecutionRecords("child-a", "exec-child-a")],
      child_id: "child-a",
      task_id: "task-a",
    });
    const result = await executeReport(capture, {
      status: "completed",
      summary: "done",
      continuity: packetWith([finding([{ kind: "tool_execution", execution_id: "exec-child-a" }])]),
    });
    expect(result).not.toMatchObject({ isError: true });
    expect(capture.continuity()?.evidence_resolutions).toMatchObject([
      {
        ref_key: "findings:f:0",
        kind: "tool_execution",
        status: "missing",
        diagnostic: "tool_execution_not_found",
      },
    ]);
  });

  it("denies a sibling-child tool_execution reference", async () => {
    const capture = buildChildCapture({
      records: [
        childStart("child-a", "task-a"),
        childStart("child-b", "task-b"),
        ...toolExecutionRecords("child-b", "exec-child-b"),
      ],
      child_id: "child-a",
      task_id: "task-a",
    });
    const result = await executeReport(capture, {
      status: "completed",
      summary: "done",
      continuity: packetWith([finding([{ kind: "tool_execution", execution_id: "exec-child-b" }])]),
    });
    expect(result).not.toMatchObject({ isError: true });
    expect(capture.continuity()?.evidence_resolutions).toMatchObject([
      {
        ref_key: "findings:f:0",
        kind: "tool_execution",
        status: "missing",
        diagnostic: "tool_execution_not_found",
      },
    ]);
  });

  it("denies a cross-run tool_execution reference", async () => {
    const capture = buildChildCapture({
      records: [
        childStart("child-a", "task-a", "run-1"),
        ...toolExecutionRecords("child-a", "exec-child-a", "run-1"),
      ],
      child_id: "child-a",
      task_id: "task-a",
      run_id: "run-2",
    });
    const result = await executeReport(capture, {
      status: "completed",
      summary: "done",
      continuity: packetWith([finding([{ kind: "tool_execution", execution_id: "exec-child-a" }])]),
    });
    expect(result).not.toMatchObject({ isError: true });
    expect(capture.continuity()?.evidence_resolutions).toMatchObject([
      {
        ref_key: "findings:f:0",
        kind: "tool_execution",
        status: "missing",
        diagnostic: "tool_execution_not_found",
      },
    ]);
  });

  it("verifies a context_artifact reference inside the granted inventory", async () => {
    const capture = buildChildCapture({
      records: [childStart("child-a", "task-a")],
      child_id: "child-a",
      task_id: "task-a",
    });
    const result = await executeReport(capture, {
      status: "completed",
      summary: "done",
      continuity: packetWith([
        finding([
          {
            kind: "context_artifact",
            artifact_id: "artifact-child-a",
            sha256: ARTIFACT_SHA,
          },
        ]),
      ]),
    });
    expect(result).not.toMatchObject({ isError: true });
    expect(capture.continuity()?.evidence_resolutions).toEqual([
      { ref_key: "findings:f:0", kind: "context_artifact", status: "verified" },
    ]);
  });

  it("denies a context_artifact reference with a mismatched sha256", async () => {
    const capture = buildChildCapture({
      records: [childStart("child-a", "task-a")],
      child_id: "child-a",
      task_id: "task-a",
    });
    const result = await executeReport(capture, {
      status: "completed",
      summary: "done",
      continuity: packetWith([
        finding([
          {
            kind: "context_artifact",
            artifact_id: "artifact-child-a",
            sha256: ALT_ARTIFACT_SHA,
          },
        ]),
      ]),
    });
    expect(result).not.toMatchObject({ isError: true });
    expect(capture.continuity()?.evidence_resolutions).toMatchObject([
      {
        ref_key: "findings:f:0",
        kind: "context_artifact",
        status: "missing",
        diagnostic: "context_artifact_unauthorized",
      },
    ]);
  });

  it("denies a sibling-child context_artifact reference", async () => {
    const capture = buildChildCapture({
      records: [childStart("child-a", "task-a"), childStart("child-b", "task-b")],
      child_id: "child-a",
      task_id: "task-a",
    });
    const result = await executeReport(capture, {
      status: "completed",
      summary: "done",
      continuity: packetWith([
        finding([
          {
            kind: "context_artifact",
            artifact_id: "artifact-child-b",
            sha256: ARTIFACT_SHA,
          },
        ]),
      ]),
    });
    expect(result).not.toMatchObject({ isError: true });
    expect(capture.continuity()?.evidence_resolutions).toMatchObject([
      {
        ref_key: "findings:f:0",
        kind: "context_artifact",
        status: "missing",
        diagnostic: "context_artifact_unauthorized",
      },
    ]);
  });

  it("declares an external reference", async () => {
    const capture = buildChildCapture({
      records: [childStart("child-a", "task-a")],
      child_id: "child-a",
      task_id: "task-a",
    });
    const result = await executeReport(capture, {
      status: "completed",
      summary: "done",
      continuity: packetWith([
        finding([{ kind: "external", url: "https://example.com/spec", title: "spec" }]),
      ]),
    });
    expect(result).not.toMatchObject({ isError: true });
    expect(capture.continuity()?.evidence_resolutions).toMatchObject([
      {
        ref_key: "findings:f:0",
        kind: "external",
        status: "declared",
        diagnostic: "external_declared",
      },
    ]);
  });

  it("declares a repository reference", async () => {
    const capture = buildChildCapture({
      records: [childStart("child-a", "task-a")],
      child_id: "child-a",
      task_id: "task-a",
    });
    const result = await executeReport(capture, {
      status: "completed",
      summary: "done",
      continuity: packetWith([
        finding([
          {
            kind: "repository",
            path: "src/seam/continuity.ts",
            commit: REPO_COMMIT,
          },
        ]),
      ]),
    });
    expect(result).not.toMatchObject({ isError: true });
    expect(capture.continuity()?.evidence_resolutions).toMatchObject([
      {
        ref_key: "findings:f:0",
        kind: "repository",
        status: "declared",
        diagnostic: "repository_declared",
      },
    ]);
  });

  it("resolves all four evidence kinds in one packet", async () => {
    const capture = buildChildCapture({
      records: [
        childStart("child-a", "task-a"),
        ...toolExecutionRecords("child-a", "exec-child-a"),
      ],
      child_id: "child-a",
      task_id: "task-a",
    });
    const result = await executeReport(capture, {
      status: "completed",
      summary: "done",
      continuity: packetWith([
        finding([
          { kind: "tool_execution", execution_id: "exec-child-a" },
          { kind: "context_artifact", artifact_id: "artifact-child-a", sha256: ARTIFACT_SHA },
          { kind: "external", url: "https://example.com/spec", title: "spec" },
          { kind: "repository", path: "src/seam/continuity.ts", commit: REPO_COMMIT },
        ]),
      ]),
    });
    expect(result).not.toMatchObject({ isError: true });
    expect(capture.continuity()?.evidence_resolutions).toMatchObject([
      { ref_key: "findings:f:0", kind: "tool_execution", status: "verified" },
      { ref_key: "findings:f:1", kind: "context_artifact", status: "verified" },
      { ref_key: "findings:f:2", kind: "external", status: "declared" },
      { ref_key: "findings:f:3", kind: "repository", status: "declared" },
    ]);
    expect(capture.continuity()?.evidence_resolutions.length).toBe(4);
  });

  it("rejects a verified claim that lacks fully-resolved evidence", async () => {
    const capture = buildChildCapture({
      records: [childStart("child-a", "task-a")],
      child_id: "child-a",
      task_id: "task-a",
    });
    const result = await executeReport(capture, {
      status: "completed",
      summary: "done",
      continuity: packetWith([
        finding([{ kind: "external", url: "https://example.com/spec", title: "spec" }], "verified"),
      ]),
    });
    expect(result).toMatchObject({ isError: true });
    const text = result.content?.[0]?.text ?? "";
    expect(text).toContain("continuity_verified_requires_resolved_evidence");
    expect(capture.continuity()).toBeNull();
  });

  it("accepts an observed claim with mixed declared evidence", async () => {
    const capture = buildChildCapture({
      records: [childStart("child-a", "task-a")],
      child_id: "child-a",
      task_id: "task-a",
    });
    const result = await executeReport(capture, {
      status: "completed",
      summary: "done",
      continuity: packetWith([
        finding([
          { kind: "external", url: "https://example.com/spec", title: "spec" },
          { kind: "repository", path: "src/seam/continuity.ts", commit: REPO_COMMIT },
        ]),
      ]),
    });
    expect(result).not.toMatchObject({ isError: true });
    expect(capture.continuity()?.evidence_resolutions).toMatchObject([
      { ref_key: "findings:f:0", kind: "external", status: "declared" },
      { ref_key: "findings:f:1", kind: "repository", status: "declared" },
    ]);
  });

  it("records a successful result without a packet only when continuity is not required", async () => {
    const capture = buildChildCapture({
      records: [childStart("child-a", "task-a")],
      child_id: "child-a",
      task_id: "task-a",
      require_delegated_result: false,
    });
    const result = await executeReport(capture, {
      status: "completed",
      summary: "done",
    });
    expect(result).not.toMatchObject({ isError: true });
    expect(capture.continuity()).toBeNull();
  });
});
