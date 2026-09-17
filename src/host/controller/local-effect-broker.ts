/** Connect trusted local providers to existing durable effect admission and recovery (#117). */
import type { LocalProgramRequest } from "../../manifest/local-effect.js";
import {
  type ControllerEffectIntentRecord,
  type ControllerEffectPreparedRecord,
  type ControllerEffectRecord,
  isControllerEffectRecord,
} from "../../persistence/controller-effect-records.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import type { EffectBrokerDependencies } from "./effect-broker-contract.js";
import { currentEffectAuthority, type EffectObservation } from "./effect-broker-support.js";
import { assertEffectResultInScope, type PinnedEffectAuthority } from "./effect-registry.js";
import { assertDeliverySource } from "./git-effect.js";
import { admitLocalAttempt, settlePriorLocalAttempts } from "./local-effect-attempt.js";
import { resolveLocalEffectEvidence } from "./local-effect-evidence.js";
import { runTrustedLocalEffectProgram } from "./local-effect-runtime.js";

type Append = (record: ControllerEffectRecord) => Promise<void>;

/** Execute once, or inspect an existing attempt only after proving old processes settled. */
export async function runLocalProgramEffect(options: {
  readonly dependencies: EffectBrokerDependencies;
  readonly authority: PinnedEffectAuthority;
  readonly request: LocalProgramRequest;
  readonly operationId: string;
  readonly command: "execute" | "inspect";
  readonly append: Append;
  readonly persistPrepared?: (
    value: ControllerEffectPreparedRecord["postcondition"],
  ) => Promise<void>;
  readonly signal?: AbortSignal;
}): Promise<EffectObservation> {
  const { dependencies, authority, request, operationId, command, append } = options;
  if (authority.grant.kind !== "local_program")
    throw new Error("local provider authority mismatch");
  const grant = authority.grant;
  const intent = dependencies
    .records()
    .find(
      (record): record is ControllerEffectIntentRecord =>
        isControllerEffectRecord(record) &&
        record.type === "controller_effect_intent" &&
        record.operation_id === operationId,
    );
  if (intent === undefined) throw new Error("local provider requires durable intent");
  if (command === "inspect" && !(await settlePriorLocalAttempts(dependencies, intent, append)))
    return { kind: "uncertain", diagnosticCode: "local_effect_process_cleanup_unconfirmed" };
  const assertOpen = async () => {
    dependencies.assertOpen();
    options.signal?.throwIfAborted();
    await currentEffectAuthority(dependencies, grant.id, grant.adapter_id, authority);
    if (command === "execute")
      await assertDeliverySource({
        authority,
        request,
        resolveEvidence: (claim) => dependencies.resolveHeadEvidence(grant.id, claim),
      });
    dependencies.assertOpen();
    options.signal?.throwIfAborted();
  };
  await assertOpen();
  const resolveBytes = dependencies.resolveEvidenceBytes;
  if (resolveBytes === undefined) throw new Error("local effect evidence resolver is unavailable");
  const evidence = await resolveLocalEffectEvidence(
    request,
    grant.max_input_bytes,
    (claim) => dependencies.resolveHeadEvidence(grant.id, claim),
    (claim) => resolveBytes(grant.id, claim),
  );
  if (command === "execute") {
    if (options.persistPrepared === undefined)
      throw new Error("local effect preparation is unavailable");
    await options.persistPrepared({
      kind: "local_program",
      repository_fingerprint: grant.repository.fingerprint,
      source_ref: request.source_ref,
      target_ref: request.target_ref,
      reviewed_head: request.reviewed_head,
      operation: request.operation,
      implementation_id: grant.implementation_id,
      implementation_digest: grant.implementation_digest,
      request_digest: sha256Canonical(request),
    });
  }
  await assertOpen();
  const attempt = await admitLocalAttempt(dependencies, intent, command, append);
  const result = await runTrustedLocalEffectProgram({
    grant,
    invocation: {
      protocol_version: 1,
      operation_id: operationId,
      invocation_id: attempt.invocationId,
      command,
      implementation_id: grant.implementation_id,
      implementation_digest: grant.implementation_digest,
      authority_digest: authority.authority_digest,
      request_digest: intent.request_digest,
      request,
      evidence,
    },
    hostDriverDigest: grant.host_driver_digest,
    workspaceRoot: dependencies.workspaceRoot,
    credentialFiles: dependencies.credentialFiles,
    processAdmission: attempt.processAdmission,
    assertInvocationOpen: assertOpen,
    onSpawn: attempt.onSpawn,
    onSettled: attempt.onSettled,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (result.kind === "uncertain") return result;
  const outcome = result.outcome;
  if (outcome.status === "applied") {
    assertEffectResultInScope(authority, request, outcome.result);
    return { kind: "applied", result: outcome.result };
  }
  if (outcome.status === "not_applied") {
    assertEffectResultInScope(authority, request, outcome.observation);
    return { kind: "not_applied", observedOid: null, localObservation: outcome.observation };
  }
  return { kind: "uncertain", diagnosticCode: "local_provider_reported_uncertainty" };
}
