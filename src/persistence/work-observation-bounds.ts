/** Size bounding and durable evidence association for v2 observations (§11.3–§11.4). */

import type { Role } from "../core/types.js";
import type { PersistedRecord } from "./log.js";
import type {
  ChildTerminalObservationV2,
  HostArtifactObservation,
  HostExecutionObservation,
  WorkObservationV2,
} from "./work-observation.js";

const MAX_CHANGED_PATHS = 16;
const MAX_EXECUTIONS = 8;
const MAX_ARTIFACTS = 8;
const MAX_OBSERVATION_BYTES = 12 * 1024;

/** Typed failure when mandatory context cannot fit the pinned observation bound. */
export class WorkObservationSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkObservationSizeError";
  }
}

/** Bound one host observation, omitting optional evidence in the pinned order. */
export function boundedObservation(observation: WorkObservationV2): WorkObservationV2 {
  let changedPaths = [...observation.observed.changed_paths].map((path) => normalizePath(path));
  let executions = [...observation.observed.executions].map((entry) => ({
    status: boundText(entry.status, 128),
  }));
  let artifacts = [...observation.observed.artifacts].map((entry) => ({
    kind: boundText(entry.kind, 64),
    basename: boundText(entry.basename, 256),
    ...(entry.description === undefined ? {} : { description: boundText(entry.description, 256) }),
  }));
  let omitted = {
    changed_paths: Math.max(0, changedPaths.length - MAX_CHANGED_PATHS),
    executions: Math.max(0, executions.length - MAX_EXECUTIONS),
    artifacts: Math.max(0, artifacts.length - MAX_ARTIFACTS),
  };
  // Issue #137 Phase 2: the returned worker's `reason` is mandatory
  // in the projected seed. The bounded observation must never drop
  // it — it is dropped only when the reason itself is truncated (by
  // `projectHints`). Other hints (summary, verification) remain
  // optional and may be dropped when budget pressure requires it.
  const mandatoryReason = observation.reported_hints.reason;
  let hints: WorkObservationV2["reported_hints"] = observation.reported_hints;
  let ignoredHintFields = observation.ignored_hint_fields;
  let ignoredHintDiagnostics = observation.ignored_hint_diagnostics;
  changedPaths = changedPaths.slice(-MAX_CHANGED_PATHS);
  executions = executions.slice(-MAX_EXECUTIONS);
  artifacts = artifacts.slice(-MAX_ARTIFACTS);
  const candidate = (): WorkObservationV2 => ({
    ...observation,
    task: projectTask(observation.task),
    reported_hints: projectHints(hints),
    ...(ignoredHintFields === undefined || ignoredHintFields.length === 0
      ? {}
      : { ignored_hint_fields: ignoredHintFields }),
    ...(ignoredHintDiagnostics === undefined || ignoredHintDiagnostics.length === 0
      ? {}
      : { ignored_hint_diagnostics: ignoredHintDiagnostics }),
    observed: {
      ...observation.observed,
      changed_paths: changedPaths,
      executions,
      artifacts,
    },
    omitted,
  });
  let result = candidate();
  while (utf8Bytes(result) > MAX_OBSERVATION_BYTES) {
    if (artifacts.length > 0) {
      artifacts = artifacts.slice(1);
      omitted = { ...omitted, artifacts: omitted.artifacts + 1 };
    } else {
      const successfulIndex = executions.findIndex((entry) => isSuccessfulExecution(entry.status));
      if (successfulIndex >= 0) {
        executions = executions.filter((_, entryIndex) => entryIndex !== successfulIndex);
        omitted = { ...omitted, executions: omitted.executions + 1 };
      } else if (changedPaths.length > 0) {
        changedPaths = changedPaths.slice(1);
        omitted = { ...omitted, changed_paths: omitted.changed_paths + 1 };
      } else if (hasOptionalHints(hints, mandatoryReason)) {
        // Drop only the non-mandatory hints; preserve `reason`.
        const next: { summary?: string; reason?: string; verification?: readonly string[] } = {};
        if (mandatoryReason !== undefined) next.reason = mandatoryReason;
        hints = next as WorkObservationV2["reported_hints"];
      } else if (
        (ignoredHintFields !== undefined && ignoredHintFields.length > 0) ||
        (ignoredHintDiagnostics !== undefined && ignoredHintDiagnostics.length > 0)
      ) {
        ignoredHintFields = undefined;
        ignoredHintDiagnostics = undefined;
      } else {
        throw new WorkObservationSizeError("mandatory v2 work observation exceeds 12 KiB");
      }
    }
    result = candidate();
  }
  return result;
}

