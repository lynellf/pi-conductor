/** Durable controller resume planning without dispatch or executable replay — issue #115 §6. */

import type {
  ControllerActionReceiptRecord,
  ControllerActivationStartedRecord,
  ControllerRecord,
} from "../../persistence/controller-records.js";
import {
  type ControllerActionState,
  reconstructControllerTimeline,
} from "../../persistence/controller-timeline.js";
import {
  acceptedDelegationResults,
  type DelegationSubmissionAcceptedRecord,
  pendingDelegationChildren,
} from "../../persistence/delegation-task.js";
import type { PersistedRecord } from "../../persistence/log.js";
import {
  materializeControllerExecutionRecovery,
  reconstructToolExecutionTimeline,
  type ToolExecutionRecord,
  type ToolExecutionTimeline,
} from "../../persistence/tool-execution.js";
import type { ApprovedControllerDefinition } from "./approved-definition.js";
import { controllerAcceptedSubmissionRef, controllerRecordRef } from "./controller-refs.js";
import { recoverControllerAdapterAction } from "./recovery-adapter.js";
import {
  type ControllerRecoveryArtifacts,
  type ControllerRecoveryPlan,
  type ControllerRecoveryReceipt,
  controllerRecoveryReceipt,
} from "./recovery-contract.js";
import { recoverControllerSimpleAction } from "./recovery-simple.js";

export type {
  ControllerRecoveryArtifacts,
  ControllerRecoveryPlan,
  ControllerRecoveryReceipt,
} from "./recovery-contract.js";

/** Inspect durable records only; never submit native work or invoke an adapter. */
export async function planControllerRecovery(input: {
  readonly approvedDefinition: ApprovedControllerDefinition;
  readonly records: readonly PersistedRecord[];
  readonly artifacts: ControllerRecoveryArtifacts;
}): Promise<ControllerRecoveryPlan> {
  const timeline = reconstructControllerTimeline(input.records);
  const definition = input.approvedDefinition.record;
  if (timeline.definition.definition_digest !== definition.definition_digest)
    throw new Error("controller recovery definition does not match the pinned run");
  const execution = reconstructToolExecutionTimeline(input.records.filter(isToolExecutionRecord));
  const executableRecovery = executableRecoveryRequirements(
    execution,
    definition.run_id,
    definition.controller_id,
    definition.definition_digest,
  );
  const blocked = [...executableRecovery.blocked];
  const receipts: ControllerRecoveryReceipt[] = [];
  const freshActionRequired: string[] = [];
  for (const action of timeline.actions) {
    if (action.latestReceipt !== null) {
      if (
        action.latestReceipt.outcome === "completed" ||
        action.latestReceipt.outcome === "failed" ||
        action.latestReceipt.outcome === "interrupted" ||
        action.latestReceipt.outcome === "rejected"
      )
        continue;
      if (action.latestReceipt.outcome === "uncertain" && action.repair !== null) {
        freshActionRequired.push(action.actionId);
        continue;
      }
      if (action.latestReceipt.outcome === "uncertain") {
        blocked.push(
          `action ${action.actionId} has an unrepaired uncertain operation; requires action repair`,
        );
        continue;
      }
    }
    if (action.intent.kind === "adapter") {
      const recovered = await recoverControllerAdapterAction(
        input.artifacts,
        input.approvedDefinition,
        action,
        execution,
      );
      receipts.push(...recovered.receipts);
      blocked.push(...recovered.blocked);
      continue;
    }
    if (action.intent.kind === "read" || action.intent.kind === "cancel") {
      const recovered = await recoverControllerSimpleAction(
        input.artifacts,
        input.approvedDefinition,
        action,
        input.records,
        executableRecovery.blocked.length > 0,
      );
      receipts.push(...recovered.receipts);
      blocked.push(...recovered.blocked);
      continue;
    }
    if (action.intent.kind !== "delegate") {
      blocked.push(`action ${action.actionId} has an unsupported recovery intent`);
      continue;
    }
    const accepted = acceptedFor(input.records, definition, action);
    if (accepted === undefined) {
      if (!hasControllerEffectStart(input.records, definition, action.actionId))
        receipts.push(
          controllerRecoveryReceipt(action, "interrupted", [], "no durable native acceptance"),
        );
      else if (hasInspectedPreparation(execution, definition, action))
        receipts.push(
          controllerRecoveryReceipt(
            action,
            "interrupted",
            [],
            "native preparation was inspected without acceptance",
          ),
        );
      else
        blocked.push(
          `action ${action.actionId} has preparation or executable evidence without acceptance; requires action repair`,
        );
      continue;
    }
    const pending = pendingDelegationChildren(input.records).filter((child) =>
      accepted.children.some((entry) => entry.child_id === child.child_id),
    );
    if (pending.length > 0) {
      blocked.push(
        `action ${action.actionId} has accepted children without terminal evidence; requires action repair`,
      );
      continue;
    }
    const terminals = acceptedDelegationResults(input.records).filter((entry) =>
      accepted.children.some((child) => child.child_id === entry.child_id),
    );
    const failed = terminals.some((entry) => entry.type === "subagent_failed");
    const activation = actionActivation(input.records, action.intentActivationId);
    receipts.push(
      controllerRecoveryReceipt(
        action,
        failed ? "failed" : "completed",
        [
          controllerAcceptedSubmissionRef(activation, action.actionId),
          ...terminals.map((entry) => controllerRecordRef(activation, entry)),
        ],
        null,
      ),
    );
  }
  const fresh = new Set([...freshActionRequired, ...executableRecovery.freshActionRequired]);
  return Object.freeze({
    canActivate: blocked.length === 0,
    receipts: Object.freeze(receipts),
    blocked: Object.freeze(blocked),
    freshActionRequired: Object.freeze([...fresh]),
    previousActivationId: timeline.latestActivation?.activation_id ?? null,
    nextOwnerEpoch: (timeline.latestActivation?.owner_epoch ?? 0) + 1,
  });
}

