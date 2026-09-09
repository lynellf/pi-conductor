import type { PersistedRecord } from "./log.js";
import type {
  ContextCompactionRecord,
  ContextCompactionStartedRecord,
  ContextUsage,
} from "./orchestrator-context.js";
import { assertOrchestratorContextRecord } from "./orchestrator-context.js";
import { queryOrchestratorContext } from "./orchestrator-context-query.js";

/** Bounded operator state for one retained orchestrator context epoch. */
export type OrchestratorContextInspectionStatus =
  | "active"
  | "committed"
  | "reset"
  | "pending_compaction"
  | "unknown";

/** A committed boundary reference without any transcript content. */
export interface OrchestratorContextBoundaryInspection {
  readonly roleSessionId: string;
  readonly conversationId: string;
  readonly sessionFile: string;
  readonly tipId: string;
  readonly historySha256: string;
}

/** The selected physical conversation for an unresolved invocation. */
export interface OrchestratorContextInvocationInspection {
  readonly roleSessionId: string;
  readonly conversationId: string;
  readonly sessionFile: string;
  readonly epoch: number;
  readonly model: string | null;
}

/** A bounded compaction outcome, including explicit unavailable usage. */
export interface OrchestratorContextCompactionInspection {
  readonly epoch: number;
  readonly roleSessionId: string;
  readonly requestId: string;
  readonly outcome: "completed" | "failed";
  readonly usage: ContextUsage | null;
  readonly diagnostic: string | null;
  readonly beforeTipId: string | null;
  readonly afterTipId: string | null;
}

/** A compaction request that has no durable outcome yet. */
export interface OrchestratorContextPendingCompactionInspection {
  readonly epoch: number;
  readonly roleSessionId: string;
  readonly requestId: string;
  readonly beforeTipId: string | null;
}

/** Unknown compaction usage retained for operator accounting diagnosis. */
export interface OrchestratorContextUnknownCompactionInspection {
  readonly epoch: number;
  readonly roleSessionId: string;
  readonly requestId: string;
  readonly diagnostic: string;
}

/**
 * Pure, transcript-free retained-context inspection (§87 bounded operator surface).
 * Returns `null` when the run has no context policy records.
 */
export interface OrchestratorContextInspection {
  readonly status: OrchestratorContextInspectionStatus;
  readonly epoch: number | null;
  readonly epochReason: "start" | "reset" | null;
  readonly committedBoundary: OrchestratorContextBoundaryInspection | null;
  readonly activeInvocation: OrchestratorContextInvocationInspection | null;
  readonly pendingCompactions: readonly OrchestratorContextPendingCompactionInspection[];
  readonly lastCompaction: OrchestratorContextCompactionInspection | null;
  readonly unknownCompactions: readonly OrchestratorContextUnknownCompactionInspection[];
  readonly diagnostic?: string;
}

/**
 * Project retained context records into bounded operator state without SDK or file I/O.
 * Malformed timelines become an `unknown` diagnosis so status inspection never claims
 * that a missing boundary means fresh context.
 */
export function inspectOrchestratorContext(
  records: readonly PersistedRecord[],
  runId: string,
  role: string,
): OrchestratorContextInspection | null {
  if (!records.some((record) => isContextRecord(record) && record.run_id === runId)) {
    return null;
  }

  try {
    const state = queryOrchestratorContext(records, runId, role);
    const compactionRecords = contextCompactions(records, runId, role);
    const compactionStarts = contextCompactionStarts(records, runId, role);
    const completedRequestIds = new Set(compactionRecords.map((record) => record.request_id));
    const currentPendingRequestIds = new Set(
      state.pendingCompactions.map((record) => record.request_id),
    );
    const unknownCompactions = compactionRecords
      .filter((record) => record.usage === null)
      .map(toUnknownCompaction)
      .concat(
        compactionStarts
          .filter(
            (record) =>
              !completedRequestIds.has(record.request_id) &&
              !currentPendingRequestIds.has(record.request_id),
          )
          .map(toUnknownStartedCompaction),
      );
    const lastCompaction =
      compactionRecords.length === 0
        ? null
        : toCompactionInspection(
            compactionRecords[compactionRecords.length - 1] as ContextCompactionRecord,
          );
    const status = deriveStatus(state, unknownCompactions.length > 0);
    return freezeInspection({
      status,
      epoch: state.epoch?.epoch ?? null,
      epochReason: state.epoch?.reason ?? null,
      committedBoundary: state.boundary === null ? null : toBoundaryInspection(state.boundary),
      activeInvocation:
        state.pendingInvocation === null ? null : toInvocationInspection(state.pendingInvocation),
      pendingCompactions: state.pendingCompactions.map(toPendingCompaction),
      lastCompaction,
      unknownCompactions,
    });
  } catch (error) {
    return freezeInspection({
      status: "unknown",
      epoch: null,
      epochReason: null,
      committedBoundary: null,
      activeInvocation: null,
      pendingCompactions: [],
      lastCompaction: null,
      unknownCompactions: [],
      diagnostic: boundedDiagnostic(error),
    });
  }
}