/**
 * Issue #137 Phase 2: there are optional hints left to drop only if the
 * hints object still carries fields beyond the mandatory `reason`. The
 * mandatory reason survives even when summary/verification are dropped.
 */
function hasOptionalHints(
  hints: WorkObservationV2["reported_hints"],
  mandatoryReason: string | undefined,
): boolean {
  if (hints.summary !== undefined) return true;
  if (hints.verification !== undefined && hints.verification.length > 0) return true;
  // The reason itself can be dropped only if the observation carried
  // none — a present reason is mandatory and must never be discarded
  // by size pressure. We surface that as `false` so the bounded loop
  // keeps the reason and continues trimming optional evidence.
  return mandatoryReason === undefined && hints.reason !== undefined;
}

/** Associate durable execution, mutation, and artifact facts with one invocation. */
export function collectEvidence(
  records: readonly PersistedRecord[],
  start: number,
  end: number,
  runId: string,
  role: Role,
  sessionFile: string,
  visit: number,
): {
  readonly changedPaths: readonly string[];
  readonly executions: readonly HostExecutionObservation[];
  readonly artifacts: readonly HostArtifactObservation[];
} {
  const changedPaths: string[] = [];
  const executions: HostExecutionObservation[] = [];
  const artifacts: HostArtifactObservation[] = [];
  const roleSessionId = findRoleSessionId(records, end, role, sessionFile);
  for (let index = start; index < end; index += 1) {
    const record = records[index];
    if (record === undefined || recordRunId(record) !== runId) continue;
    if (
      record.type === "file_mutation" &&
      record.role === role &&
      record.session_file === sessionFile
    ) {
      changedPaths.push(...record.files.map((file) => file.path));
    } else if (
      record.type === "tool_execution_finished" &&
      (roleSessionId === undefined || record.role_session_id === roleSessionId)
    ) {
      executions.push({ status: boundText(record.outcome, 128) });
    } else if (
      record.type === "artifact_collected" &&
      record.role === role &&
      record.visit_index === visit
    ) {
      artifacts.push({
        kind: record.kind,
        basename: basename(record.source_path),
        ...(record.description === undefined ? {} : { description: record.description }),
      });
    }
  }
  return { changedPaths, executions, artifacts };
}

/** Find the accepted delegated task that owns a settled child terminal. */
export function findChildAcceptance(
  records: readonly PersistedRecord[],
  before: number,
  childId: string,
  taskId: string,
): Extract<PersistedRecord, { type: "delegation_submission_accepted" }> | null {
  for (let index = before; index >= 0; index -= 1) {
    const record = records[index];
    if (
      record?.type === "delegation_submission_accepted" &&
      record.children.some((child) => child.child_id === childId && child.task_id === taskId)
    )
      return record;
  }
  return null;
}

/** Build the fallback host directive for legacy accepted records. */
export function legacyTask(recipient: string): WorkObservationV2["task"] {
  return {
    host_directive: `Perform the work assigned to role ${recipient} in service of the run goal.`,
  };
}

