/** Durable process ownership for trusted local effect execution and inspection (#117). */
import { randomUUID } from "node:crypto";
import type {
  ControllerEffectIntentRecord,
  ControllerEffectRecord,
} from "../../persistence/controller-effect-records.js";
import type { LocalProgramProcessAdmittedRecord } from "../../persistence/controller-local-effect-process.js";
import {
  type LocalProgramProcessAttempt,
  reconstructLocalProgramProcessTimeline,
} from "../../persistence/controller-local-effect-process-timeline.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import type { ProcessIdentity } from "../execution/supervised-process-identity.js";
import type { EffectBrokerDependencies } from "./effect-broker-contract.js";
import {
  captureLocalProgramProcessAdmission,
  inspectLocalProgramProcessAdmission,
  type LocalProgramProcessSettlement,
} from "./local-effect-runtime.js";

type Append = (record: ControllerEffectRecord) => Promise<void>;

/** Resolve all prior process uncertainty before the provider may inspect remote state. */
export async function settlePriorLocalAttempts(
  dependencies: EffectBrokerDependencies,
  intent: ControllerEffectIntentRecord,
  append: Append,
): Promise<boolean> {
  const grant = dependencies.pinnedAuthority(intent.effect_id).grant;
  if (grant.kind !== "local_program") throw new Error("local attempt requires local grant");
  const attempts = reconstructLocalProgramProcessTimeline(dependencies.records()).attempts.filter(
    ({ admitted }) => admitted.operation_id === intent.operation_id,
  );
  for (const attempt of attempts) {
    const { admitted, spawned, settled } = attempt;
    assertLocalAttemptMatchesIntent(admitted, intent, grant, dependencies);
    assertLocalAttemptOwners(attempt, dependencies.isKnownOwner);
    if (settled?.cleanup === "confirmed") continue;
    const observed = await inspectLocalProgramProcessAdmission({
      supervisionId: admitted.supervision_id,
      admission: admitted.admission,
      ...(spawned === null
        ? {}
        : {
            spawnedIdentity: {
              pid: spawned.process.pid,
              startTime: spawned.process.start_time,
              processGroupId: spawned.process.process_group_id,
              ...(spawned.process.session_id === undefined
                ? {}
                : { sessionId: spawned.process.session_id }),
              ...(spawned.process.owner_token === undefined
                ? {}
                : { ownerToken: spawned.process.owner_token }),
            },
          }),
    });
    if (observed.state !== "stopped") return false;
    await append({
      ...processRecordIdentity(dependencies, intent, admitted.invocation_id, admitted.command),
      type: "controller_local_effect_process_settled",
      supervision_id: admitted.supervision_id,
      cleanup: "confirmed",
      outcome: "failed",
    });
  }
  return true;
}

/** Reject process records that are not bound to the exact durable effect and provider. */
export function assertLocalAttemptMatchesIntent(
  admitted: LocalProgramProcessAdmittedRecord,
  intent: ControllerEffectIntentRecord,
  grant: {
    readonly implementation_id: string;
    readonly implementation_digest: string;
  },
  context: Pick<EffectBrokerDependencies, "runId" | "controllerId" | "definitionDigest">,
): void {
  if (intent.request.kind !== "local_program")
    throw new Error("local attempt requires local intent");
  const expected = {
    run_id: context.runId,
    controller_id: context.controllerId,
    definition_digest: context.definitionDigest,
    action_id: intent.action_id,
    adapter_id: intent.adapter_id,
    effect_id: intent.effect_id,
    operation_id: intent.operation_id,
    implementation_id: grant.implementation_id,
    implementation_digest: grant.implementation_digest,
    authority_digest: intent.authority_digest,
    request_digest: intent.request_digest,
  };
  for (const field of [
    "run_id",
    "controller_id",
    "definition_digest",
    "action_id",
    "adapter_id",
    "effect_id",
    "operation_id",
    "implementation_id",
    "implementation_digest",
    "authority_digest",
    "request_digest",
  ] as const)
    if (admitted[field] !== expected[field])
      throw new Error("local effect process record differs from its durable intent");
  const subject = {
    repository_id: intent.request.repository_id,
    source_ref: intent.request.source_ref,
    target_ref: intent.request.target_ref,
    reviewed_head: intent.request.reviewed_head,
  };
  if (sha256Canonical(admitted.subject) !== sha256Canonical(subject))
    throw new Error("local effect process subject differs from its durable intent");
}

