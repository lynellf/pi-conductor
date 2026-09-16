/** Durable execution identities and timeline checks for issue #76. */

import { Value } from "typebox/value";
import {
  assertSandboxExecutionTerminal,
  assertSandboxTerminalCorrelation,
} from "./sandbox-command.js";
import type { AnyToolExecutionSandboxReadyRecord } from "./sandbox-execution.js";
import {
  assertToolExecutionSandboxReadyRecord,
  toolExecutionSandboxReadySchema,
} from "./sandbox-execution.js";
import { sha256Canonical } from "./trajectory-records.js";

export type {
  AnySandboxExecutionOwner,
  AnyToolExecutionSandboxReadyRecord,
  ControllerExecutionSandboxReadyRecord,
  ControllerSandboxExecutionOwner,
  SandboxExecutionHostObserver,
  SandboxExecutionOwner,
  SandboxReadyEvidence,
  VerifiedSandboxBinary,
} from "./sandbox-execution.js";
export {
  assertToolExecutionSandboxReadyRecord,
  sandboxExecutionHostObserverSchema,
  sandboxExecutionOwnerSchema,
  toolExecutionSandboxReadySchema,
  verifiedSandboxBinarySchema,
} from "./sandbox-execution.js";

import { toolAdmissionSchema } from "./tool-admission.js";
import {
  type AnyToolExecutionCleanupConfirmedRecord,
  assertToolCleanupBackend,
  toolExecutionCleanupConfirmedSchema,
} from "./tool-execution-cleanup.js";

export {
  type AnyToolExecutionCleanupConfirmedRecord,
  type ControllerExecutionCleanupConfirmedRecord,
  type ToolExecutionCleanupConfirmedRecord,
  toolExecutionCleanupConfirmedSchema,
} from "./tool-execution-cleanup.js";

import { sameControllerExecutionOrigin } from "./tool-execution-origin.js";

export type { ControllerExecutionOrigin } from "./tool-execution-origin.js";
export {
  controllerExecutionOriginSchema,
  controllerOperationMayReinvokeAfterCleanup,
} from "./tool-execution-origin.js";

export type {
  AnyToolExecutionFinishedRecord,
  AnyToolExecutionStartedRecord,
  ControllerToolExecutionFinishedRecord,
  ControllerToolExecutionStartedRecord,
  ToolExecutionFinishedRecord,
  ToolExecutionFinishedV1Record,
  ToolExecutionFinishedV2Record,
  ToolExecutionStartedRecord,
  ToolExecutionStartedV1Record,
  ToolExecutionStartedV2Record,
} from "./tool-execution-schema.js";
export {
  toolExecutionFinishedSchema,
  toolExecutionFinishedV1Schema,
  toolExecutionFinishedV2Schema,
  toolExecutionStartedSchema,
  toolExecutionStartedV1Schema,
  toolExecutionStartedV2Schema,
} from "./tool-execution-schema.js";

import type {
  AnyToolExecutionFinishedRecord,
  AnyToolExecutionStartedRecord,
} from "./tool-execution-schema.js";
import {
  toolExecutionFinishedSchema,
  toolExecutionStartedSchema,
} from "./tool-execution-schema.js";

export type { ToolExecutionDiagnostic } from "./tool-execution-diagnostic.js";
/** Union of durable executable tool record shapes. */
export type ToolExecutionRecord =
  | AnyToolExecutionStartedRecord
  | AnyToolExecutionFinishedRecord
  | AnyToolExecutionCleanupConfirmedRecord
  | AnyToolExecutionSandboxReadyRecord;

/** Typed rejection for malformed or inconsistent execution records. */
export class ToolExecutionRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolExecutionRecordError";
  }
}

