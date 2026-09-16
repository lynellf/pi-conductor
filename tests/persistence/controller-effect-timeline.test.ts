import { describe, expect, it } from "vitest";
import type { DeliverRefRequest } from "../../src/manifest/controller-effect.js";
import {
  assertControllerEffectRecord,
  type ControllerEffectIntentRecord,
  type ControllerEffectPreparedRecord,
  type ControllerEffectSettledRecord,
  controllerEffectOperationId,
  controllerLogicalEffectDigest,
  logicalRequestDigest,
} from "../../src/persistence/controller-effect-records.js";
import { reconstructControllerEffectTimeline } from "../../src/persistence/controller-effect-timeline.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";

const sha = (character: string) => character.repeat(64);
const request: DeliverRefRequest = {
  schema_version: 1,
  kind: "deliver_ref",
  repository_id: "repo",
  source_ref: "refs/integration/reviewed",
  reviewed_head: sha("1"),
  remote_id: "origin",
  target_ref: "refs/heads/main",
  expected_remote_oid: sha("2"),
  idempotency_key: "delivery-1",
  evidence: [
    {
      artifact_ref: "artifact/evidence",
      sha256: sha("3"),
      producer_id: "validator",
      schema_id: "validation-v1",
      subject_head: sha("1"),
      verdict: "approved",
    },
  ],
};

function intent(actionId = "action-1", value = request): ControllerEffectIntentRecord {
  const artifact = {
    ref: `artifact/${actionId}`,
    sha256: sha("4"),
    byte_length: 100,
    producer: {
      adapter_id: "adapter",
      action_id: actionId,
      operation_id: `adapter-operation-${actionId}`,
    },
    schema: { id: "deliver-ref-request-v1", digest: sha("5") },
    run_id: "run",
    definition_digest: sha("6"),
  };
  const authorityDigest = sha("7");
  return {
    type: "controller_effect_intent",
    schema_version: 1,
    run_id: "run",
    controller_id: "controller",
    definition_digest: sha("6"),
    activation_id: "activation",
    owner_epoch: 2,
    action_id: actionId,
    adapter_id: "adapter",
    effect_id: "delivery",
    operation_id: controllerEffectOperationId({
      runId: "run",
      definitionDigest: sha("6"),
      actionId,
      artifact,
      authorityDigest,
    }),
    logical_effect_digest: controllerLogicalEffectDigest({
      definitionDigest: sha("6"),
      authorityDigest,
      requestDigest: logicalRequestDigest(value),
    }),
    authority_digest: authorityDigest,
    request_artifact: artifact,
    request_digest: sha256Canonical(value),
    request: value,
    lane_resource: {
      kind: "remote",
      exact_origin: "https://delivery.invalid",
      exact_path: "/v1/ref",
      target_ref: "refs/heads/main",
    },
    lane_key: sha256Canonical({
      domain: "pi-conductor/effect-lane/v1",
      resource: {
        kind: "remote",
        exact_origin: "https://delivery.invalid",
        exact_path: "/v1/ref",
        target_ref: "refs/heads/main",
      },
    }),
    ts: 1,
  };
}

function prepared(value: ControllerEffectIntentRecord): ControllerEffectPreparedRecord {
  return {
    type: "controller_effect_prepared",
    schema_version: 1,
    ...identity(value),
    intent_digest: sha256Canonical(value),
    postcondition: {
      kind: "deliver_ref",
      remote_id: "origin",
      exact_origin: "https://delivery.invalid",
      exact_path: "/v1/ref",
      target_ref: "refs/heads/main",
      reviewed_head: sha("1"),
      expected_prior: sha("2"),
      idempotency_key: value.request.kind === "deliver_ref" ? value.request.idempotency_key : "",
      credential_source_id: "credential",
    },
  };
}

function uncertain(
  value: ControllerEffectIntentRecord,
  prep: ControllerEffectPreparedRecord,
): ControllerEffectSettledRecord {
  return {
    type: "controller_effect_settled",
    schema_version: 1,
    ...identity(value),
    intent_digest: sha256Canonical(value),
    prepared_digest: sha256Canonical(prep),
    outcome: "uncertain",
    diagnostic_code: "transport_ambiguous",
    recovery: null,
  };
}

function identity(value: ControllerEffectIntentRecord) {
  return {
    run_id: value.run_id,
    controller_id: value.controller_id,
    definition_digest: value.definition_digest,
    activation_id: value.activation_id,
    owner_epoch: value.owner_epoch,
    action_id: value.action_id,
    adapter_id: value.adapter_id,
    effect_id: value.effect_id,
    operation_id: value.operation_id,
    logical_effect_digest: value.logical_effect_digest,
    authority_digest: value.authority_digest,
    ts: 2,
  };
}

const context = {
  runId: "run",
  controllerId: "controller",
  definitionDigest: sha("6"),
  isKnownOwner: (activationId: string, ownerEpoch: number) =>
    activationId === "activation" && ownerEpoch === 2,
  hasAdapterActionIntent: () => true,
};

describe("controller effect timeline", () => {
  it("accepts an uncertain operation followed by linked read-only reconciliation", () => {
    const first = intent();
    const prep = prepared(first);
    const failed = uncertain(first, prep);
    const { diagnostic_code: _diagnostic, ...failedIdentity } = failed;
    const recovered: ControllerEffectSettledRecord = {
      ...failedIdentity,
      outcome: "not_applied",
      observed_oid: sha("2"),
      recovery: {
        prior_intent_digest: sha256Canonical(first),
        prior_prepared_digest: sha256Canonical(prep),
      },
      ts: 3,
    };
    const timeline = reconstructControllerEffectTimeline([first, prep, failed, recovered], context);
    expect(timeline.unresolved).toEqual([]);
  });

  it("rejects stale owner epochs against the current controller context", () => {
    expect(() =>
      reconstructControllerEffectTimeline([intent()], { ...context, isKnownOwner: () => false }),
    ).toThrow("current controller owner");
  });

  it("blocks the same remote lane with a fresh idempotency key and action ID", () => {
    const first = intent();
    const prep = prepared(first);
    const second = intent("action-2", { ...request, idempotency_key: "delivery-2" });
    expect(() =>
      reconstructControllerEffectTimeline([first, prep, uncertain(first, prep), second]),
    ).toThrow("logical effect is already pending, applied, or uncertain");
  });

  it("recomputes canonical request and operation identities", () => {
    const record = { ...intent(), request_digest: sha("9") };
    expect(() => assertControllerEffectRecord(record)).toThrow("request digest mismatch");
  });
});
