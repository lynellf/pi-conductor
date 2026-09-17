/** Cross-ledger authority regression coverage for effect journal appends — issue #116. */
import { describe, expect, it } from "vitest";
import { approveControllerDefinition } from "../../src/host/controller/approved-definition.js";
import { validateControllerHostApproval } from "../../src/host/controller/host-approval.js";
import { parseControllerConfig } from "../../src/manifest/controller.js";
import {
  effectRequestSchemaDigest,
  effectRequestSchemaFor,
  effectResultSchemaDigest,
} from "../../src/manifest/controller-effect.js";
import { assertControllerEffectHistory } from "../../src/persistence/controller-effect-history.js";
import {
  type ControllerEffectIntentRecord,
  type ControllerEffectPreparedRecord,
  type ControllerEffectSettledRecord,
  controllerEffectOperationId,
  controllerLogicalEffectDigest,
  logicalRequestDigest,
} from "../../src/persistence/controller-effect-records.js";
import type { LocalProgramProcessAdmittedRecord } from "../../src/persistence/controller-local-effect-process.js";
import {
  type ControllerActivationStartedRecord,
  type ControllerDecisionCommittedRecord,
  controllerActionRequestDigest,
} from "../../src/persistence/controller-records.js";
import { InMemoryRecordLog } from "../../src/persistence/in-memory-log.js";
import type { PersistedRecord } from "../../src/persistence/log.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";

const sha = (character: string) => character.repeat(64);

