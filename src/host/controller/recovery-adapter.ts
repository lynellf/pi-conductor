/** Immutable adapter-publication resume decisions — issue #115 §6. */

import { controllerActionRequestDigest } from "../../persistence/controller-records.js";
import type { ControllerActionState } from "../../persistence/controller-timeline.js";
import type {
  ToolExecutionTimeline,
  ToolExecutionTimelineEntry,
} from "../../persistence/tool-execution.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import type { ApprovedControllerDefinition } from "./approved-definition.js";
import { type ArtifactBinding, ArtifactStoreError } from "./artifact-store.js";
import {
  type ControllerRecoveryArtifacts,
  type ControllerRecoveryReceipt,
  controllerRecoveryReceipt,
} from "./recovery-contract.js";

/** Recover a completed adapter only from its immutable publication and exact durable execution. */
export async function recoverControllerAdapterAction(
  artifacts: ControllerRecoveryArtifacts,
  definition: ApprovedControllerDefinition,
  action: ControllerActionState,
  execution: ToolExecutionTimeline,
): Promise<{
  readonly receipts: readonly ControllerRecoveryReceipt[];
  readonly blocked: readonly string[];
}> {
  const entry = adapterExecutionFor(execution, definition, action);
  if (entry === undefined)
    return Object.freeze({
      receipts: Object.freeze([
        controllerRecoveryReceipt(action, "interrupted", [], "no adapter execution started"),
      ]),
      blocked: Object.freeze([]),
    });
  if (entry.finished?.cleanup !== "confirmed" && entry.cleanupConfirmed === undefined)
    return Object.freeze({
      receipts: Object.freeze([]),
      blocked: Object.freeze([
        `adapter action ${action.actionId} has no terminal cleanup evidence; requires action repair`,
      ]),
    });
  const binding = adapterBinding(definition, action, entry);
  const origin = controllerOrigin(entry);
  try {
    const artifact = await artifacts.recoverAction(binding);
    if (sha256Canonical(artifact.binding) !== sha256Canonical(binding))
      throw new Error("recovered adapter artifact does not retain its exact binding");
    return Object.freeze({
      receipts: Object.freeze([
        controllerRecoveryReceipt(action, "completed", [artifact.ref], null, origin.operation_id),
      ]),
      blocked: Object.freeze([]),
    });
  } catch (cause) {
    if (!(cause instanceof ArtifactStoreError) || cause.code !== "artifact-missing") throw cause;
    if (
      entry.cleanupConfirmed?.schema_version !== 2 ||
      entry.cleanupConfirmed.partial_effects === "immutable_publication_verified"
    )
      return Object.freeze({
        receipts: Object.freeze([]),
        blocked: Object.freeze([
          `adapter action ${action.actionId} has no immutable publication; requires action repair`,
        ]),
      });
    return Object.freeze({
      receipts: Object.freeze([
        controllerRecoveryReceipt(
          action,
          adapterMissingPublicationOutcome(entry),
          [],
          "adapter publication is absent; private staging requires explicit recovery inspection",
          origin.operation_id,
        ),
      ]),
      blocked: Object.freeze([]),
    });
  }
}

function adapterExecutionFor(
  execution: ToolExecutionTimeline,
  definition: ApprovedControllerDefinition,
  action: ControllerActionState,
): ToolExecutionTimelineEntry | undefined {
  const expectedDigest = controllerActionRequestDigest(
    definition.record.definition_digest,
    action.intent.request,
  );
  if (expectedDigest !== action.intent.request_sha256)
    throw new Error(`adapter action ${action.actionId} request digest is not exact`);
  const matches = execution.entries.filter(
    (entry) =>
      entry.started.schema_version === 2 &&
      entry.started.run_id === definition.record.run_id &&
      entry.started.origin.controller_id === definition.record.controller_id &&
      entry.started.origin.definition_digest === definition.record.definition_digest &&
      entry.started.origin.activation_id === action.intentActivationId &&
      entry.started.origin.operation_kind === "adapter" &&
      entry.started.origin.action_id === action.actionId &&
      entry.started.origin.request_sha256 === expectedDigest,
  );
  if (matches.length > 1)
    throw new Error(`adapter action ${action.actionId} has multiple executable operations`);
  return matches[0];
}

function adapterBinding(
  definition: ApprovedControllerDefinition,
  action: ControllerActionState,
  entry: ToolExecutionTimelineEntry,
): ArtifactBinding {
  const request = action.intent.request;
  if (request.kind !== "adapter")
    throw new Error("adapter recovery requires adapter action and controller execution evidence");
  const origin = controllerOrigin(entry);
  const adapter = definition.config.adapters.find((item) => item.id === request.adapter_id);
  const authority = definition.record.adapter_authorities.find(
    (item) => item.adapter_id === request.adapter_id,
  );
  const output = definition.approval.schemas.find(
    (item) => item.schema_id === adapter?.output_schema_id,
  );
  if (adapter === undefined || authority === undefined || output === undefined)
    throw new Error(`adapter action ${action.actionId} has no exact pinned authority`);
  return Object.freeze({
    runId: definition.record.run_id,
    definitionDigest: definition.record.definition_digest,
    actionId: action.actionId,
    requestDigest: action.intent.request_sha256,
    producer: {
      kind: "operation" as const,
      operationId: origin.operation_id,
      requestDigest: origin.request_sha256,
    },
    outputSchema: { id: adapter.output_schema_id, digest: output.schema_digest },
    capabilityDigest: authority.capability_digest,
    mediaType: "application/json",
    allowedConsumerProfileIds: Object.freeze([...definition.config.delegation.allowed_subagents]),
  });
}

function adapterMissingPublicationOutcome(
  entry: ToolExecutionTimelineEntry,
): "failed" | "interrupted" {
  if (entry.finished?.outcome === "failed") return "failed";
  if (
    entry.cleanupConfirmed?.schema_version === 2 &&
    entry.cleanupConfirmed.partial_effects === "immutable_publication_verified"
  )
    throw new Error("adapter cleanup attestation conflicts with missing immutable publication");
  return "interrupted";
}

function controllerOrigin(entry: ToolExecutionTimelineEntry) {
  if (entry.started.schema_version !== 2 || entry.started.origin === undefined)
    throw new Error("adapter recovery requires controller execution provenance");
  return entry.started.origin;
}