/** Validate one execution record, including terminal cleanup/outcome invariants. */
export function assertToolExecutionRecord(value: unknown): asserts value is ToolExecutionRecord {
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "tool_execution_started" &&
    "admission" in value &&
    !Value.Check(toolAdmissionSchema, value.admission)
  ) {
    throw new ToolExecutionRecordError(
      "Admission evidence is invalid; recover an intact canonical log. Do not manufacture a new baseline or confirm cleanup from corrupt evidence.",
    );
  }
  const isStarted = Value.Check(toolExecutionStartedSchema, value);
  const isFinished = Value.Check(toolExecutionFinishedSchema, value);
  const isCleanupConfirmed = Value.Check(toolExecutionCleanupConfirmedSchema, value);
  const isSandboxReady = Value.Check(toolExecutionSandboxReadySchema, value);
  if (!isStarted && !isFinished && !isCleanupConfirmed && !isSandboxReady) {
    throw new ToolExecutionRecordError("invalid tool execution record");
  }
  const record = value as ToolExecutionRecord;
  if (!Number.isFinite(record.ts)) {
    throw new ToolExecutionRecordError("tool execution timestamp must be finite");
  }
  if (record.type === "tool_execution_sandbox_ready") {
    assertToolExecutionSandboxReadyRecord(record);
  } else if (record.type === "tool_execution_finished") {
    if (record.sandbox !== undefined) assertSandboxExecutionTerminal(record.sandbox);
    if (!Number.isFinite(record.elapsed_ms)) {
      throw new ToolExecutionRecordError("tool execution elapsed_ms must be finite");
    }
    if (!Number.isSafeInteger(record.recovery_count)) {
      throw new ToolExecutionRecordError("tool execution recovery_count must be a safe integer");
    }
    if (record.outcome === "timed_out" && record.cleanup !== "confirmed") {
      throw new ToolExecutionRecordError("timed_out execution requires confirmed cleanup");
    }
    if (record.outcome === "cleanup_unconfirmed" && record.cleanup !== "unconfirmed") {
      throw new ToolExecutionRecordError("cleanup_unconfirmed requires unconfirmed cleanup");
    }
    if (record.outcome !== "cleanup_unconfirmed" && record.cleanup === "unconfirmed") {
      throw new ToolExecutionRecordError(
        "unconfirmed cleanup requires cleanup_unconfirmed outcome",
      );
    }
  } else if (record.type === "tool_execution_started" && !Number.isSafeInteger(record.timeout_ms)) {
    throw new ToolExecutionRecordError("tool execution timeout_ms must be a safe integer");
  } else if (
    record.type === "tool_execution_started" &&
    !Number.isSafeInteger(record.recovery_count)
  ) {
    throw new ToolExecutionRecordError("tool execution recovery_count must be a safe integer");
  }
  if (
    record.type === "tool_execution_started" &&
    record.admission !== undefined &&
    record.sandbox !== undefined
  )
    throw new ToolExecutionRecordError(
      "sandbox start owner and legacy admission marker are mutually exclusive",
    );
  if (
    record.type === "tool_execution_cleanup_confirmed" &&
    record.operator_note.trim().length === 0
  ) {
    throw new ToolExecutionRecordError("operator note must contain non-whitespace characters");
  }
  if (record.type === "tool_execution_cleanup_confirmed" && record.operator.trim().length === 0) {
    throw new ToolExecutionRecordError("operator must contain non-whitespace characters");
  }
}

/** One execution start and its optional terminal result. */
export interface ToolExecutionTimelineEntry {
  readonly started: AnyToolExecutionStartedRecord;
  readonly ready?: AnyToolExecutionSandboxReadyRecord;
  readonly finished?: AnyToolExecutionFinishedRecord;
  readonly cleanupConfirmed?: AnyToolExecutionCleanupConfirmedRecord;
}

/** Pure materialized execution state used by restart/status consumers. */
export interface ToolExecutionTimeline {
  readonly entries: readonly ToolExecutionTimelineEntry[];
  readonly unfinished: readonly AnyToolExecutionStartedRecord[];
  readonly unresolved: readonly ToolExecutionTimelineEntry[];
  readonly timeout_count: number;
}

