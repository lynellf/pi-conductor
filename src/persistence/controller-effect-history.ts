/** Cross-ledger effect authority checks against preceding controller ownership — issue #116. */
import { parseControllerConfig } from "../manifest/controller.js";
import { isControllerEffectRecord } from "./controller-effect-records.js";
import { reconstructControllerEffectTimeline } from "./controller-effect-timeline.js";
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
    for (const field of [
      "run_id",
      "controller_id",
      "definition_digest",
      "activation_id",
      "owner_epoch",
    ] as const)
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
    }
  }
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("effect pinned authority is malformed");
  return value as Record<string, unknown>;
}
