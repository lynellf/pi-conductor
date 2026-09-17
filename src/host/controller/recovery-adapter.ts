/** Immutable adapter-publication resume decisions — issue #115 §6. */

import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { controllerActionRequestDigest } from "../../persistence/controller-records.js";
import type { ControllerActionState } from "../../persistence/controller-timeline.js";
import type {
  ToolExecutionTimeline,
  ToolExecutionTimelineEntry,
} from "../../persistence/tool-execution.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import type { ApprovedControllerDefinition } from "./approved-definition.js";
import { type ArtifactBinding, ArtifactStoreError } from "./artifact-store.js";
import { recoveredAdapterAudience, recoveryInputAudience } from "./recovery-audience.js";
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
  const request = action.intent.request;
  if (request.kind !== "adapter") throw new Error("adapter recovery requires adapter action");
  const adapter = definition.config.adapters.find((item) => item.id === request.adapter_id);
  if (adapter === undefined)
    throw new Error(`adapter action ${action.actionId} has no exact pinned authority`);
  const sourceAware =
    request.source_workspace_ref !== undefined || request.file_input_refs !== undefined;
  if (sourceAware && !verifiedSourceExecution(entry))
    return Object.freeze({
      receipts: Object.freeze([]),
      blocked: Object.freeze([
        `source adapter action ${action.actionId} lacks complete captured execution evidence; requires action repair`,
      ]),
    });
  const inputAudience = await recoveryInputAudience(
    artifacts,
    [
      ...request.input_refs,
      ...(request.source_workspace_ref === undefined ? [] : [request.source_workspace_ref]),
      ...(request.file_input_refs ?? []).map((entry) => entry.ref),
    ],
    { kind: "adapter", adapter_id: adapter.id },
    sourceAware ||
      adapter.output_consumers !== undefined ||
      definition.config.child_outputs !== undefined,
  );
  const binding = adapterBinding(definition, action, entry, inputAudience, sourceAware);
  const origin = controllerOrigin(entry);
  try {
    const recovered =
      sourceAware && artifacts.recoverActionPayload !== undefined
        ? await artifacts.recoverActionPayload(binding)
        : sourceAware
          ? (() => {
              throw new Error("source adapter recovery requires immutable envelope bytes");
            })()
          : { artifact: await artifacts.recoverAction(binding), bytes: undefined };
    const artifact = recovered.artifact;
    if (sha256Canonical(artifact.binding) !== sha256Canonical(binding))
      throw new Error("recovered adapter artifact does not retain its exact binding");
    if (sourceAware) validateSourceEnvelope(recovered.bytes, request, definition, adapter, entry);
    if (adapter.effect_id !== undefined) {
      if (artifacts.recoverEffectAction === undefined)
        return Object.freeze({
          receipts: Object.freeze([]),
          blocked: Object.freeze([
            `effect-backed adapter action ${action.actionId} has no effect recovery authority`,
          ]),
        });
      const recovered = await artifacts.recoverEffectAction(action, artifact);
      if (
        recovered.blocked.length === 0 &&
        (recovered.receipts.length !== 1 ||
          recovered.receipts[0]?.actionId !== action.actionId ||
          recovered.receipts[0].outcome === "accepted")
      )
        throw new Error(`effect-backed adapter action ${action.actionId} is not settled`);
      if (recovered.receipts.some((receipt) => receipt.actionId !== action.actionId))
        throw new Error(`effect recovery returned a receipt for the wrong action`);
      return recovered;
    }
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
  inputAudience:
    | readonly import("../../manifest/controller-output.js").ControllerOutputPrincipal[]
    | null,
  sourceAware: boolean,
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
  const audience = recoveredAdapterAudience(definition, adapter, inputAudience);
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
    outputSchema: sourceAware
      ? {
          id: "source-adapter-envelope-v1",
          digest: sha256Canonical({ schema_version: 1, kind: "source-adapter-envelope" }),
        }
      : { id: adapter.output_schema_id, digest: output.schema_digest },
    capabilityDigest: authority.capability_digest,
    mediaType: "application/json",
    allowedConsumerProfileIds: Object.freeze([...definition.config.delegation.allowed_subagents]),
    ...(audience === undefined ? {} : { audience }),
  });
}

function verifiedSourceExecution(entry: ToolExecutionTimelineEntry): boolean {
  return (
    entry.finished?.outcome === "completed" &&
    entry.finished.cleanup === "confirmed" &&
    entry.finished.sandbox?.category === "command_status" &&
    entry.finished.sandbox.normalized_status !== null &&
    entry.finished.sandbox.output?.capture === "complete"
  );
}

function validateSourceEnvelope(
  bytes: Buffer | undefined,
  request: Extract<ControllerActionState["intent"]["request"], { readonly kind: "adapter" }>,
  definition: ApprovedControllerDefinition,
  adapter: import("../../manifest/controller.js").ControllerAdapterConfig,
  entry: ToolExecutionTimelineEntry,
): void {
  if (bytes === undefined || request.source_workspace_ref === undefined)
    throw new Error("source adapter recovery lacks an immutable envelope");
  let envelope: unknown;
  try {
    envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("source adapter recovery envelope is not valid JSON");
  }
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope))
    throw new Error("source adapter recovery envelope is invalid");
  const value = envelope as Record<string, unknown>;
  const source = value.source;
  const execution = value.execution;
  if (
    value.schema_version !== 1 ||
    source === null ||
    typeof source !== "object" ||
    Array.isArray(source) ||
    execution === null ||
    typeof execution !== "object" ||
    Array.isArray(execution)
  )
    throw new Error("source adapter recovery envelope is invalid");
  const sourceValue = source as Record<string, unknown>;
  const executionValue = execution as Record<string, unknown>;
  const terminal = entry.finished?.sandbox;
  if (
    sourceValue.ref !== request.source_workspace_ref ||
    typeof sourceValue.base_commit !== "string" ||
    typeof sourceValue.head_commit !== "string" ||
    typeof sourceValue.tree_id !== "string" ||
    typeof sourceValue.inventory_digest !== "string" ||
    typeof sourceValue.policy_digest !== "string" ||
    executionValue.execution_id !== entry.started.execution_id ||
    executionValue.normalized_status !== terminal?.normalized_status ||
    executionValue.capture !== "complete" ||
    executionValue.cleanup !== "confirmed"
  )
    throw new Error("source adapter recovery envelope does not match durable execution");
  if (terminal?.normalized_status !== 0) {
    if (value.result !== null)
      throw new Error("nonzero source adapter recovery envelope must not claim a result");
    return;
  }
  const output = definition.approval.schemas.find(
    (item) => item.schema_id === adapter.output_schema_id,
  );
  if (output === undefined || !Value.Check(output.schema as TSchema, value.result))
    throw new Error("source adapter recovery envelope result schema mismatch");
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
