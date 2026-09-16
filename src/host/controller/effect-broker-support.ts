/** Validation, lane, and postcondition helpers for the controller effect broker. */
import { createHash } from "node:crypto";
import {
  type EffectRequest,
  type EffectResult,
  validateEffectRequest,
} from "../../manifest/controller-effect.js";
import type {
  ControllerEffectIntentRecord,
  ControllerEffectPreparedRecord,
  ControllerEffectRecord,
  ControllerEffectSettledRecord,
} from "../../persistence/controller-effect-records.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import type {
  EffectBrokerDependencies,
  ExecuteControllerEffectInput,
} from "./effect-broker-contract.js";
import { type PinnedEffectAuthority, verifyEffectAuthority } from "./effect-registry.js";
import type { GitEffectPrepared } from "./git-effect.js";

export async function currentEffectAuthority(
  dependencies: EffectBrokerDependencies,
  effectId: string,
  adapterId: string,
  pinnedAuthority: PinnedEffectAuthority,
): Promise<PinnedEffectAuthority> {
  if (pinnedAuthority.grant.id !== effectId || pinnedAuthority.grant.adapter_id !== adapterId)
    throw new Error("effect action does not match pinned grant");
  return verifyEffectAuthority(
    pinnedAuthority,
    await dependencies.currentEffectGrants(),
    await dependencies.currentSupportedImplementations(),
  );
}

