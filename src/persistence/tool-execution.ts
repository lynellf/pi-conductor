/** Durable execution identities and timeline checks for issue #76. */

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  assertSandboxExecutionTerminal,
  assertSandboxTerminalCorrelation,
  sandboxExecutionTerminalSchema,
} from "./sandbox-command.js";
import type { ToolExecutionSandboxReadyRecord } from "./sandbox-execution.js";
import {
  assertToolExecutionSandboxReadyRecord,
  toolExecutionSandboxReadySchema,
} from "./sandbox-execution.js";
import type { SubagentSandboxDescriptor } from "./subagent-sandbox.js";
import { subagentSandboxDescriptorSchema } from "./subagent-sandbox.js";

export type {
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
  assertToolCleanupBackend,
  type ToolExecutionCleanupConfirmedRecord,
  toolExecutionCleanupConfirmedSchema,
} from "./tool-execution-cleanup.js";

export {
  type ToolExecutionCleanupConfirmedRecord,
  toolExecutionCleanupConfirmedSchema,
} from "./tool-execution-cleanup.js";

import { toolExecutionDiagnosticSchema } from "./tool-execution-diagnostic.js";

const id = Type.String({ minLength: 1 });
const nonNegativeInteger = Type.Integer({ minimum: 0 });

/** TypeBox schema for the exact JSON shape retained at process execution start. */
export const toolExecutionStartedSchema = Type.Object(
  {
    type: Type.Literal("tool_execution_started"),
    schema_version: Type.Literal(1),
    run_id: id,
    execution_id: id,
    supervision_id: id,
    logical_session_id: id,
    role_session_id: id,
    tool_call_id: id,
    tool_name: id,
    timeout_ms: Type.Integer({ minimum: 1 }),
    recovery_count: nonNegativeInteger,
    admission: Type.Optional(toolAdmissionSchema),
    sandbox: Type.Optional(
      Type.Object(
        { child_id: id, descriptor: subagentSandboxDescriptorSchema },
        { additionalProperties: false },
      ),
    ),
    ts: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** TypeBox schema for the exact JSON shape retained at process execution terminal. */
export const toolExecutionFinishedSchema = Type.Object(
  {
    type: Type.Literal("tool_execution_finished"),
    schema_version: Type.Literal(1),
    run_id: id,
    execution_id: id,
    supervision_id: id,
    logical_session_id: id,
    role_session_id: id,
    tool_call_id: id,
    tool_name: id,
    elapsed_ms: Type.Number({ minimum: 0 }),
    recovery_count: nonNegativeInteger,
    outcome: Type.Union([
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("timed_out"),
      Type.Literal("aborted"),
      Type.Literal("cleanup_unconfirmed"),
      Type.Literal("interrupted"),
    ]),
    cleanup: Type.Union([Type.Literal("confirmed"), Type.Literal("unconfirmed")]),
    diagnostic: Type.Optional(toolExecutionDiagnosticSchema),
    sandbox: Type.Optional(sandboxExecutionTerminalSchema),
    ts: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** Durable identity and deadline captured before an executable tool starts. */
export type ToolExecutionStartedRecord = Readonly<Static<typeof toolExecutionStartedSchema>>;
/** Durable terminal result correlated with one started executable tool. */
export type ToolExecutionFinishedRecord = Readonly<Static<typeof toolExecutionFinishedSchema>>;
export type { ToolExecutionDiagnostic } from "./tool-execution-diagnostic.js";
/** Union of durable executable tool record shapes. */
export type ToolExecutionRecord =
  | ToolExecutionStartedRecord
  | ToolExecutionFinishedRecord
  | ToolExecutionCleanupConfirmedRecord
  | ToolExecutionSandboxReadyRecord;

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
  readonly started: ToolExecutionStartedRecord;
  readonly ready?: ToolExecutionSandboxReadyRecord;
  readonly finished?: ToolExecutionFinishedRecord;
  readonly cleanupConfirmed?: ToolExecutionCleanupConfirmedRecord;
}

/** Pure materialized execution state used by restart/status consumers. */
export interface ToolExecutionTimeline {
  readonly entries: readonly ToolExecutionTimelineEntry[];
  readonly unfinished: readonly ToolExecutionStartedRecord[];
  readonly unresolved: readonly ToolExecutionTimelineEntry[];
  readonly timeout_count: number;
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
      if (
        record.sandbox.child_id !== entry.started.sandbox.child_id ||
        !sameSandboxDescriptor(record.sandbox.descriptor, entry.started.sandbox.descriptor)
      )
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

function sameSandboxDescriptor(
  left: SubagentSandboxDescriptor,
  right: SubagentSandboxDescriptor,
): boolean {
  return (
    left.backend === right.backend &&
    left.execution_policy_digest === right.execution_policy_digest &&
    left.runtime_digest === right.runtime_digest &&
    left.materialization_id === right.materialization_id
  );
}

function assertMatchingIdentity(
  record: Pick<
    ToolExecutionStartedRecord,
    | "run_id"
    | "execution_id"
    | "supervision_id"
    | "logical_session_id"
    | "role_session_id"
    | "tool_call_id"
    | "tool_name"
  >,
  start: ToolExecutionStartedRecord,
  kind: string,
): void {
  for (const field of [
    "run_id",
    "execution_id",
    "supervision_id",
    "logical_session_id",
    "role_session_id",
    "tool_call_id",
    "tool_name",
  ] as const) {
    if (record[field] !== start[field])
      throw new ToolExecutionRecordError(`${kind} mismatches ${field}`);
  }
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
