/** Deterministic read and cancel recovery without replaying host actions — issue #115 §6. */

import type { ControllerActionState } from "../../persistence/controller-timeline.js";
import {
  acceptedDelegationResults,
  type DelegationSubmissionAcceptedRecord,
  pendingDelegationChildren,
} from "../../persistence/delegation-task.js";
import type { PersistedRecord } from "../../persistence/log.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import { intentCursor, parseStrictJson } from "./action-dispatcher-query.js";
import type { ApprovedControllerDefinition } from "./approved-definition.js";
import { type ArtifactBinding, ArtifactStoreError } from "./artifact-store.js";
import { assertControllerReadResult, controllerReadResultSchemaDigest } from "./read-result.js";
import { recoveryInputAudience } from "./recovery-audience.js";
import {
  type ControllerRecoveryArtifacts,
  type ControllerRecoveryReceipt,
  controllerRecoveryReceipt,
} from "./recovery-contract.js";

const MAX_READ_RESULT_BYTES = 64 * 1024;
const MAX_READ_CHUNK_BYTES = 32 * 1024;

/** Reconcile one deterministic host action without invoking a second read or cancellation. */
export async function recoverControllerSimpleAction(
  artifacts: ControllerRecoveryArtifacts,
  definition: ApprovedControllerDefinition,
  action: ControllerActionState,
  records: readonly PersistedRecord[],
  hasUnresolvedOwnership: boolean,
): Promise<{
  readonly receipts: readonly ControllerRecoveryReceipt[];
  readonly blocked: readonly string[];
}> {
  if (action.intent.request.kind === "read")
    return recoverRead(artifacts, definition, action, records, hasUnresolvedOwnership);
  if (action.intent.request.kind === "cancel") return recoverCancel(definition, action, records);
  throw new Error("simple controller recovery requires read or cancel action");
}

async function recoverRead(
  artifacts: ControllerRecoveryArtifacts,
  definition: ApprovedControllerDefinition,
  action: ControllerActionState,
  records: readonly PersistedRecord[],
  hasUnresolvedOwnership: boolean,
): Promise<{
  readonly receipts: readonly ControllerRecoveryReceipt[];
  readonly blocked: readonly string[];
}> {
  if (action.intent.request.kind !== "read") throw new Error("read recovery requires read action");
  const inputAudience = await recoveryInputAudience(
    artifacts,
    [action.intent.request.ref],
    { kind: "controller" },
    action.intent.request.ref.startsWith("child-output/v2/") ||
      definition.config.child_outputs !== undefined,
  );
  const binding = readBinding(definition, action, records, inputAudience);
  try {
    const artifact = await artifacts.recoverAction(binding);
    if (sha256Canonical(artifact.binding) !== sha256Canonical(binding))
      throw new Error("recovered read artifact does not retain its exact binding");
    const bytes = await readResultBytes(artifacts, artifact.ref, binding, artifact.byteLength);
    const result = parseStrictJson(bytes);
    assertControllerReadResult(result);
    return Object.freeze({
      receipts: Object.freeze([
        controllerRecoveryReceipt(action, "completed", [artifact.ref], null, null, result),
      ]),
      blocked: Object.freeze([]),
    });
  } catch (cause) {
    if (!(cause instanceof ArtifactStoreError) || cause.code !== "artifact-missing") throw cause;
    if (hasUnresolvedOwnership)
      return Object.freeze({
        receipts: Object.freeze([]),
        blocked: Object.freeze([
          `read action ${action.actionId} has unresolved controller ownership; requires action repair`,
        ]),
      });
    return Object.freeze({
      receipts: Object.freeze([
        controllerRecoveryReceipt(
          action,
          "interrupted",
          [],
          "read publication is absent and will not be replayed",
        ),
      ]),
      blocked: Object.freeze([]),
    });
  }
}