export type ControllerExecutionRecovery =
  | { readonly kind: "settled"; readonly outcome: AnyToolExecutionFinishedRecord["outcome"] }
  | { readonly kind: "cleanup_required" }
  | { readonly kind: "planner_reinvoke_allowed" }
  | { readonly kind: "fresh_action_required" };

/** Classify controller recovery without replaying adapter or preparation effects. */
export function materializeControllerExecutionRecovery(
  entry: ToolExecutionTimelineEntry,
): ControllerExecutionRecovery {
  const start = entry.started;
  if (start.schema_version !== 2)
    throw new ToolExecutionRecordError("controller recovery requires a controller execution");
  if (entry.finished !== undefined && entry.finished.outcome !== "cleanup_unconfirmed")
    return Object.freeze({ kind: "settled", outcome: entry.finished.outcome });
  if (entry.cleanupConfirmed === undefined) return Object.freeze({ kind: "cleanup_required" });
  return Object.freeze({
    kind:
      start.origin.operation_kind === "planner"
        ? "planner_reinvoke_allowed"
        : "fresh_action_required",
  });
}

/** Reconstruct and validate execution identity order without performing I/O. */
export function reconstructToolExecutionTimeline(
  records: readonly ToolExecutionRecord[],
): ToolExecutionTimeline {
  const entries = new Map<string, ToolExecutionTimelineEntry>();
  const supervisionIds = new Set<string>();
  let timeoutCount = 0;

  for (const record of records) {
    assertToolExecutionRecord(record);
    if (record.type === "tool_execution_started") {
      if (entries.has(record.execution_id) || supervisionIds.has(record.supervision_id)) {
        throw new ToolExecutionRecordError("duplicate tool execution identity");
      }
      supervisionIds.add(record.supervision_id);
      entries.set(record.execution_id, { started: record });
      continue;
    }

    if (record.type === "tool_execution_cleanup_confirmed") {
      const entry = entries.get(record.execution_id);
      if (entry === undefined) {
        throw new ToolExecutionRecordError("cleanup confirmation has no preceding start");
      }
      try {
        assertToolCleanupBackend(record, entry.started.sandbox, entry.ready);
      } catch (cause) {
        throw new ToolExecutionRecordError(
          cause instanceof Error ? cause.message : "invalid cleanup backend",
        );
      }
      if (entry.cleanupConfirmed !== undefined) {
        throw new ToolExecutionRecordError("duplicate cleanup confirmation");
      }
      if (
        record.schema_version === 2 &&
        record.start_record_digest !== sha256Canonical(entry.started)
      )
        throw new ToolExecutionRecordError("controller cleanup does not bind its execution start");
      if (entry.finished !== undefined && entry.finished.outcome !== "cleanup_unconfirmed")
        throw new ToolExecutionRecordError("cleanup confirmation requires an unconfirmed terminal");
      assertMatchingIdentity(record, entry.started, "cleanup confirmation");
      if (
        record.ts < entry.started.ts ||
        (entry.ready !== undefined && record.ts < entry.ready.ts) ||
        (entry.finished !== undefined && record.ts < entry.finished.ts)
      ) {
        throw new ToolExecutionRecordError("cleanup confirmation timestamp precedes execution");
      }
      entries.set(record.execution_id, { ...entry, cleanupConfirmed: record });
      continue;
    }

    if (record.type === "tool_execution_sandbox_ready") {
      const entry = entries.get(record.execution_id);
      if (entry === undefined)
        throw new ToolExecutionRecordError("sandbox ready has no preceding start");
      if (entry.ready !== undefined)
        throw new ToolExecutionRecordError("duplicate sandbox ready record");
      if (entry.finished !== undefined || entry.cleanupConfirmed !== undefined)
        throw new ToolExecutionRecordError("sandbox ready cannot follow terminal or cleanup");
      if (entry.started.sandbox === undefined)
        throw new ToolExecutionRecordError("sandbox ready requires a sandbox-enabled start");
      assertMatchingIdentity(record, entry.started, "sandbox ready");
      if (sha256Canonical(record.sandbox) !== sha256Canonical(entry.started.sandbox))
        throw new ToolExecutionRecordError("sandbox ready mismatches sandbox owner");
      if (record.ts < entry.started.ts)
        throw new ToolExecutionRecordError("sandbox ready precedes execution start");
      entries.set(record.execution_id, { ...entry, ready: record });
      continue;
    }

    const entry = entries.get(record.execution_id);
    if (entry === undefined) {
      throw new ToolExecutionRecordError("tool execution terminal has no preceding start");
    }
    if (entry.finished !== undefined) {
      throw new ToolExecutionRecordError("duplicate tool execution terminal");
    }
    if (entry.cleanupConfirmed !== undefined)
      throw new ToolExecutionRecordError("terminal cannot follow cleanup confirmation");
    const start = entry.started;
    if (start.sandbox !== undefined && entry.ready === undefined && record.outcome === "completed")
      throw new ToolExecutionRecordError(
        "sandbox execution terminal requires a preceding ready record",
      );
    assertMatchingIdentity(record, start, "tool execution terminal");
    assertSandboxTerminalCorrelation(start.sandbox, entry.ready, record);
    if (entry.ready !== undefined && record.ts < entry.ready.ts)
      throw new ToolExecutionRecordError("tool execution terminal precedes sandbox ready");
    if (record.recovery_count !== start.recovery_count) {
      throw new ToolExecutionRecordError("tool execution terminal mismatches recovery_count");
    }
    entries.set(record.execution_id, { ...entry, finished: record });
    if (record.outcome === "timed_out") timeoutCount += 1;
  }

  const materialized = [...entries.values()];
  return {
    entries: Object.freeze(materialized),
    unfinished: Object.freeze(
      materialized
        .filter((entry) => entry.finished === undefined && entry.cleanupConfirmed === undefined)
        .map((entry) => entry.started),
    ),
    unresolved: Object.freeze(
      materialized.filter(
        (entry) =>
          entry.cleanupConfirmed === undefined &&
          (entry.finished === undefined || entry.finished.outcome === "cleanup_unconfirmed"),
      ),
    ),
    timeout_count: timeoutCount,
  };
}

