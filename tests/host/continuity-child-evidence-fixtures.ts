import type { ContinuityEvidenceResolution } from "../../src/core/types.js";
import { recordBackedContinuityAuthority } from "../../src/host/continuity-record-authority.js";
import {
  createReportCapture,
  type ReportCapture,
} from "../../src/host/delegation/child-observation.js";
import { buildReportResultTool } from "../../src/host/delegation/child-sdk-tools.js";
import type {
  PersistedRecord,
  SubagentStartedRecord,
  ToolExecutionFinishedRecord,
  ToolExecutionStartedRecord,
} from "../../src/persistence/log.js";
import type { ContinuityPacketV1, EvidenceRef } from "../../src/seam/continuity.js";

export const ARTIFACT_SHA = "c".repeat(64);
export const ALT_ARTIFACT_SHA = "d".repeat(64);
export const REPO_COMMIT = "a".repeat(40);

const descriptor = {
  backend: "bubblewrap" as const,
  execution_policy_digest: "a".repeat(64),
  runtime_digest: "b".repeat(64),
  materialization_id: "materialization",
};

/** Build a durable child start with the exact artifact inventory the child received. */
export function childStart(
  child_id: string,
  task_id: string,
  run_id = "run-1",
): SubagentStartedRecord {
  return {
    type: "subagent_started",
    run_id,
    child_id,
    task_id,
    subagent: "worker",
    parent_role: "orchestrator",
    parent_visit_index: 1,
    model: "test-model",
    session_file: `${child_id}.jsonl`,
    worktree_path: "/tmp/child",
    branch: "child",
    base_commit: "a".repeat(40),
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
    ts: 1,
  };
}

/** Build a valid, cleanup-confirmed v1 execution owned by a child sandbox. */
export function toolExecutionRecords(
  child_id: string,
  execution_id: string,
  run_id = "run-1",
): readonly [ToolExecutionStartedRecord, ToolExecutionFinishedRecord] {
  const common = {
    schema_version: 1 as const,
    run_id,
    execution_id,
    supervision_id: `sup-${execution_id}`,
    logical_session_id: `logical-${execution_id}`,
    role_session_id: `role-${execution_id}`,
    tool_call_id: `call-${execution_id}`,
    tool_name: "bash",
  };
  return [
    {
      type: "tool_execution_started",
      ...common,
      timeout_ms: 30_000,
      recovery_count: 0,
      sandbox: { child_id, descriptor },
      ts: 2,
    },
    {
      type: "tool_execution_finished",
      ...common,
      elapsed_ms: 1,
      recovery_count: 0,
      outcome: "interrupted",
      cleanup: "confirmed",
      sandbox: {
        category: "interrupted",
        normalized_status: null,
        signal: "unknown",
        termination_requested: false,
        cleanup: "confirmed",
      },
      ts: 3,
    },
  ];
}

/** Build a started execution that must not be treated as verified before settlement. */
export function unfinishedToolExecution(
  child_id: string,
  execution_id: string,
  run_id = "run-1",
): ToolExecutionStartedRecord {
  return {
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
    sandbox: { child_id, descriptor },
    ts: 2,
  };
}

interface BuildCaptureOptions {
  readonly records: readonly PersistedRecord[];
  readonly child_id: string;
  readonly task_id: string;
  readonly run_id?: string;
  readonly require_delegated_result?: boolean;
}

/** Build the real child report seam over record-backed authority. */
export function buildChildCapture(options: BuildCaptureOptions): ReportCapture {
  const run_id = options.run_id ?? "run-1";
  const require_delegated_result = options.require_delegated_result ?? true;
  const authority = recordBackedContinuityAuthority(options.records, {
    run_id,
    child: { child_id: options.child_id, task_id: options.task_id },
  });
  const verifiedExecutionIds = new Set<string>();
  for (const record of options.records) {
    if (
      record.type === "tool_execution_finished" &&
      authority.toolExecutions.belongsToRun(record.execution_id, run_id)
    )
      verifiedExecutionIds.add(record.execution_id);
  }

  return createReportCapture({
    continuityValidation: () => ({
      policy: {
        require_handoff: false,
        require_delegated_result,
        seed_max_utf8_bytes: 32_768,
      },
      knownItemIds: new Set<string>(),
      verifiedExecutionIds,
      evidenceVerifiedByKey: new Map<string, ContinuityEvidenceResolution>(),
      resolveEvidence: (key, ref) => resolveChildEvidence(authority, key, ref),
    }),
  });
}

function resolveChildEvidence(
  authority: ReturnType<typeof recordBackedContinuityAuthority>,
  key: string,
  ref: EvidenceRef,
): ContinuityEvidenceResolution {
  if (ref.kind === "tool_execution") {
    return authority.toolExecutions.belongsToRun(ref.execution_id, authority.audience.run_id)
      ? { ref_key: key, kind: ref.kind, status: "verified" }
      : {
          ref_key: key,
          kind: ref.kind,
          status: "missing",
          diagnostic: "tool_execution_not_found",
        };
  }
  if (ref.kind === "context_artifact") {
    return authority.contextArtifacts.canRead(ref.artifact_id, ref.sha256, authority.audience)
      ? { ref_key: key, kind: ref.kind, status: "verified" }
      : {
          ref_key: key,
          kind: ref.kind,
          status: "missing",
          diagnostic: "context_artifact_unauthorized",
        };
  }
  if (ref.kind === "external")
    return {
      ref_key: key,
      kind: ref.kind,
      status: "declared",
      diagnostic: "external_declared",
    };
  return {
    ref_key: key,
    kind: ref.kind,
    status: "declared",
    diagnostic: "repository_declared",
  };
}

export function finding(
  evidence: readonly EvidenceRef[],
  confidence: "observed" | "verified" | "inferred" = "observed",
): ContinuityPacketV1["findings"][number] {
  return {
    id: "f",
    kind: "fact",
    confidence,
    statement: "claim",
    evidence: [...evidence],
    supersedes: [],
  };
}

export function packetWith(
  findings: readonly ContinuityPacketV1["findings"][number][],
): ContinuityPacketV1 {
  return {
    schema_version: 1,
    summary: "child packet",
    findings: [...findings],
    evaluations: [],
    open_questions: [],
    next_steps: [],
    okf_candidate_ids: [],
  };
}

export interface ToolResult {
  readonly isError?: boolean;
  readonly content?: readonly { readonly type: string; readonly text: string }[];
}

/** Execute the terminating child tool against a real capture buffer. */
export async function executeReport(
  capture: ReportCapture,
  args: {
    readonly status: "completed" | "no_changes" | "failed";
    readonly summary: string;
    readonly continuity?: ContinuityPacketV1;
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
