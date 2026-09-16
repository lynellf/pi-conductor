/** Atomic delegated-task acceptance ledger — asynchronous delegation §1. */

import { Value } from "typebox/value";
import type { DelegateSubmissionArgs } from "../seam/schema.js";
import { assertAcceptedChildLifecycle } from "./delegation-lifecycle-schema.js";
import {
  type DelegationAcceptedChild,
  type DelegationSubmissionAcceptedRecord,
  delegationSubmissionAcceptedSchema,
} from "./delegation-task-schema.js";
import type {
  PersistedRecord,
  SubagentCompletedRecord,
  SubagentFailedRecord,
  SubagentStartedRecord,
} from "./log.js";
import { type SubagentSandboxDescriptor, sandboxBoundFingerprint } from "./subagent-sandbox.js";
import { sha256Canonical } from "./trajectory-records.js";

export type {
  ControllerAdmissionOrigin,
  DelegationAcceptedChild,
  DelegationSubmissionAcceptedRecord,
} from "./delegation-task-schema.js";
export {
  controllerActionAdmissionOriginSchema,
  delegationAdmissionOriginSchema,
  delegationSubmissionAcceptedSchema,
  delegationSubmissionAcceptedV1Schema,
  delegationSubmissionAcceptedV2Schema,
  sdkToolCallAdmissionOriginSchema,
} from "./delegation-task-schema.js";

/** Typed rejection for malformed or inconsistent accepted-task records. */
export class DelegationTaskRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelegationTaskRecordError";
  }
}

/** Validate one strict acceptance record. */
export function assertDelegationSubmissionAccepted(
  value: unknown,
): asserts value is DelegationSubmissionAcceptedRecord {
  if (!Value.Check(delegationSubmissionAcceptedSchema, value))
    throw new DelegationTaskRecordError("invalid delegation submission acceptance");
  const record = value as DelegationSubmissionAcceptedRecord;
  if (!Number.isFinite(record.ts) || record.ts < 0)
    throw new DelegationTaskRecordError("acceptance timestamp must be finite");
  if (new Set(record.children.map((entry) => entry.child_id)).size !== record.children.length)
    throw new DelegationTaskRecordError("accepted child IDs must be unique");
  const hasSandbox = record.children.some((entry) => entry.sandbox !== undefined);
  if (hasSandbox !== (record.request_fingerprint !== undefined))
    throw new DelegationTaskRecordError(
      "sandbox acceptance requires request_fingerprint and no-sandbox acceptance forbids it",
    );
  if (
    hasSandbox &&
    record.input_fingerprint !==
      sandboxBoundFingerprint(
        record.request_fingerprint as string,
        record.children.map((entry) => entry.sandbox),
      )
  )
    throw new DelegationTaskRecordError("sandbox acceptance fingerprint does not bind authority");
  if (record.schema_version === 2 && record.origin.kind === "controller_action") {
    const acceptedArgsFingerprint = sha256Canonical(record.accepted_args);
    if (acceptedArgsFingerprint !== (record.request_fingerprint ?? record.input_fingerprint))
      throw new DelegationTaskRecordError(
        "controller accepted arguments do not match the durable request fingerprint",
      );
    if (
      record.logical_parent_id !==
      controllerLogicalParentId(
        record.run_id,
        record.origin.controller_id,
        record.origin.definition_digest,
      )
    )
      throw new DelegationTaskRecordError("controller logical parent identity mismatch");
  }
}

/** Derive the canonical submission identity from its durable parent/tool tuple. */
export function delegationSubmissionId(
  runId: string,
  logicalParentId: string,
  toolCallId: string,
): string {
  if (runId.length === 0 || logicalParentId.length === 0 || toolCallId.length === 0)
    throw new DelegationTaskRecordError("submission identity fields must be non-empty");
  return JSON.stringify([runId, logicalParentId, toolCallId]);
}

/** Derive a controller's stable parent identity independently of activation epochs. */
export function controllerLogicalParentId(
  runId: string,
  controllerId: string,
  definitionDigest: string,
): string {
  if (runId.length === 0 || controllerId.length === 0 || !/^[a-f0-9]{64}$/.test(definitionDigest))
    throw new DelegationTaskRecordError("controller logical parent identity fields are invalid");
  return JSON.stringify(["controller", runId, controllerId, definitionDigest]);
}