function recoverCancel(
  definition: ApprovedControllerDefinition,
  action: ControllerActionState,
  records: readonly PersistedRecord[],
): {
  readonly receipts: readonly ControllerRecoveryReceipt[];
  readonly blocked: readonly string[];
} {
  if (action.intent.request.kind !== "cancel")
    throw new Error("cancel recovery requires a cancel action");
  const accepted = controllerAccepted(records, definition);
  const known = new Set(
    accepted.flatMap((record) => record.children.map((child) => child.child_id)),
  );
  const pending = new Set(pendingDelegationChildren(records).map((child) => child.child_id));
  const terminals = new Set(acceptedDelegationResults(records).map((record) => record.child_id));
  for (const childId of action.intent.request.child_ids) {
    if (!known.has(childId))
      return blocked(
        `cancel action ${action.actionId} targets a child outside this controller authority`,
      );
    if (pending.has(childId) || !terminals.has(childId))
      return blocked(`cancel action ${action.actionId} has unresolved target child ${childId}`);
  }
  return Object.freeze({
    receipts: Object.freeze([
      controllerRecoveryReceipt(
        action,
        "interrupted",
        [],
        "cancel target children are already terminal; cancellation will not be replayed",
      ),
    ]),
    blocked: Object.freeze([]),
  });
}

function readBinding(
  definition: ApprovedControllerDefinition,
  action: ControllerActionState,
  records: readonly PersistedRecord[],
  inputAudience:
    | readonly import("../../manifest/controller-output.js").ControllerOutputPrincipal[]
    | null,
): ArtifactBinding {
  if (action.intent.request.kind !== "read")
    throw new Error("read recovery requires a read action");
  const source = intentCursor(records, action.actionId);
  return Object.freeze({
    runId: definition.record.run_id,
    definitionDigest: definition.record.definition_digest,
    actionId: action.actionId,
    requestDigest: action.intent.request_sha256,
    producer: {
      kind: "source_cursor" as const,
      ordinal: source.ordinal,
      recordDigest: source.recordDigest,
    },
    outputSchema: {
      id: "host-controller-read-v1",
      digest: controllerReadResultSchemaDigest,
    },
    capabilityDigest: sha256Canonical({ capability: "controller-read" }),
    mediaType: "application/json",
    allowedConsumerProfileIds: [],
    ...(inputAudience === null ? {} : { audience: Object.freeze([...inputAudience]) }),
  });
}

async function readResultBytes(
  artifacts: ControllerRecoveryArtifacts,
  ref: string,
  binding: ArtifactBinding,
  byteLength: number,
): Promise<Buffer> {
  if (byteLength > MAX_READ_RESULT_BYTES)
    throw new Error("recovered read result exceeds its bounded receipt limit");
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < byteLength; ) {
    const page = await artifacts.rangeReadForController({
      ref,
      runId: binding.runId,
      definitionDigest: binding.definitionDigest,
      offset,
      length: Math.min(MAX_READ_CHUNK_BYTES, byteLength - offset),
    });
    if (sha256Canonical(page.binding) !== sha256Canonical(binding) || page.bytes.byteLength === 0)
      throw new Error("recovered read artifact changed during bounded retrieval");
    chunks.push(page.bytes);
    offset += page.bytes.byteLength;
  }
  return Buffer.concat(chunks, byteLength);
}

function controllerAccepted(
  records: readonly PersistedRecord[],
  definition: ApprovedControllerDefinition,
): readonly DelegationSubmissionAcceptedRecord[] {
  return records.filter(
    (record): record is DelegationSubmissionAcceptedRecord =>
      record.type === "delegation_submission_accepted" &&
      (record.schema_version === 2 || record.schema_version === 3) &&
      record.run_id === definition.record.run_id &&
      record.origin.kind === "controller_action" &&
      record.origin.controller_id === definition.record.controller_id &&
      record.origin.definition_digest === definition.record.definition_digest,
  );
}

function blocked(reason: string): {
  readonly receipts: readonly ControllerRecoveryReceipt[];
  readonly blocked: readonly string[];
} {
  return Object.freeze({ receipts: Object.freeze([]), blocked: Object.freeze([reason]) });
}