/** Require every process-journal writer to be a recognized controller owner. */
export function assertLocalAttemptOwners(
  attempt: LocalProgramProcessAttempt,
  isKnownOwner: (activationId: string, ownerEpoch: number) => boolean,
): void {
  const { admitted, spawned, settled } = attempt;
  if (
    spawned !== null &&
    (spawned.activation_id !== admitted.activation_id ||
      spawned.owner_epoch !== admitted.owner_epoch)
  )
    throw new Error("local effect spawn changed controller owner");
  for (const record of [
    admitted,
    ...(spawned === null ? [] : [spawned]),
    ...(settled === null ? [] : [settled]),
  ])
    if (!isKnownOwner(record.activation_id, record.owner_epoch))
      throw new Error("local effect process record has an unknown controller owner");
}

/** Reserve an attempt identity and observation baseline before spawning a trusted program. */
export async function admitLocalAttempt(
  dependencies: EffectBrokerDependencies,
  intent: ControllerEffectIntentRecord,
  command: "execute" | "inspect",
  append: Append,
) {
  const processAdmission = await captureLocalProgramProcessAdmission();
  const invocationId = sha256Canonical({
    operation_id: intent.operation_id,
    command,
    nonce: randomUUID(),
  });
  const identity = () => processRecordIdentity(dependencies, intent, invocationId, command);
  await append({
    ...identity(),
    type: "controller_local_effect_process_admitted",
    supervision_id: processAdmission.supervisionId,
    admission: processAdmission.admission,
  });
  return {
    invocationId,
    processAdmission,
    onSpawn: async (process: ProcessIdentity) =>
      append({
        ...identity(),
        type: "controller_local_effect_process_spawned",
        supervision_id: processAdmission.supervisionId,
        process: durableProcessIdentity(process),
      }),
    onSettled: async (settlement: LocalProgramProcessSettlement) => {
      if (
        settlement.operationId !== intent.operation_id ||
        settlement.invocationId !== invocationId ||
        settlement.supervisionId !== processAdmission.supervisionId
      )
        throw new Error("local effect process settlement identity mismatch");
      await append({
        ...identity(),
        type: "controller_local_effect_process_settled",
        supervision_id: processAdmission.supervisionId,
        cleanup: settlement.cleanup,
        outcome: settlement.outcome,
        ...(settlement.identity === null
          ? {}
          : { observed_process: durableProcessIdentity(settlement.identity) }),
      });
    },
  };
}

function processRecordIdentity(
  dependencies: EffectBrokerDependencies,
  intent: ControllerEffectIntentRecord,
  invocationId: string,
  command: "execute" | "inspect",
) {
  if (intent.request.kind !== "local_program")
    throw new Error("local attempt requires local intent");
  const grant = dependencies.pinnedAuthority(intent.effect_id).grant;
  if (grant.kind !== "local_program") throw new Error("local attempt requires local grant");
  return {
    schema_version: 1 as const,
    run_id: intent.run_id,
    controller_id: intent.controller_id,
    definition_digest: intent.definition_digest,
    activation_id: dependencies.activationId,
    owner_epoch: dependencies.ownerEpoch,
    action_id: intent.action_id,
    adapter_id: intent.adapter_id,
    effect_id: intent.effect_id,
    operation_id: intent.operation_id,
    invocation_id: invocationId,
    command,
    implementation_id: grant.implementation_id,
    implementation_digest: grant.implementation_digest,
    authority_digest: intent.authority_digest,
    request_digest: intent.request_digest,
    subject: {
      repository_id: intent.request.repository_id,
      source_ref: intent.request.source_ref,
      target_ref: intent.request.target_ref,
      reviewed_head: intent.request.reviewed_head,
    },
    ts: (dependencies.now ?? Date.now)(),
  };
}

function durableProcessIdentity(value: ProcessIdentity) {
  return {
    pid: value.pid,
    start_time: value.startTime,
    process_group_id: value.processGroupId,
    ...(value.sessionId === undefined ? {} : { session_id: value.sessionId }),
    ...(value.ownerToken === undefined ? {} : { owner_token: value.ownerToken }),
  };
}
