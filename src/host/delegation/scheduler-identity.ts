/** Durable source identities and accepted-record construction for native admission. */

import type {
  ControllerAdmissionOrigin,
  DelegationSubmissionAcceptedRecord,
} from "../../persistence/delegation-task.js";
import {
  controllerDelegationSubmissionId,
  controllerLogicalParentId,
  delegationSubmissionId,
} from "../../persistence/delegation-task.js";
import type { DelegateSubmissionArgs } from "../../seam/schema.js";
import type { PreparedDelegateChild } from "./admission.js";

/** Static source identity for every submission owned by one scheduler scope. */
export type DelegationSchedulerOrigin =
  | { readonly kind: "sdk_tool_call" }
  | {
      readonly kind: "controller";
      readonly controllerId: string;
      readonly definitionDigest: string;
    };

/** Scheduler identity whose controller form remains stable across activations. */
export interface DelegationSchedulerIdentity {
  readonly runId: string;
  readonly logicalParentId: string;
  readonly parentRole: string;
  readonly parentVisitIndex: number;
  /** Omitted retains the legacy SDK tool-call submission contract. */
  readonly origin?: DelegationSchedulerOrigin;
}

/** Real controller action source, distinct from Pi SDK tool-call identity. */
export interface ControllerSchedulerSubmission {
  readonly kind: "controller_action";
  readonly actionId: string;
  readonly activationId: string;
}

/** One scheduler submission source. */
export type SchedulerSubmission = string | ControllerSchedulerSubmission;

/** Validate and return the controller scope for a controller-owned scheduler. */
export function controllerScope(identity: DelegationSchedulerIdentity): {
  readonly controllerId: string;
  readonly definitionDigest: string;
} | null {
  if (identity.origin?.kind !== "controller") return null;
  const expected = controllerLogicalParentId(
    identity.runId,
    identity.origin.controllerId,
    identity.origin.definitionDigest,
  );
  if (identity.logicalParentId !== expected)
    throw new Error("controller scheduler logical parent identity mismatch");
  return identity.origin;
}

/** Derive the durable submission ID from a real SDK or controller source. */
export function schedulerSubmissionId(
  identity: DelegationSchedulerIdentity,
  source: SchedulerSubmission,
): string {
  if (typeof source === "string") {
    if (controllerScope(identity) !== null)
      throw new Error("controller scheduler requires a controller action identity");
    return delegationSubmissionId(identity.runId, identity.logicalParentId, source);
  }
  if (controllerScope(identity) === null)
    throw new Error("SDK scheduler cannot accept a controller action identity");
  return controllerDelegationSubmissionId(
    identity.runId,
    identity.logicalParentId,
    source.actionId,
  );
}

/** Create the schema-versioned durable acceptance record after host preparation. */
export function acceptedDelegationRecord(
  identity: DelegationSchedulerIdentity,
  source: SchedulerSubmission,
  input: DelegateSubmissionArgs,
  submissionId: string,
  fingerprint: string,
  rawRequestFingerprint: string,
  tasks: readonly PreparedDelegateChild[],
): DelegationSubmissionAcceptedRecord {
  const common = {
    type: "delegation_submission_accepted" as const,
    run_id: identity.runId,
    submission_id: submissionId,
    logical_parent_id: identity.logicalParentId,
    parent_role: identity.parentRole,
    parent_visit_index: identity.parentVisitIndex,
    input_fingerprint: fingerprint,
    ...(tasks.some(
      (task) => task.sandbox !== undefined || task.resolvedSourceWorkspace !== undefined,
    )
      ? { request_fingerprint: rawRequestFingerprint }
      : {}),
    children: tasks.map((task) => acceptedChild(task)),
    ts: Date.now(),
  };
  if (typeof source === "string") return { ...common, schema_version: 1, tool_call_id: source };
  const scope = controllerScope(identity);
  if (scope === null) throw new Error("SDK scheduler cannot create controller acceptance");
  const origin: ControllerAdmissionOrigin = {
    kind: "controller_action",
    controller_id: scope.controllerId,
    definition_digest: scope.definitionDigest,
    action_id: source.actionId,
    activation_id: source.activationId,
  };
  return tasks.some((task) => task.resolvedSourceWorkspace !== undefined)
    ? { ...common, schema_version: 3, origin, accepted_args: input }
    : { ...common, schema_version: 2, origin, accepted_args: input };
}

/** Match a persisted acceptance to exactly one legacy or controller scheduler scope. */
export function matchesSchedulerScope(
  submission: DelegationSubmissionAcceptedRecord,
  identity: DelegationSchedulerIdentity,
): boolean {
  if (
    submission.run_id !== identity.runId ||
    submission.parent_role !== identity.parentRole ||
    submission.logical_parent_id !== identity.logicalParentId
  )
    return false;
  const scope = controllerScope(identity);
  if (scope === null) return submission.schema_version === 1;
  return (
    (submission.schema_version === 2 || submission.schema_version === 3) &&
    submission.origin.kind === "controller_action" &&
    submission.origin.controller_id === scope.controllerId &&
    submission.origin.definition_digest === scope.definitionDigest
  );
}

function acceptedChild(task: PreparedDelegateChild) {
  return {
    child_id: task.childId,
    task_id: task.taskId,
    subagent: task.profile.name,
    model:
      task.profile.models[0]?.model ??
      (() => {
        throw new Error(`subagent '${task.profile.name}' has no model`);
      })(),
    branch: task.branch,
    worktree_path: task.worktreePath,
    base_commit: task.baseCommit,
    task_fingerprint: task.taskFingerprint,
    profile_fingerprint: task.profileFingerprint,
    context_fingerprint: task.contextFingerprint,
    prompt_fingerprint: task.promptFingerprint,
    projection_fingerprint: task.projectionFingerprint,
    ...(task.resolvedSourceWorkspace === undefined
      ? {}
      : {
          source_workspace: {
            ref: task.resolvedSourceWorkspace.ref,
            source_id: task.resolvedSourceWorkspace.sourceId,
            head_commit: task.resolvedSourceWorkspace.headCommit,
            tree_id: task.resolvedSourceWorkspace.treeId,
            inventory_digest: task.resolvedSourceWorkspace.inventoryDigest,
            policy_digest: task.resolvedSourceWorkspace.policyDigest,
            audience: task.resolvedSourceWorkspace.audience.map((principal) => ({ ...principal })),
          },
        }),
    ...(task.sandbox === undefined ? {} : { sandbox: task.sandbox }),
  };
}
