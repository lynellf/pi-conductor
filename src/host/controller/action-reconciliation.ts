/** Explicit operator effect repair; cleanup evidence never asserts controller success — issue #115 §6. */
import { readFileSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type {
  ControllerActionReceiptRecord,
  ControllerRecord,
  ControllerRepairRecord,
} from "../../persistence/controller-records.js";
import { reconstructControllerTimeline } from "../../persistence/controller-timeline.js";
import { pendingDelegationChildren } from "../../persistence/delegation-task.js";
import type { PersistedRecord } from "../../persistence/log.js";
import {
  isToolExecutionRecord,
  reconstructToolExecutionTimeline,
} from "../../persistence/tool-execution.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import { FileRecordLog } from "../log-file.js";

/** Explicit local attestation after inspecting all retained action staging and private effects. */
export interface ControllerActionRepairOptions {
  readonly baseDir: string;
  readonly acknowledgment: true;
  readonly operatorNote: string;
  readonly partialEffects: ControllerRepairRecord["partial_effects"];
}

/** Derive strict repair records without changing any earlier receipt or asserting output validity. */
export function prepareControllerActionRepair(
  records: readonly PersistedRecord[],
  actionId: string,
  attestation: {
    readonly operator: string;
    readonly note: string;
    readonly partialEffects: ControllerRepairRecord["partial_effects"];
    readonly ts: number;
  },
): readonly ControllerRecord[] {
  const timeline = reconstructControllerTimeline(records);
  const activation = timeline.latestActivation;
  const action = timeline.actions.find((entry) => entry.actionId === actionId);
  if (activation === null || action === undefined)
    throw new Error("controller action has no durable activation or intent");
  if (action.repair !== null) throw new Error("controller action already has an effect repair");
  const latest = action.latestReceipt;
  if (latest !== null && !["pending", "accepted", "uncertain"].includes(latest.outcome))
    throw new Error("controller action is already terminal");
  const executions = reconstructToolExecutionTimeline(records.filter(isToolExecutionRecord));
  if (executions.unresolved.length > 0)
    throw new Error(
      "executable ownership is unresolved; reconcile-tools --execution before repairing action effects",
    );
  if (pendingDelegationChildren(records).length > 0)
    throw new Error(
      "native children still require authoritative terminal reconciliation before action repair",
    );
  if (
    action.intent.kind === "delegate" &&
    latest?.outcome !== "uncertain" &&
    records.some(
      (record) =>
        record.type === "delegation_submission_accepted" &&
        (record.schema_version === 2 || record.schema_version === 3) &&
        record.origin.kind === "controller_action" &&
        record.origin.action_id === actionId &&
        record.origin.definition_digest === timeline.definition.definition_digest &&
        record.origin.controller_id === timeline.definition.controller_id,
    )
  )
    throw new Error(
      "accepted native results are authoritative; resume to derive their receipt instead of repairing the action",
    );
  const matching = executions.entries.filter(
    (entry) =>
      entry.started.schema_version === 2 &&
      entry.started.origin.controller_id === timeline.definition.controller_id &&
      entry.started.origin.definition_digest === timeline.definition.definition_digest &&
      entry.started.origin.activation_id === action.intentActivationId &&
      entry.started.origin.request_sha256 === action.intent.request_sha256 &&
      entry.started.origin.action_id === actionId,
  );
  const operation = matching.at(-1)?.started;
  const operationId =
    latest?.operation_id ??
    (operation?.schema_version === 2 ? operation.origin.operation_id : null);
  if (operationId === null)
    throw new Error(
      "action effect repair requires a durable original operation; no operation may be fabricated",
    );
  if (
    !matching.some(
      (entry) =>
        entry.started.schema_version === 2 && entry.started.origin.operation_id === operationId,
    )
  )
    throw new Error("uncertain receipt does not identify its original executable operation");
  const uncertain: ControllerActionReceiptRecord =
    latest?.outcome === "uncertain"
      ? latest
      : {
          type: "controller_action_receipt",
          schema_version: 1,
          run_id: activation.run_id,
          controller_id: activation.controller_id,
          definition_digest: activation.definition_digest,
          action_id: action.actionId,
          activation_id: activation.activation_id,
          owner_epoch: activation.owner_epoch,
          intent_activation_id: action.intentActivationId,
          causal_revision: action.originalRevision,
          request_sha256: action.intent.request_sha256,
          kind: action.intent.kind,
          outcome: "uncertain",
          operation_id: operationId,
          result_refs: [],
          diagnostic: "operator inspection required for interrupted private action effects",
          ts: attestation.ts,
        };
  const repair: ControllerRepairRecord = {
    type: "controller_operation_repaired",
    schema_version: 1,
    run_id: activation.run_id,
    controller_id: activation.controller_id,
    definition_digest: activation.definition_digest,
    action_id: actionId,
    operation_id: operationId,
    original_activation_id: action.intentActivationId,
    original_record_digest: sha256Canonical(uncertain),
    cleanup: "confirmed",
    partial_effects: attestation.partialEffects,
    operator: attestation.operator,
    operator_note: attestation.note,
    ts: attestation.ts,
  };
  const appended: ControllerRecord[] =
    latest?.outcome === "uncertain" ? [repair] : [uncertain, repair];
  reconstructControllerTimeline([...records, ...appended]);
  return appended;
}

/** Hold the run lease while recording operator inspection of already-settled private effects. */
export async function reconcileControllerActionEffects(
  runId: string,
  actionId: string,
  options: ControllerActionRepairOptions,
): Promise<readonly ControllerRecord[]> {
  if (
    !/^[^/\\\0]{1,256}$/.test(runId) ||
    !actionId ||
    Buffer.byteLength(actionId) > 128 ||
    options.acknowledgment !== true
  )
    throw new Error("invalid controller repair identity or missing acknowledgment");
  if (!options.operatorNote.trim() || options.operatorNote.length > 1000)
    throw new Error("repair requires a bounded operator note");
  const baseDir = realpathSync(options.baseDir);
  const log = new FileRecordLog({ baseDir });
  const lease = await log.acquireRunLease(runId);
  try {
    const content = readFileSync(join(baseDir, `${runId}.jsonl`), "utf8");
    if (!content.endsWith("\n"))
      throw new Error("incomplete controller log; repair the log separately first");
    const appended = prepareControllerActionRepair(log.records(runId), actionId, {
      operator: userInfo().username,
      note: options.operatorNote,
      partialEffects: options.partialEffects,
      ts: Date.now(),
    });
    for (const record of appended) log.append(record);
    return appended;
  } finally {
    await lease.release();
  }
}