/** Convert the host's settled child record to the closed v2 terminal vocabulary. */
export function deriveChildObservation(
  record: Extract<PersistedRecord, { type: "subagent_completed" | "subagent_failed" }>,
): ChildTerminalObservationV2 {
  const evidence = record.completion_evidence;
  const workspaceState = evidence?.worktree_state ?? "uninspected";
  if (record.type === "subagent_failed") {
    return {
      outcome: record.status === "cancelled" ? "cancelled" : "failed",
      workspace_state: workspaceState,
      ...(evidence?.reported_status === undefined
        ? {}
        : { reported_status: evidence.reported_status }),
    };
  }
  return {
    outcome: "returned",
    workspace_state: workspaceState,
    ...(evidence?.reported_status === undefined
      ? {}
      : { reported_status: evidence.reported_status }),
  };
}

/** Trim a UTF-8 string without splitting a code point. */
export function boundText(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value.trim());
  if (bytes.byteLength <= maxBytes) return value.trim();
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.slice(0, end));
}

export function roleVisit(
  records: readonly PersistedRecord[],
  before: number,
  role: string,
  sessionFile: string,
): number {
  let visit = 0;
  for (let index = 0; index <= before; index += 1) {
    const record = records[index];
    if (
      record?.type === "session_started" &&
      record.role === role &&
      record.session_file === sessionFile
    )
      visit = record.visit_index;
  }
  return visit;
}

export function inferOrchestrator(
  records: readonly PersistedRecord[],
  before: number,
  role: Role,
): Role {
  for (let index = before; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.type === "manifest_snapshot") return record.definition.orchestrator;
  }
  return role;
}

function findRoleSessionId(
  records: readonly PersistedRecord[],
  before: number,
  role: Role,
  sessionFile: string,
): string | undefined {
  for (let index = before; index >= 0; index -= 1) {
    const record = records[index];
    if (
      record?.type === "session_started" &&
      record.role === role &&
      record.session_file === sessionFile &&
      record.role_session_id !== undefined
    )
      return record.role_session_id;
  }
  return undefined;
}

function normalizePath(value: string): string {
  const candidate = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    candidate.startsWith("/") ||
    /^[A-Za-z]:\//.test(candidate) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(candidate)
  )
    return "<path omitted>";
  const parts = candidate.split("/");
  if (parts.some((part) => part === ".." || part.length === 0)) return "<path omitted>";
  return boundText(candidate, 256);
}

function basename(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || "<unnamed>";
}

export function projectTask(task: WorkObservationV2["task"]): WorkObservationV2["task"] {
  return {
    host_directive: boundText(task.host_directive, 1024),
    ...(task.reported_objective === undefined
      ? {}
      : { reported_objective: boundText(task.reported_objective, 2048) }),
    ...(task.reported_action === undefined
      ? {}
      : { reported_action: boundText(task.reported_action, 2048) }),
    ...(task.reported_context === undefined
      ? {}
      : { reported_context: projectContext(task.reported_context) }),
  };
}

export function projectHints(
  hints: WorkObservationV2["reported_hints"],
): WorkObservationV2["reported_hints"] {
  return {
    ...(hints.summary === undefined ? {} : { summary: boundText(hints.summary, 2048) }),
    ...(hints.reason === undefined ? {} : { reason: boundText(hints.reason, 2048) }),
    ...(hints.verification === undefined
      ? {}
      : { verification: hints.verification.slice(0, 16).map((item) => boundText(item, 256)) }),
  };
}

export function projectContext(
  context: NonNullable<WorkObservationV2["task"]["reported_context"]>,
): NonNullable<WorkObservationV2["task"]["reported_context"]> {
  const text = boundText(context.text, 4096);
  return {
    text,
    utf8_bytes: new TextEncoder().encode(text).byteLength,
    truncated: text !== context.text || context.truncated,
  };
}

function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function isSuccessfulExecution(status: string): boolean {
  return status === "completed" || status === "succeeded" || status === "passed";
}

export function recordRunId(record: PersistedRecord): string | null {
  return "run_id" in record && typeof record.run_id === "string" ? record.run_id : null;
}
