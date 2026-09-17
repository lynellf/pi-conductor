import { describe, expect, it } from "vitest";
import {
  assertLocalAttemptMatchesIntent,
  assertLocalAttemptOwners,
} from "../../src/host/controller/local-effect-attempt.js";
import type { LocalProgramRequest } from "../../src/manifest/controller-effect.js";
import type { ControllerEffectIntentRecord } from "../../src/persistence/controller-effect-records.js";
import type {
  LocalProgramProcessAdmittedRecord,
  LocalProgramProcessSettledRecord,
  LocalProgramProcessSpawnedRecord,
} from "../../src/persistence/controller-local-effect-process.js";

const sha = (character: string) => character.repeat(64);

const request: LocalProgramRequest = {
  schema_version: 1,
  kind: "local_program",
  repository_id: "repository",
  operation: "publish_reviewed",
  source_ref: "refs/heads/reviewed",
  target_ref: "refs/heads/main",
  reviewed_head: sha("7"),
  evidence: [],
  payload: { review: "approved" },
};

const intent: ControllerEffectIntentRecord = {
  type: "controller_effect_intent",
  schema_version: 1,
  run_id: "run",
  controller_id: "controller",
  definition_digest: sha("1"),
  activation_id: "original-owner",
  owner_epoch: 1,
  action_id: "action",
  adapter_id: "adapter",
  effect_id: "effect",
  operation_id: sha("2"),
  logical_effect_digest: sha("3"),
  authority_digest: sha("4"),
  request_artifact: {
    ref: "artifact/request",
    sha256: sha("5"),
    byte_length: 1,
    producer: { adapter_id: "adapter", action_id: "action", operation_id: "produce" },
    schema: { id: "local-request-v1", digest: sha("6") },
    run_id: "run",
    definition_digest: sha("1"),
  },
  request_digest: sha("8"),
  request,
  lane_resource: {
    kind: "local_program",
    repository_fingerprint: sha("9"),
    target_ref: request.target_ref,
    resource_keys: ["review"],
  },
  lane_key: sha("a"),
  ts: 1,
};

const admitted: LocalProgramProcessAdmittedRecord = {
  type: "controller_local_effect_process_admitted",
  schema_version: 1,
  run_id: intent.run_id,
  controller_id: intent.controller_id,
  definition_digest: intent.definition_digest,
  activation_id: intent.activation_id,
  owner_epoch: intent.owner_epoch,
  action_id: intent.action_id,
  adapter_id: intent.adapter_id,
  effect_id: intent.effect_id,
  operation_id: intent.operation_id,
  invocation_id: sha("b"),
  command: "execute",
  implementation_id: "local-provider-v1",
  implementation_digest: sha("c"),
  authority_digest: intent.authority_digest,
  request_digest: intent.request_digest,
  subject: {
    repository_id: request.repository_id,
    source_ref: request.source_ref,
    target_ref: request.target_ref,
    reviewed_head: request.reviewed_head,
  },
  supervision_id: "supervision",
  admission: {
    schema_version: 1,
    boot_id: "12345678-1234-1234-1234-123456789abc",
    pid_namespace: "pid:[1]",
    time_namespace: "time:[1]",
    network_namespace: "net:[1]",
    init_start_time: "1",
    preexisting_before: "2",
  },
  ts: 2,
};

const context = {
  runId: intent.run_id,
  controllerId: intent.controller_id,
  definitionDigest: intent.definition_digest,
};
const grant = {
  implementation_id: admitted.implementation_id,
  implementation_digest: admitted.implementation_digest,
};

function spawned(
  activationId = admitted.activation_id,
  ownerEpoch = admitted.owner_epoch,
): LocalProgramProcessSpawnedRecord {
  const { admission: _admission, ...identity } = admitted;
  return {
    ...identity,
    type: "controller_local_effect_process_spawned",
    activation_id: activationId,
    owner_epoch: ownerEpoch,
    process: { pid: 100, start_time: "3", process_group_id: 100 },
    ts: 3,
  };
}

function settled(
  activationId = admitted.activation_id,
  ownerEpoch = admitted.owner_epoch,
): LocalProgramProcessSettledRecord {
  const { admission: _admission, ...identity } = admitted;
  return {
    ...identity,
    type: "controller_local_effect_process_settled",
    activation_id: activationId,
    owner_epoch: ownerEpoch,
    outcome: "failed",
    cleanup: "confirmed",
    ts: 4,
  };
}

describe("local effect attempt recovery binding", () => {
  it("accepts a process admission bound to the exact intent and provider", () => {
    expect(() => assertLocalAttemptMatchesIntent(admitted, intent, grant, context)).not.toThrow();
  });

  it.each([
    ["request", { ...admitted, request_digest: sha("d") }],
    ["authority", { ...admitted, authority_digest: sha("e") }],
    ["provider", { ...admitted, implementation_digest: sha("f") }],
    ["subject", { ...admitted, subject: { ...admitted.subject, target_ref: "refs/heads/other" } }],
  ])("rejects an admission rebound to another %s", (_name, record) => {
    expect(() => assertLocalAttemptMatchesIntent(record, intent, grant, context)).toThrow();
  });

  it("rejects an admission written by an unknown owner", () => {
    expect(() =>
      assertLocalAttemptOwners({ admitted, spawned: null, settled: null }, () => false),
    ).toThrow("unknown controller owner");
  });

  it("rejects a spawn rebound to another owner epoch", () => {
    expect(() =>
      assertLocalAttemptOwners(
        { admitted, spawned: spawned("other-owner", 2), settled: null },
        () => true,
      ),
    ).toThrow("spawn changed controller owner");
  });

  it("accepts cleanup confirmation from a recognized recovery owner", () => {
    expect(() =>
      assertLocalAttemptOwners(
        {
          admitted,
          spawned: spawned(),
          settled: settled("recovery-owner", 2),
        },
        (activationId, ownerEpoch) =>
          (activationId === "original-owner" && ownerEpoch === 1) ||
          (activationId === "recovery-owner" && ownerEpoch === 2),
      ),
    ).not.toThrow();
  });
});