function deriveStatus(
  state: ReturnType<typeof queryOrchestratorContext>,
  hasUnknownCompaction: boolean,
): OrchestratorContextInspectionStatus {
  if (hasUnknownCompaction) return "unknown";
  if (state.pendingCompactions.length > 0) return "pending_compaction";
  if (state.pendingInvocation !== null) return "active";
  if (state.epoch?.reason === "reset" && state.boundary === null) return "reset";
  if (state.boundary !== null) return "committed";
  return "active";
}

function contextCompactions(
  records: readonly PersistedRecord[],
  runId: string,
  role: string,
): ContextCompactionRecord[] {
  const result: ContextCompactionRecord[] = [];
  for (const record of records) {
    if (record.type !== "context_compaction" || record.run_id !== runId) continue;
    if (record.role !== role) {
      throw new Error(`context compaction names role '${record.role}', expected '${role}'`);
    }
    assertOrchestratorContextRecord(record);
    result.push(record);
  }
  return result;
}

function contextCompactionStarts(
  records: readonly PersistedRecord[],
  runId: string,
  role: string,
): ContextCompactionStartedRecord[] {
  const result: ContextCompactionStartedRecord[] = [];
  for (const record of records) {
    if (record.type !== "context_compaction_started" || record.run_id !== runId) continue;
    if (record.role !== role) {
      throw new Error(`context compaction names role '${record.role}', expected '${role}'`);
    }
    assertOrchestratorContextRecord(record);
    result.push(record);
  }
  return result;
}

function toBoundaryInspection(
  record: Extract<PersistedRecord, { type: "context_boundary_committed" }>,
): OrchestratorContextBoundaryInspection {
  return {
    roleSessionId: record.role_session_id,
    conversationId: record.conversation_id,
    sessionFile: record.session_file,
    tipId: record.leaf_id,
    historySha256: record.history_sha256,
  };
}

function toInvocationInspection(
  record: Extract<PersistedRecord, { type: "context_invocation_started" }>,
): OrchestratorContextInvocationInspection {
  return {
    roleSessionId: record.role_session_id,
    conversationId: record.conversation_id,
    sessionFile: record.session_file,
    epoch: record.epoch,
    model: record.model,
  };
}

function toPendingCompaction(
  record: ContextCompactionStartedRecord,
): OrchestratorContextPendingCompactionInspection {
  return {
    epoch: record.epoch,
    roleSessionId: record.role_session_id,
    requestId: record.request_id,
    beforeTipId: record.before_leaf_id,
  };
}

function toCompactionInspection(
  record: ContextCompactionRecord,
): OrchestratorContextCompactionInspection {
  return {
    epoch: record.epoch,
    roleSessionId: record.role_session_id,
    requestId: record.request_id,
    outcome: record.outcome,
    usage: record.usage,
    diagnostic: record.diagnostic,
    beforeTipId: record.before_leaf_id,
    afterTipId: record.after_leaf_id,
  };
}

function toUnknownCompaction(
  record: ContextCompactionRecord,
): OrchestratorContextUnknownCompactionInspection {
  return {
    epoch: record.epoch,
    roleSessionId: record.role_session_id,
    requestId: record.request_id,
    diagnostic: record.diagnostic ?? "context compaction usage is unavailable",
  };
}

function toUnknownStartedCompaction(
  record: ContextCompactionStartedRecord,
): OrchestratorContextUnknownCompactionInspection {
  return {
    epoch: record.epoch,
    roleSessionId: record.role_session_id,
    requestId: record.request_id,
    diagnostic: "context compaction started without an outcome",
  };
}

function freezeInspection(
  inspection: Omit<OrchestratorContextInspection, "diagnostic"> & {
    readonly diagnostic?: string;
  },
): OrchestratorContextInspection {
  return Object.freeze({
    ...inspection,
    ...(inspection.diagnostic === undefined ? {} : { diagnostic: inspection.diagnostic }),
    pendingCompactions: Object.freeze([...inspection.pendingCompactions]),
    unknownCompactions: Object.freeze([...inspection.unknownCompactions]),
  });
}

function boundedDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : "invalid orchestrator context timeline";
  return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}

function isContextRecord(
  record: PersistedRecord,
): record is Extract<PersistedRecord, { readonly type: `context_${string}` }> {
  return record.type.startsWith("context_");
}