function history(): readonly PersistedRecord[] {
  const adapter = {
    id: "delivery-adapter",
    runtime_id: "runtime",
    executable: "/bin/bash",
    argv: ["/opt/deliver-ref"],
    capability: "read_only" as const,
    input_schema_id: "adapter-input",
    output_schema_id: "deliver-ref-request-v1",
    effect_id: "delivery",
    output_consumers: [{ kind: "effect" as const, effect_id: "delivery" }],
  };
  const grant = {
    schema_version: 1 as const,
    id: "delivery",
    adapter_id: adapter.id,
    implementation_id: "builtin-deliver-ref-v1",
    implementation_digest: sha("1"),
    kind: "deliver_ref" as const,
    request_schema_id: adapter.output_schema_id,
    request_schema_digest: effectRequestSchemaDigest("deliver_ref"),
    output_schema_id: "deliver-ref-result-v1",
    output_schema_digest: effectResultSchemaDigest("deliver_ref"),
    repository: { id: "repo", canonical_path: "/operator/repo", fingerprint: sha("2") },
    remote: {
      id: "origin",
      exact_origin: "https://delivery.invalid",
      exact_path: "/v1/ref",
      method: "PUT" as const,
      credential_source_id: "credential",
    },
    allowed_source_refs: ["refs/integration/reviewed"],
    allowed_target_refs: ["refs/heads/main"],
    required_evidence: [{ producer_id: "validator", schema_id: "validation-v1" }],
    max_input_bytes: 65_536,
    max_output_bytes: 65_536,
    timeout_seconds: 30,
  };
  const program = {
    controller_id: "controller",
    runtime_id: "runtime",
    executable: "/bin/bash",
    argv: [],
  };
  const config = parseControllerConfig({
    protocol_version: 1,
    ...program,
    adapters: [adapter],
    delegation: { allowed_subagents: ["worker"], max_children_per_session: 1, max_parallel: 1 },
  });
  const inputSchema = { type: "object" };
  const approval = validateControllerHostApproval({
    schema_version: 1,
    approval_id: "operator",
    runtimes: [
      {
        runtime_id: "runtime",
        source_root: "/operator/runtime",
        inventory_sha256: sha("3"),
        bootstrap_approval: {
          approvalId: "runtime",
          files: [{ path: "bin/bash", sha256: sha("4") }],
        },
      },
    ],
    controllers: [program],
    adapters: [adapter],
    schemas: [
      {
        schema_id: "adapter-input",
        schema_digest: sha256Canonical(inputSchema),
        schema: inputSchema,
      },
      {
        schema_id: adapter.output_schema_id,
        schema_digest: effectRequestSchemaDigest("deliver_ref"),
        schema: effectRequestSchemaFor("deliver_ref"),
      },
    ],
    credential_sources: [{ id: "credential", path: "/operator/credential" }],
    effects: [grant],
  });
  const definition = approveControllerDefinition("run", config, approval, 1).record;
  const activation: ControllerActivationStartedRecord = {
    type: "controller_activation_started",
    schema_version: 1,
    run_id: "run",
    controller_id: "controller",
    definition_digest: definition.definition_digest,
    activation_id: "activation",
    owner_epoch: 1,
    reason: "start",
    previous_activation_id: null,
    ts: 2,
  };
  const request = {
    schema_version: 1 as const,
    kind: "deliver_ref" as const,
    repository_id: "repo",
    source_ref: "refs/integration/reviewed",
    reviewed_head: sha("5"),
    remote_id: "origin",
    target_ref: "refs/heads/main",
    expected_remote_oid: sha("6"),
    idempotency_key: "delivery-1",
    evidence: [
      {
        artifact_ref: "artifact/evidence",
        sha256: sha("7"),
        producer_id: "validator",
        schema_id: "validation-v1",
        subject_head: sha("5"),
        verdict: "approved" as const,
      },
    ],
  };
  const action = {
    kind: "adapter" as const,
    action_id: "action",
    adapter_id: adapter.id,
    input_refs: [],
  };
  const decision: ControllerDecisionCommittedRecord = {
    type: "controller_decision_committed",
    schema_version: 1,
    run_id: "run",
    controller_id: "controller",
    definition_digest: definition.definition_digest,
    activation_id: "activation",
    owner_epoch: 1,
    decision_id: "decision",
    prior_revision: 0,
    state_revision: 1,
    prior_cursor: null,
    consumed_cursor: { ordinal: 1, record_digest: sha256Canonical(activation) },
    response_kind: "plan",
    controller_state: {},
    decision_payload: null,
    actions: [
      {
        action_id: action.action_id,
        kind: action.kind,
        request_sha256: controllerActionRequestDigest(definition.definition_digest, action),
        request: action,
      },
    ],
    ts: 3,
  };
  const authority = effectAuthority(definition.pinned_definition);
  const artifact = {
    ref: "artifact/delivery-request",
    sha256: sha("8"),
    byte_length: 100,
    producer: {
      adapter_id: adapter.id,
      action_id: action.action_id,
      operation_id: "adapter-operation",
    },
    schema: { id: grant.request_schema_id, digest: grant.request_schema_digest },
    run_id: "run",
    definition_digest: definition.definition_digest,
  };
  const intent: ControllerEffectIntentRecord = {
    type: "controller_effect_intent",
    schema_version: 1,
    run_id: "run",
    controller_id: "controller",
    definition_digest: definition.definition_digest,
    activation_id: "activation",
    owner_epoch: 1,
    action_id: action.action_id,
    adapter_id: adapter.id,
    effect_id: grant.id,
    operation_id: controllerEffectOperationId({
      runId: "run",
      definitionDigest: definition.definition_digest,
      actionId: action.action_id,
      artifact,
      authorityDigest: authority.authority_digest,
    }),
    logical_effect_digest: controllerLogicalEffectDigest({
      definitionDigest: definition.definition_digest,
      authorityDigest: authority.authority_digest,
      requestDigest: logicalRequestDigest(request),
    }),
    authority_digest: authority.authority_digest,
    request_artifact: artifact,
    request_digest: sha256Canonical(request),
    request,
    lane_resource: {
      kind: "remote",
      exact_origin: grant.remote.exact_origin,
      exact_path: grant.remote.exact_path,
      target_ref: request.target_ref,
    },
    lane_key: sha256Canonical({
      domain: "pi-conductor/effect-lane/v1",
      resource: {
        kind: "remote",
        exact_origin: grant.remote.exact_origin,
        exact_path: grant.remote.exact_path,
        target_ref: request.target_ref,
      },
    }),
    ts: 4,
  };
  const prepared: ControllerEffectPreparedRecord = {
    type: "controller_effect_prepared",
    schema_version: 1,
    ...effectIdentity(intent, 5),
    intent_digest: sha256Canonical(intent),
    postcondition: {
      kind: "deliver_ref",
      remote_id: "origin",
      exact_origin: grant.remote.exact_origin,
      exact_path: grant.remote.exact_path,
      target_ref: request.target_ref,
      reviewed_head: request.reviewed_head,
      expected_prior: request.expected_remote_oid,
      idempotency_key: request.idempotency_key,
      credential_source_id: grant.remote.credential_source_id,
    },
  };
  const settled: ControllerEffectSettledRecord = {
    type: "controller_effect_settled",
    schema_version: 1,
    ...effectIdentity(intent, 6),
    intent_digest: sha256Canonical(intent),
    prepared_digest: sha256Canonical(prepared),
    outcome: "applied",
    result: {
      schema_version: 1,
      kind: "deliver_ref",
      repository_id: request.repository_id,
      remote_id: request.remote_id,
      target_ref: request.target_ref,
      reviewed_head: request.reviewed_head,
      prior_remote_oid: request.expected_remote_oid,
      remote_object_oid: request.reviewed_head,
      idempotency_key: request.idempotency_key,
    },
    recovery: null,
  };
  return [definition, activation, decision, intent, prepared, settled];
}

