/** Cross-ledger effect authority checks against preceding controller ownership — issue #116. */
import { parseControllerConfig } from "../manifest/controller.js";
import {
  type ControllerEffectRecord,
  isControllerEffectRecord,
} from "./controller-effect-records.js";
import { reconstructControllerEffectTimeline } from "./controller-effect-timeline.js";
import { isLocalProgramProcessRecord } from "./controller-local-effect-process.js";
import { reconstructLocalProgramProcessTimeline } from "./controller-local-effect-process-timeline.js";
import type {
  ControllerActionIntent,
  ControllerActivationStartedRecord,
  ControllerDefinitionPinnedRecord,
} from "./controller-records.js";
import { reconstructControllerTimeline } from "./controller-timeline.js";
import type { PersistedRecord } from "./log.js";
import { sha256Canonical } from "./trajectory-records.js";

/** Validate effect chronology and the exact real action/grant/epoch that authorized each append. */
export function assertControllerEffectHistory(records: readonly PersistedRecord[]): void {
  if (!records.some(isControllerEffectRecord)) return;
  reconstructControllerTimeline(records);
  reconstructControllerEffectTimeline(records);
  reconstructLocalProgramProcessTimeline(records);
  let definition: ControllerDefinitionPinnedRecord | undefined;
  let activation: ControllerActivationStartedRecord | undefined;
  const actions = new Map<string, ControllerActionIntent>();
  for (const record of records) {
    if (record.type === "controller_definition_pinned") definition = record;
    if (record.type === "controller_activation_started") activation = record;
    if (record.type === "controller_decision_committed")
      for (const action of record.actions) actions.set(action.action_id, action);
    if (!isControllerEffectRecord(record)) continue;
    if (definition === undefined || activation === undefined)
      throw new Error("effect journal precedes controller ownership");
    for (const field of ["run_id", "controller_id", "definition_digest"] as const)
      if (record[field] !== activation[field])
        throw new Error("effect journal does not belong to current controller owner");
    const action = actions.get(record.action_id);
    if (action?.request.kind !== "adapter" || action.request.adapter_id !== record.adapter_id)
      throw new Error("effect journal has no preceding adapter action intent");
    const pinned = object(definition.pinned_definition);
    const config = parseControllerConfig(pinned.config);
    const adapter = config.adapters.find((item) => item.id === record.adapter_id);
    if (adapter?.effect_id !== record.effect_id)
      throw new Error("effect journal is outside the pinned adapter grant");
    if (!Array.isArray(pinned.effects)) throw new Error("effect journal authority is not pinned");
    const authorities = pinned.effects
      .map(object)
      .filter((entry) => object(entry.grant).id === record.effect_id);
    const authority = authorities[0];
    if (
      authorities.length !== 1 ||
      authority === undefined ||
      authority.authority_digest !== record.authority_digest ||
      sha256Canonical({ domain: "pi-conductor/effect-authority/v1", grant: authority.grant }) !==
        record.authority_digest
    )
      throw new Error("effect journal authority digest mismatch");
    const grant = object(authority.grant);
    if (grant.adapter_id !== record.adapter_id)
      throw new Error("effect journal grant belongs to another adapter");
    if (
      record.activation_id !== activation.activation_id ||
      record.owner_epoch !== activation.owner_epoch
    )
      throw new Error("effect journal does not belong to current controller owner");
    if (isLocalProgramProcessRecord(record)) {
      const intent = recordForOperation(records, record.operation_id);
      if (
        intent?.request.kind !== "local_program" ||
        record.run_id !== intent.run_id ||
        record.controller_id !== intent.controller_id ||
        record.definition_digest !== intent.definition_digest ||
        record.action_id !== intent.action_id ||
        record.adapter_id !== intent.adapter_id ||
        record.effect_id !== intent.effect_id ||
        record.authority_digest !== intent.authority_digest ||
        record.implementation_id !== grant.implementation_id ||
        record.implementation_digest !== grant.implementation_digest ||
        record.request_digest !== sha256Canonical(intent.request) ||
        record.subject.repository_id !== intent.request.repository_id ||
        record.subject.source_ref !== intent.request.source_ref ||
        record.subject.target_ref !== intent.request.target_ref ||
        record.subject.reviewed_head !== intent.request.reviewed_head
      )
        throw new Error("local effect process record is not bound to its approved request");
      continue;
    }
    if (record.type === "controller_effect_intent") {
      const artifact = record.request_artifact;
      if (
        artifact.run_id !== record.run_id ||
        artifact.definition_digest !== record.definition_digest ||
        artifact.producer.action_id !== record.action_id ||
        artifact.producer.adapter_id !== record.adapter_id ||
        artifact.schema.id !== grant.request_schema_id ||
        artifact.schema.digest !== grant.request_schema_digest ||
        record.request.kind !== grant.kind ||
        record.request.repository_id !== object(grant.repository).id
      )
        throw new Error("effect request artifact does not match pinned action authority");
    }
    if (record.type === "controller_effect_prepared") {
      const post = record.postcondition;
      if (post.kind !== grant.kind) throw new Error("prepared effect kind is not approved");
      if (post.kind === "deliver_ref") {
        const remote = object(grant.remote);
        if (
          post.remote_id !== remote.id ||
          post.exact_origin !== remote.exact_origin ||
          post.exact_path !== remote.exact_path ||
          post.credential_source_id !== remote.credential_source_id
        )
          throw new Error("prepared remote scope is not approved");
      } else if (post.repository_fingerprint !== object(grant.repository).fingerprint)
        throw new Error("prepared repository identity is not approved");
      if (post.kind === "local_program") {
        const request = recordForOperation(records, record.operation_id)?.request;
        if (
          request?.kind !== "local_program" ||
          post.operation !== request.operation ||
          post.source_ref !== request.source_ref ||
          post.target_ref !== request.target_ref ||
          post.reviewed_head !== request.reviewed_head ||
          post.implementation_id !== grant.implementation_id ||
          post.implementation_digest !== grant.implementation_digest ||
          post.request_digest !== sha256Canonical(request)
        )
          throw new Error("prepared local effect binding is not approved");
      }
    }
  }
}
function recordForOperation(
  records: readonly PersistedRecord[],
  operationId: string,
): Extract<ControllerEffectRecord, { type: "controller_effect_intent" }> | undefined {
  return records.find(
    (record): record is Extract<ControllerEffectRecord, { type: "controller_effect_intent" }> =>
      isControllerEffectRecord(record) &&
      record.type === "controller_effect_intent" &&
      record.operation_id === operationId,
  );
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("effect pinned authority is malformed");
  return value as Record<string, unknown>;
}