/** Append a new activation and derived facts only after the pure plan has cleared all gates. */
export function appendControllerRecovery(
  plan: ControllerRecoveryPlan,
  activation: ControllerActivationStartedRecord,
  persist: (record: ControllerRecord) => void,
): readonly ControllerActionReceiptRecord[] {
  if (!plan.canActivate) throw new Error("controller recovery remains blocked");
  if (
    activation.previous_activation_id !== plan.previousActivationId ||
    activation.owner_epoch !== plan.nextOwnerEpoch
  )
    throw new Error("controller recovery activation does not continue the resolved owner epoch");
  persist(activation);
  const records = plan.receipts.map((entry) => ({
    type: "controller_action_receipt" as const,
    schema_version: 1 as const,
    run_id: activation.run_id,
    controller_id: activation.controller_id,
    definition_digest: activation.definition_digest,
    action_id: entry.actionId,
    activation_id: activation.activation_id,
    owner_epoch: activation.owner_epoch,
    intent_activation_id: entry.intentActivationId,
    causal_revision: entry.causalRevision,
    request_sha256: entry.requestSha256,
    kind: entry.kind,
    outcome: entry.outcome,
    operation_id: entry.operationId,
    result_refs: [...entry.resultRefs],
    ...(entry.result === undefined ? {} : { result: entry.result }),
    diagnostic: entry.diagnostic,
    ts: activation.ts,
  }));
  for (const record of records) persist(record);
  return Object.freeze(records);
}

function executableRecoveryRequirements(
  execution: ToolExecutionTimeline,
  runId: string,
  controllerId: string,
  digest: string,
): {
  readonly blocked: readonly string[];
  readonly freshActionRequired: readonly string[];
} {
  const blocked: string[] = [];
  const freshActionRequired: string[] = [];
  for (const entry of execution.entries) {
    if (entry.started.schema_version !== 2) continue;
    const origin = entry.started.origin;
    if (
      entry.started.run_id !== runId ||
      origin.controller_id !== controllerId ||
      origin.definition_digest !== digest
    )
      continue;
    const recovery = materializeControllerExecutionRecovery(entry);
    if (recovery.kind === "cleanup_required")
      blocked.push(`controller executable ${entry.started.execution_id} has unresolved ownership`);
    if (
      recovery.kind === "fresh_action_required" &&
      origin.operation_kind !== "adapter" &&
      origin.action_id !== null
    )
      freshActionRequired.push(origin.action_id);
  }
  return Object.freeze({
    blocked: Object.freeze(blocked),
    freshActionRequired: Object.freeze(freshActionRequired),
  });
}

function acceptedFor(
  records: readonly PersistedRecord[],
  definition: ApprovedControllerDefinition["record"],
  action: ControllerActionState,
): DelegationSubmissionAcceptedRecord | undefined {
  const matches = records.filter(
    (record): record is DelegationSubmissionAcceptedRecord =>
      record.type === "delegation_submission_accepted" &&
      record.schema_version === 2 &&
      record.origin.kind === "controller_action" &&
      record.run_id === definition.run_id &&
      record.origin.controller_id === definition.controller_id &&
      record.origin.definition_digest === definition.definition_digest &&
      record.origin.action_id === action.actionId &&
      record.origin.activation_id === action.intentActivationId,
  );
  if (matches.length > 1)
    throw new Error(`controller action ${action.actionId} has multiple native acceptances`);
  return matches[0];
}

function hasControllerEffectStart(
  records: readonly PersistedRecord[],
  definition: ApprovedControllerDefinition["record"],
  actionId: string,
): boolean {
  return records.some(
    (record) =>
      isToolExecutionRecord(record) &&
      record.type === "tool_execution_started" &&
      record.schema_version === 2 &&
      record.origin.controller_id === definition.controller_id &&
      record.origin.definition_digest === definition.definition_digest &&
      record.origin.action_id === actionId,
  );
}

function hasInspectedPreparation(
  execution: ToolExecutionTimeline,
  definition: ApprovedControllerDefinition["record"],
  action: ControllerActionState,
): boolean {
  return execution.entries.some(
    (entry) =>
      entry.started.schema_version === 2 &&
      entry.started.run_id === definition.run_id &&
      entry.started.origin.controller_id === definition.controller_id &&
      entry.started.origin.definition_digest === definition.definition_digest &&
      entry.started.origin.activation_id === action.intentActivationId &&
      entry.started.origin.operation_kind === "preparation" &&
      entry.started.origin.action_id === action.actionId &&
      entry.cleanupConfirmed !== undefined &&
      entry.cleanupConfirmed.schema_version === 2 &&
      entry.cleanupConfirmed.partial_effects !== "immutable_publication_verified",
  );
}

function actionActivation(
  records: readonly PersistedRecord[],
  activationId: string,
): ControllerActivationStartedRecord {
  const activation = records.find(
    (record): record is ControllerActivationStartedRecord =>
      record.type === "controller_activation_started" && record.activation_id === activationId,
  );
  if (activation === undefined)
    throw new Error("controller action has no durable originating activation");
  return activation;
}

function isToolExecutionRecord(value: PersistedRecord): value is ToolExecutionRecord {
  return (
    value.type === "tool_execution_started" ||
    value.type === "tool_execution_finished" ||
    value.type === "tool_execution_cleanup_confirmed" ||
    value.type === "tool_execution_sandbox_ready"
  );
}