function assertMatchingIdentity(
  record:
    | AnyToolExecutionFinishedRecord
    | AnyToolExecutionCleanupConfirmedRecord
    | AnyToolExecutionSandboxReadyRecord,
  start: AnyToolExecutionStartedRecord,
  kind: string,
): void {
  for (const field of ["run_id", "execution_id", "supervision_id"] as const) {
    if (record[field] !== start[field])
      throw new ToolExecutionRecordError(`${kind} mismatches ${field}`);
  }
  if (record.schema_version !== start.schema_version)
    throw new ToolExecutionRecordError(`${kind} mismatches schema_version`);
  if (start.schema_version === 1 && record.schema_version === 1) {
    for (const field of [
      "logical_session_id",
      "role_session_id",
      "tool_call_id",
      "tool_name",
    ] as const)
      if (record[field] !== start[field])
        throw new ToolExecutionRecordError(`${kind} mismatches ${field}`);
    return;
  }
  if (
    start.schema_version !== 2 ||
    record.schema_version !== 2 ||
    !sameControllerExecutionOrigin(record.origin, start.origin)
  )
    throw new ToolExecutionRecordError(`${kind} mismatches controller origin`);
}

/** Recognize tool execution records before full schema validation. */
export function isToolExecutionRecord(value: unknown): value is ToolExecutionRecord {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === "tool_execution_started" ||
    type === "tool_execution_finished" ||
    type === "tool_execution_cleanup_confirmed" ||
    type === "tool_execution_sandbox_ready"
  );
}