function effectAuthority(value: unknown): { readonly authority_digest: string } {
  if (value === null || typeof value !== "object" || !("effects" in value))
    throw new Error("missing effect authority");
  const effects = value.effects;
  if (!Array.isArray(effects) || effects.length !== 1) throw new Error("missing pinned effect");
  const effect = effects[0];
  if (effect === null || typeof effect !== "object" || !("authority_digest" in effect))
    throw new Error("malformed pinned effect");
  return effect as { readonly authority_digest: string };
}

function effectIdentity(intent: ControllerEffectIntentRecord, ts: number) {
  return {
    run_id: intent.run_id,
    controller_id: intent.controller_id,
    definition_digest: intent.definition_digest,
    activation_id: intent.activation_id,
    owner_epoch: intent.owner_epoch,
    action_id: intent.action_id,
    adapter_id: intent.adapter_id,
    effect_id: intent.effect_id,
    operation_id: intent.operation_id,
    logical_effect_digest: intent.logical_effect_digest,
    authority_digest: intent.authority_digest,
    ts,
  };
}

function effectAt(
  records: readonly PersistedRecord[],
  type: ControllerEffectIntentRecord["type"],
): ControllerEffectIntentRecord;
function effectAt(
  records: readonly PersistedRecord[],
  type: ControllerEffectPreparedRecord["type"],
): ControllerEffectPreparedRecord;
function effectAt(
  records: readonly PersistedRecord[],
  type: ControllerEffectSettledRecord["type"],
): ControllerEffectSettledRecord;
function effectAt(records: readonly PersistedRecord[], type: string) {
  const record = records.find((candidate) => candidate.type === type);
  if (record === undefined) throw new Error(`missing ${type}`);
  return record;
}