/** Derive a controller submission ID without fabricating an SDK tool call. */
export function controllerDelegationSubmissionId(
  runId: string,
  logicalParentId: string,
  actionId: string,
): string {
  if (runId.length === 0 || logicalParentId.length === 0 || actionId.length === 0)
    throw new DelegationTaskRecordError("controller submission identity fields must be non-empty");
  return JSON.stringify(["controller", runId, logicalParentId, actionId]);
}

/** Return controller-retained exact accepted arguments, if this record has them. */
export function acceptedDelegationArgs(
  record: DelegationSubmissionAcceptedRecord,
): DelegateSubmissionArgs | null {
  return record.schema_version === 2 && record.origin.kind === "controller_action"
    ? record.accepted_args
    : null;
}

function isAccepted(record: PersistedRecord): record is DelegationSubmissionAcceptedRecord {
  return record.type === "delegation_submission_accepted";
}
function isStarted(record: PersistedRecord): record is SubagentStartedRecord {
  return record.type === "subagent_started";
}
function isTerminal(
  record: PersistedRecord,
): record is SubagentCompletedRecord | SubagentFailedRecord {
  return record.type === "subagent_completed" || record.type === "subagent_failed";
}

function matchesChild(
  accepted: DelegationAcceptedChild,
  record: SubagentStartedRecord | SubagentCompletedRecord | SubagentFailedRecord,
): boolean {
  return (
    accepted.child_id === record.child_id &&
    accepted.task_id === record.task_id &&
    accepted.subagent === record.subagent &&
    accepted.model === record.model &&
    accepted.branch === record.branch &&
    accepted.worktree_path === record.worktree_path &&
    accepted.base_commit === record.base_commit
  );
}

function sameSandbox(
  accepted: SubagentSandboxDescriptor | undefined,
  started: SubagentSandboxDescriptor | undefined,
): boolean {
  if (accepted === undefined || started === undefined) return accepted === started;
  return (
    accepted.backend === started.backend &&
    accepted.execution_policy_digest === started.execution_policy_digest &&
    accepted.runtime_digest === started.runtime_digest &&
    accepted.materialization_id === started.materialization_id
  );
}

