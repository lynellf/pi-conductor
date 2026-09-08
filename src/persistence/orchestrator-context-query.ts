import type { PersistedRecord } from "./log.js";
import type {
  ContextBoundaryCommittedRecord,
  ContextCompactionRecord,
  ContextDeliveryCommittedRecord,
  ContextEpochStartedRecord,
  ContextInvocationStartedRecord,
} from "./orchestrator-context.js";
import { assertOrchestratorContextRecord } from "./orchestrator-context.js";

/** Current pure view of one run's orchestrator context provenance. */
export interface OrchestratorContextState {
  readonly epoch: ContextEpochStartedRecord | null;
  readonly boundary: ContextBoundaryCommittedRecord | null;
  readonly pendingInvocation: ContextInvocationStartedRecord | null;
  readonly deliveries: readonly ContextDeliveryCommittedRecord[];
  readonly compactions: readonly ContextCompactionRecord[];
}

/** Actionable corruption or restoration rejection in the context timeline. */
export class ContextQueryError extends Error {
  readonly code = "invalid-orchestrator-context";

  constructor(message: string) {
    super(message);
    this.name = "ContextQueryError";
  }
}

/** Query one run/role's append-only context records without reading other runs. */
export function queryOrchestratorContext(
  records: readonly PersistedRecord[],
  runId: string,
  role: string,
): OrchestratorContextState {
  let epoch: ContextEpochStartedRecord | null = null;
  let boundary: ContextBoundaryCommittedRecord | null = null;
  let pendingInvocation: ContextInvocationStartedRecord | null = null;
  let currentDelivery: ContextDeliveryCommittedRecord | null = null;
  let invocationStarted = false;
  let invocationTerminal = false;
  const deliveries: ContextDeliveryCommittedRecord[] = [];
  const compactions: ContextCompactionRecord[] = [];
  const deliveryIds = new Set<string>();
  const requestIds = new Set<string>();
  const invocationIds = new Set<string>();
  const conversationIds = new Set<string>();
  const sessionFiles = new Set<string>();

  for (const record of records) {
    if (isLifecycleRecord(record) && record.run_id === runId && record.role === role) {
      if (pendingInvocation === null) {
        throw new ContextQueryError("terminal lifecycle record precedes its context invocation");
      }
      if (
        record.role_session_id !== pendingInvocation.role_session_id ||
        record.session_file !== pendingInvocation.session_file ||
        (record.conversation_id !== undefined &&
          record.conversation_id !== pendingInvocation.conversation_id)
      ) {
        throw new ContextQueryError(
          "terminal lifecycle record does not match the pending invocation",
        );
      }
      if (record.type === "session_started") {
        if (invocationStarted) throw new ContextQueryError("session start was duplicated");
        invocationStarted = true;
      } else {
        if (!invocationStarted)
          throw new ContextQueryError("terminal lifecycle record lacks session start");
        if (invocationTerminal)
          throw new ContextQueryError("terminal lifecycle record was duplicated");
        invocationTerminal = true;
      }
      continue;
    }
    if (!isContextRecord(record) || record.run_id !== runId) continue;
    assertOrchestratorContextRecord(record);
    if (record.role !== role) {
      throw new ContextQueryError(
        `context record '${record.type}' names role '${record.role}', expected '${role}'`,
      );
    }
    if (record.type === "context_epoch_started") {
      if (record.reason === "start") {
        if (epoch !== null || record.epoch !== 1 || record.previous_epoch !== null) {
          throw new ContextQueryError(
            "context epoch start must be the first epoch with no predecessor",
          );
        }
      } else {
        if (
          epoch === null ||
          record.epoch !== epoch.epoch + 1 ||
          record.previous_epoch !== epoch.epoch
        ) {
          throw new ContextQueryError("context reset must immediately follow the previous epoch");
        }
        if (!sameCompaction(record, epoch)) {
          throw new ContextQueryError("context compaction settings changed across epochs");
        }
      }
      epoch = record;
      boundary = null;
      pendingInvocation = null;
      currentDelivery = null;
      invocationStarted = false;
      invocationTerminal = false;
      deliveries.length = 0;
      compactions.length = 0;
      continue;
    }
    if (epoch === null || record.epoch !== epoch.epoch) {
      throw new ContextQueryError(`context record '${record.type}' has no current epoch`);
    }
    if (record.type === "context_invocation_started") {
      if (pendingInvocation !== null)
        throw new ContextQueryError("context invocation already pending");
      if (invocationIds.has(record.role_session_id))
        throw new ContextQueryError("logical context session identity reused");
      if (conversationIds.has(record.conversation_id) || sessionFiles.has(record.session_file))
        throw new ContextQueryError("physical context identity reused");
      if (
        (boundary === null && record.source_boundary !== null) ||
        (boundary !== null &&
          (record.source_boundary === null ||
            !sameBoundaryReference(record.source_boundary, boundary)))
      ) {
        throw new ContextQueryError(
          "invocation source boundary is not the latest committed boundary",
        );
      }
      invocationIds.add(record.role_session_id);
      conversationIds.add(record.conversation_id);
      sessionFiles.add(record.session_file);
      pendingInvocation = record;
      currentDelivery = null;
      invocationStarted = false;
      invocationTerminal = false;
      continue;
    }
    if (pendingInvocation === null)
      throw new ContextQueryError(`context record '${record.type}' has no pending invocation`);
    if (record.role_session_id !== pendingInvocation.role_session_id) {
      throw new ContextQueryError(
        `context record '${record.type}' does not match the pending invocation`,
      );
    }
    if (
      (record.type === "context_delivery_committed" || record.type === "context_compaction") &&
      (!invocationStarted || invocationTerminal)
    ) {
      throw new ContextQueryError(
        "context record cannot follow a terminal or missing session start",
      );
    }
    if (
      record.type === "context_delivery_committed" &&
      (record.conversation_id !== pendingInvocation.conversation_id ||
        record.session_file !== pendingInvocation.session_file)
    ) {
      throw new ContextQueryError(
        "context delivery physical identity does not match the pending invocation",
      );
    }
    if (record.type === "context_delivery_committed") {
      if (deliveryIds.has(record.delivery_id))
        throw new ContextQueryError("context delivery ID was reused");
      if (currentDelivery !== null)
        throw new ContextQueryError("context seed was delivered more than once");
      deliveryIds.add(record.delivery_id);
      deliveries.push(record);
      currentDelivery = record;
    } else if (record.type === "context_compaction") {
      if (requestIds.has(record.request_id))
        throw new ContextQueryError("compaction request ID was reused");
      requestIds.add(record.request_id);
      compactions.push(record);
    } else {
      if (!invocationStarted || !invocationTerminal) {
        throw new ContextQueryError("committed boundary lacks terminal lifecycle evidence");
      }
      if (
        record.conversation_id !== pendingInvocation.conversation_id ||
        record.session_file !== pendingInvocation.session_file
      ) {
        throw new ContextQueryError(
          "committed boundary physical identity does not match the pending invocation",
        );
      }
      if (currentDelivery === null) {
        throw new ContextQueryError("committed boundary does not follow the delivered seed tip");
      }
      boundary = record;
      pendingInvocation = null;
    }
  }
  return {
    epoch,
    boundary,
    pendingInvocation,
    deliveries: Object.freeze([...deliveries]),
    compactions: Object.freeze([...compactions]),
  };
}