export function effectRecordIdentity(intent: ControllerEffectIntentRecord, ts: number) {
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

export type EffectObservation =
  | { readonly kind: "applied"; readonly result: EffectResult }
  | { readonly kind: "not_applied"; readonly observedOid: string | null }
  | { readonly kind: "uncertain"; readonly diagnosticCode: string };

export async function settleEffect(
  append: (record: ControllerEffectRecord) => Promise<void>,
  intent: ControllerEffectIntentRecord,
  prepared: ControllerEffectPreparedRecord | null,
  observation: EffectObservation,
  ts: number,
  recovery: ControllerEffectSettledRecord["recovery"],
  writer?: { readonly activationId: string; readonly ownerEpoch: number },
): Promise<ControllerEffectSettledRecord> {
  const record: ControllerEffectSettledRecord = {
    ...effectRecordIdentity(intent, ts),
    ...(writer === undefined
      ? {}
      : { activation_id: writer.activationId, owner_epoch: writer.ownerEpoch }),
    type: "controller_effect_settled",
    schema_version: 1,
    intent_digest: sha256Canonical(intent),
    prepared_digest: prepared === null ? null : sha256Canonical(prepared),
    outcome: observation.kind,
    ...(observation.kind === "applied" ? { result: observation.result } : {}),
    ...(observation.kind === "not_applied" ? { observed_oid: observation.observedOid } : {}),
    ...(observation.kind === "uncertain" ? { diagnostic_code: observation.diagnosticCode } : {}),
    recovery,
  };
  await append(record);
  return record;
}

export function effectTimelineContext(dependencies: EffectBrokerDependencies) {
  return {
    runId: dependencies.runId,
    controllerId: dependencies.controllerId,
    definitionDigest: dependencies.definitionDigest,
    isKnownOwner: dependencies.isKnownOwner,
    hasAdapterActionIntent: (actionId: string, adapterId: string) => {
      try {
        dependencies.assertActionIntent(actionId, adapterId);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export async function resolveEffectRequest(
  dependencies: EffectBrokerDependencies,
  input: ExecuteControllerEffectInput,
  authority: PinnedEffectAuthority,
): Promise<EffectRequest> {
  const resolved = await dependencies.resolveRequestArtifact(input.requestArtifact);
  if (
    sha256Canonical(resolved.artifact) !== sha256Canonical(input.requestArtifact) ||
    resolved.artifact.run_id !== dependencies.runId ||
    resolved.artifact.definition_digest !== dependencies.definitionDigest ||
    resolved.artifact.producer.adapter_id !== input.adapterId ||
    resolved.artifact.producer.action_id !== input.actionId ||
    resolved.artifact.schema.id !== authority.grant.request_schema_id ||
    resolved.artifact.schema.digest !== authority.grant.request_schema_digest ||
    resolved.artifact.byte_length !== resolved.bytes.byteLength ||
    resolved.artifact.sha256 !== createHash("sha256").update(resolved.bytes).digest("hex")
  )
    throw new Error("effect request artifact binding is not verified");
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(resolved.bytes));
  } catch {
    throw new Error("effect request artifact is not canonical JSON");
  }
  return validateEffectRequest(authority.grant.kind, decoded);
}

export function effectLane(authority: PinnedEffectAuthority, request: EffectRequest) {
  const resource =
    request.kind === "deliver_ref" && authority.grant.kind === "deliver_ref"
      ? {
          kind: "remote" as const,
          exact_origin: authority.grant.remote.exact_origin,
          exact_path: authority.grant.remote.exact_path,
          target_ref: request.target_ref,
        }
      : {
          kind: "git" as const,
          repository_fingerprint: authority.grant.repository.fingerprint,
          target_ref:
            request.kind === "git_integrate" ? request.integration_ref : request.target_ref,
        };
  return Object.freeze({
    resource,
    key: sha256Canonical({ domain: "pi-conductor/effect-lane/v1", resource }),
  });
}

export async function inEffectLane<T>(
  lanes: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const prior = lanes.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  lanes.set(key, current);
  await prior;
  try {
    return await operation();
  } finally {
    release();
    if (lanes.get(key) === current) lanes.delete(key);
  }
}

export function gitPostcondition(
  value: GitEffectPrepared,
): ControllerEffectPreparedRecord["postcondition"] {
  return {
    kind: value.kind,
    helper_operation_id: value.operationId,
    repository_fingerprint: value.repositoryFingerprint,
    source_head: value.sourceHead,
    target_ref: value.targetRef,
    expected_prior: value.expectedPrior,
    applied_head: value.integratedHead,
    source_artifact: value.sourceArtifact,
  };
}

export function remotePostcondition(
  value: import("./remote-effect.js").RemoteEffectPrepared,
): ControllerEffectPreparedRecord["postcondition"] {
  return {
    kind: "deliver_ref",
    remote_id: value.remoteId,
    exact_origin: value.exactOrigin,
    exact_path: value.exactPath,
    target_ref: value.targetRef,
    reviewed_head: value.reviewedHead,
    expected_prior: value.expectedPrior,
    idempotency_key: value.idempotencyKey,
    credential_source_id: value.credentialSourceId,
  };
}

export function fromGitPostcondition(prepared: ControllerEffectPreparedRecord): GitEffectPrepared {
  const value = prepared.postcondition;
  if (value.kind === "deliver_ref") throw new Error("remote postcondition is not a Git effect");
  return {
    operationId: value.helper_operation_id,
    repositoryFingerprint: value.repository_fingerprint,
    kind: value.kind,
    sourceHead: value.source_head,
    targetRef: value.target_ref,
    expectedPrior: value.expected_prior,
    integratedHead: value.applied_head,
    sourceArtifact: value.source_artifact,
  };
}

export function resultFromPrepared(
  request: Exclude<EffectRequest, { readonly kind: "deliver_ref" }>,
  prepared: ControllerEffectPreparedRecord,
): EffectResult {
  const post = prepared.postcondition;
  if (request.kind === "git_integrate" && post.kind === "git_integrate") {
    if (post.source_artifact === null) throw new Error("integration source artifact is missing");
    return {
      schema_version: 1,
      kind: "git_integrate",
      repository_id: request.repository_id,
      accepted_base: request.accepted_base,
      integrated_head: post.applied_head,
      integration_ref: request.integration_ref,
      prior_ref_oid: post.expected_prior,
      source_artifact_ref: post.source_artifact.ref,
      source_artifact_sha256: post.source_artifact.sha256,
    };
  }
  if (request.kind === "git_promote" && post.kind === "git_promote")
    return {
      schema_version: 1,
      kind: "git_promote",
      repository_id: request.repository_id,
      source_ref: request.source_ref,
      reviewed_head: request.reviewed_head,
      target_ref: request.target_ref,
      prior_target_oid: post.expected_prior,
      promoted_head: post.applied_head,
    };
  throw new Error("prepared Git postcondition differs from request");
}