function validateQueuedTerminal(record: SubagentCompletedRecord | SubagentFailedRecord): void {
  if (
    record.type !== "subagent_failed" ||
    (record.status !== "cancelled" && record.status !== "failed") ||
    record.session_file !== null ||
    record.usage !== null
  ) {
    throw new DelegationTaskRecordError("queued child terminal is not permitted");
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Validate accepted submissions and their later physical lifecycle records. */
export function assertDelegationTaskTimeline(records: readonly PersistedRecord[]): void {
  const accepted = new Map<string, DelegationAcceptedChild>();
  const childSubmissions = new Map<string, DelegationSubmissionAcceptedRecord>();
  const submissions = new Set<string>();
  const terminals = new Set<string>();
  const orphanTerminals = new Set<string>();
  const started = new Map<string, SubagentStartedRecord>();
  const orphanStarts = new Set<string>();
  for (const record of records) {
    if (isAccepted(record)) {
      assertDelegationSubmissionAccepted(record);
      if (submissions.has(record.submission_id))
        throw new DelegationTaskRecordError("duplicate delegation submission acceptance");
      if (record.submission_id !== expectedSubmissionId(record))
        throw new DelegationTaskRecordError("delegation submission identity mismatch");
      submissions.add(record.submission_id);
      for (const entry of record.children) {
        if (
          accepted.has(entry.child_id) ||
          orphanTerminals.has(entry.child_id) ||
          orphanStarts.has(entry.child_id)
        )
          throw new DelegationTaskRecordError("duplicate or orphan accepted child");
        accepted.set(entry.child_id, entry);
        childSubmissions.set(entry.child_id, record);
      }
      continue;
    }
    if (isStarted(record)) {
      const entry = accepted.get(record.child_id);
      if (entry === undefined) {
        if (record.sandbox !== undefined)
          throw new DelegationTaskRecordError("sandbox child start has no accepted submission");
        orphanStarts.add(record.child_id);
        continue;
      }
      assertAcceptedChildLifecycle(record);
      if (started.has(record.child_id) || terminals.has(record.child_id))
        throw new DelegationTaskRecordError("duplicate delegated child start");
      const submission = childSubmissions.get(record.child_id);
      if (
        submission === undefined ||
        !matchesChild(entry, record) ||
        !sameSandbox(entry.sandbox, record.sandbox) ||
        record.run_id !== submission.run_id ||
        !nonEmpty(record.session_file) ||
        !Number.isFinite(record.ts) ||
        record.ts < 0 ||
        record.parent_role === undefined ||
        record.parent_visit_index === undefined ||
        !Number.isSafeInteger(record.parent_visit_index) ||
        record.parent_visit_index < 0
      )
        throw new DelegationTaskRecordError("delegated child start identity mismatch");
      const parentRole = record.parent_role;
      const parentVisitIndex = record.parent_visit_index;
      if (
        parentRole !== submission.parent_role ||
        parentVisitIndex !== submission.parent_visit_index
      )
        throw new DelegationTaskRecordError("delegated child parent identity mismatch");
      if (
        record.task_fingerprint !== undefined &&
        record.task_fingerprint !== entry.task_fingerprint
      )
        throw new DelegationTaskRecordError("delegated child task fingerprint mismatch");
      if (
        record.projection_fingerprint !== undefined &&
        (record.projection_fingerprint.kind !== entry.projection_fingerprint.kind ||
          record.projection_fingerprint.path_count !== entry.projection_fingerprint.path_count ||
          record.projection_fingerprint.sha256 !== entry.projection_fingerprint.sha256)
      )
        throw new DelegationTaskRecordError("delegated child projection fingerprint mismatch");
      started.set(record.child_id, record);
      continue;
    }
    if (!isTerminal(record)) continue;
    const entry = accepted.get(record.child_id);
    if (entry === undefined) {
      orphanTerminals.add(record.child_id);
      continue;
    }
    assertAcceptedChildLifecycle(record);
    if (terminals.has(record.child_id))
      throw new DelegationTaskRecordError("duplicate delegated child terminal");
    const submission = childSubmissions.get(record.child_id);
    if (
      submission === undefined ||
      record.run_id !== submission.run_id ||
      !matchesChild(entry, record)
    )
      throw new DelegationTaskRecordError("delegated child terminal identity mismatch");
    const startedRecord = started.get(record.child_id);
    if (startedRecord !== undefined) {
      if (record.session_file !== startedRecord.session_file)
        throw new DelegationTaskRecordError("delegated child session identity mismatch");
    } else {
      validateQueuedTerminal(record);
    }
    terminals.add(record.child_id);
  }
}

function expectedSubmissionId(record: DelegationSubmissionAcceptedRecord): string {
  if (record.schema_version === 1)
    return delegationSubmissionId(record.run_id, record.logical_parent_id, record.tool_call_id);
  if (record.origin.kind === "sdk_tool_call")
    return delegationSubmissionId(
      record.run_id,
      record.logical_parent_id,
      record.origin.tool_call_id,
    );
  return controllerDelegationSubmissionId(
    record.run_id,
    record.logical_parent_id,
    record.origin.action_id,
  );
}

/** Return accepted child entries that have no terminal result yet. */
export function pendingDelegationChildren(
  records: readonly PersistedRecord[],
): readonly DelegationAcceptedChild[] {
  assertDelegationTaskTimeline(records);
  const terminalIds = new Set(records.filter(isTerminal).map((record) => record.child_id));
  return Object.freeze(
    records
      .filter(isAccepted)
      .flatMap((record) => record.children)
      .filter((childEntry) => !terminalIds.has(childEntry.child_id)),
  );
}

/** Return terminal records belonging to accepted children, in log order. */
export function acceptedDelegationResults(
  records: readonly PersistedRecord[],
): readonly (SubagentCompletedRecord | SubagentFailedRecord)[] {
  assertDelegationTaskTimeline(records);
  const acceptedIds = new Set(
    records.filter(isAccepted).flatMap((record) => record.children.map((entry) => entry.child_id)),
  );
  return Object.freeze(
    records.filter(
      (record): record is SubagentCompletedRecord | SubagentFailedRecord =>
        isTerminal(record) && acceptedIds.has(record.child_id),
    ),
  );
}

/** Count accepted child slots consumed by one logical parent invocation. */
export function spentDelegationSlots(
  records: readonly PersistedRecord[],
  logicalParentId: string,
): number {
  assertDelegationTaskTimeline(records);
  return records
    .filter(
      (record): record is DelegationSubmissionAcceptedRecord =>
        isAccepted(record) && record.logical_parent_id === logicalParentId,
    )
    .reduce((total, record) => total + record.children.length, 0);
}