/** Reject unresolved or unknown-usage context before restoration. */
export function assertRestorableOrchestratorContext(
  records: readonly PersistedRecord[],
  runId: string,
  role: string,
): OrchestratorContextState {
  const state = queryOrchestratorContext(records, runId, role);
  if (state.epoch === null) throw new ContextQueryError("context epoch is missing");
  if (state.pendingInvocation !== null)
    throw new ContextQueryError("context invocation is pending");
  if (state.compactions.some((record) => record.usage === null)) {
    throw new ContextQueryError("context compaction usage is unknown");
  }
  return state;
}

function isContextRecord(
  record: PersistedRecord,
): record is Extract<PersistedRecord, { readonly type: `context_${string}` }> {
  return record.type.startsWith("context_");
}

function isLifecycleRecord(
  record: PersistedRecord,
): record is Extract<
  PersistedRecord,
  { readonly type: "session_started" | "session_ended" | "session_failed" }
> {
  return (
    record.type === "session_started" ||
    record.type === "session_ended" ||
    record.type === "session_failed"
  );
}

function sameCompaction(
  current: ContextEpochStartedRecord,
  previous: ContextEpochStartedRecord,
): boolean {
  return (
    current.compaction.enabled === previous.compaction.enabled &&
    current.compaction.reserve_tokens === previous.compaction.reserve_tokens &&
    current.compaction.keep_recent_tokens === previous.compaction.keep_recent_tokens
  );
}

function sameBoundaryReference(
  source: NonNullable<ContextInvocationStartedRecord["source_boundary"]>,
  boundary: ContextBoundaryCommittedRecord | null,
): boolean {
  return (
    boundary !== null &&
    source.role_session_id === boundary.role_session_id &&
    source.conversation_id === boundary.conversation_id &&
    source.session_file === boundary.session_file &&
    source.leaf_id === boundary.leaf_id &&
    source.history_sha256 === boundary.history_sha256
  );
}