describe("controller effect history", () => {
  it("accepts a complete real controller action, pinned grant, and settled effect journal", () => {
    const records = history();
    const log = new InMemoryRecordLog();
    try {
      for (const record of records) log.append(record);
      expect(log.records("run")).toHaveLength(records.length);
    } finally {
      log.close();
    }
  });

  it.each([
    [
      "wrong owner",
      (records: readonly PersistedRecord[]) => ({
        ...effectAt(records, "controller_effect_intent"),
        owner_epoch: 2,
      }),
      "does not belong to current controller owner",
    ],
    [
      "wrong adapter action",
      (records: readonly PersistedRecord[]) => {
        const intent = effectAt(records, "controller_effect_intent");
        const artifact = {
          ...intent.request_artifact,
          producer: { ...intent.request_artifact.producer, action_id: "unknown" },
        };
        return {
          ...intent,
          action_id: "unknown",
          request_artifact: artifact,
          operation_id: controllerEffectOperationId({
            runId: intent.run_id,
            definitionDigest: intent.definition_digest,
            actionId: "unknown",
            artifact,
            authorityDigest: intent.authority_digest,
          }),
        };
      },
      "has no preceding adapter action intent",
    ],
    [
      "wrong pinned grant",
      (records: readonly PersistedRecord[]) => ({
        ...effectAt(records, "controller_effect_intent"),
        effect_id: "other-effect",
      }),
      "outside the pinned adapter grant",
    ],
    [
      "wrong request schema",
      (records: readonly PersistedRecord[]) => {
        const intent = effectAt(records, "controller_effect_intent");
        const artifact = {
          ...intent.request_artifact,
          schema: { id: "wrong", digest: sha("9") },
        };
        return {
          ...intent,
          request_artifact: artifact,
          operation_id: controllerEffectOperationId({
            runId: intent.run_id,
            definitionDigest: intent.definition_digest,
            actionId: intent.action_id,
            artifact,
            authorityDigest: intent.authority_digest,
          }),
        };
      },
      "effect request artifact does not match pinned action authority",
    ],
  ])("rejects an effect journal with a %s", (_case, corrupt, message) => {
    const records = history();
    const candidate = corrupt(records) as PersistedRecord;
    expect(() => assertControllerEffectHistory([...records.slice(0, 3), candidate])).toThrow(
      message,
    );
  });

  it("rejects a prepared remote outside its exact pinned scope", () => {
    const records = history();
    const intent = effectAt(records, "controller_effect_intent");
    const prepared = effectAt(records, "controller_effect_prepared");
    const corrupted = {
      ...prepared,
      postcondition: { ...prepared.postcondition, exact_path: "/v2/ref" },
    } as ControllerEffectPreparedRecord;
    const settled = effectAt(records, "controller_effect_settled");
    const repairedDigest = { ...settled, prepared_digest: sha256Canonical(corrupted) };
    expect(() =>
      assertControllerEffectHistory([...records.slice(0, 3), intent, corrupted, repairedDigest]),
    ).toThrow("prepared remote scope is not approved");
  });

  it("rejects a stale local process attempt before accepting its recovery binding", () => {
    const records = history();
    const intent = effectAt(records, "controller_effect_intent");
    const stale: LocalProgramProcessAdmittedRecord = {
      type: "controller_local_effect_process_admitted",
      schema_version: 1,
      run_id: intent.run_id,
      controller_id: intent.controller_id,
      definition_digest: intent.definition_digest,
      activation_id: intent.activation_id,
      owner_epoch: intent.owner_epoch + 1,
      action_id: intent.action_id,
      adapter_id: intent.adapter_id,
      effect_id: intent.effect_id,
      operation_id: intent.operation_id,
      invocation_id: sha("9"),
      command: "inspect",
      implementation_id: "local-provider-v1",
      implementation_digest: sha("a"),
      authority_digest: intent.authority_digest,
      request_digest: intent.request_digest,
      subject: {
        repository_id: "repo",
        source_ref: "refs/integration/reviewed",
        target_ref: "refs/heads/main",
        reviewed_head: sha("5"),
      },
      supervision_id: "supervision",
      admission: {
        schema_version: 1,
        boot_id: "00000000-0000-4000-8000-000000000000",
        pid_namespace: "pid:[1]",
        time_namespace: "time:[1]",
        network_namespace: "net:[1]",
        init_start_time: "1",
        preexisting_before: "1",
      },
      ts: 7,
    };
    expect(() => assertControllerEffectHistory([...records.slice(0, 3), intent, stale])).toThrow(
      "does not belong to current controller owner",
    );
  });
});
