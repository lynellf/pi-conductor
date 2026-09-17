/** Execute and observe registered effects after durable admission (#116/#117). */
import type { EffectRequest, EffectResult } from "../../manifest/controller-effect.js";
import type {
  ControllerEffectPreparedRecord,
  ControllerEffectRecord,
} from "../../persistence/controller-effect-records.js";
import type { EffectBrokerDependencies } from "./effect-broker-contract.js";
import {
  currentEffectAuthority,
  type EffectObservation,
  fromGitPostcondition,
  gitPostcondition,
  remotePostcondition,
  resultFromPrepared,
} from "./effect-broker-support.js";
import { assertEffectResultInScope, type PinnedEffectAuthority } from "./effect-registry.js";
import { runLocalProgramEffect } from "./local-effect-broker.js";

/** Execute the pinned implementation after intent admission, preserving preparation ordering. */
export async function dispatchEffect(
  dependencies: EffectBrokerDependencies,
  executors: Required<NonNullable<EffectBrokerDependencies["executors"]>>,
  authority: PinnedEffectAuthority,
  request: EffectRequest,
  operationId: string,
  persist: (postcondition: ControllerEffectPreparedRecord["postcondition"]) => Promise<void>,
  append: (record: ControllerEffectRecord) => Promise<void>,
  signal?: AbortSignal,
): Promise<EffectObservation> {
  dependencies.assertOpen();
  signal?.throwIfAborted();
  if (request.kind === "local_program")
    return runLocalProgramEffect({
      dependencies,
      authority,
      request,
      operationId,
      command: "execute",
      append,
      persistPrepared: persist,
      ...(signal === undefined ? {} : { signal }),
    });
  if (request.kind === "git_integrate") {
    if (request.source_workspace_descriptor === undefined) {
      const outcome = await executors.integrate({
        authority,
        request,
        workspaceRoot: dependencies.workspaceRoot,
        resolvePatch: (claim) => dependencies.resolvePatch(authority.grant.id, claim),
        publishSelectedSource: (source) =>
          dependencies.publishIntegratedSource(authority.grant.id, operationId, source),
        persistPrepared: (value) => persist(gitPostcondition(value)),
        assertEffectOpen: async () => {
          await currentEffectAuthority(
            dependencies,
            authority.grant.id,
            authority.grant.adapter_id,
            authority,
          );
          dependencies.assertOpen();
        },
        assertOpen: dependencies.assertOpen,
        ...(signal === undefined ? {} : { signal }),
      });
      const result: EffectResult = {
        schema_version: 1,
        kind: "git_integrate",
        repository_id: request.repository_id,
        accepted_base: request.accepted_base,
        integrated_head: outcome.integratedHead,
        integration_ref: request.integration_ref,
        prior_ref_oid: outcome.priorRefOid,
        source_artifact_ref: outcome.sourceArtifact.ref,
        source_artifact_sha256: outcome.sourceArtifact.sha256,
      };
      assertEffectResultInScope(authority, request, result);
      return { kind: "applied", result };
    }
    if (dependencies.resolveSourceWorkspace === undefined)
      throw new Error("source bridge requires host resolveSourceWorkspace dependency");
    const integrateFromSourceWorkspace = executors.integrateFromSourceWorkspace;
    if (integrateFromSourceWorkspace === undefined)
      throw new Error("source bridge executor is not configured");
    const outcome = await integrateFromSourceWorkspace({
      authority,
      request,
      workspaceRoot: dependencies.workspaceRoot,
      resolvePatch: (claim) => dependencies.resolvePatch(authority.grant.id, claim),
      resolveSourceWorkspace: dependencies.resolveSourceWorkspace,
      publishSelectedSource: (source) =>
        dependencies.publishIntegratedSource(authority.grant.id, operationId, source),
      persistPrepared: (value) => persist(gitPostcondition(value)),
      assertEffectOpen: async () => {
        await currentEffectAuthority(
          dependencies,
          authority.grant.id,
          authority.grant.adapter_id,
          authority,
        );
        dependencies.assertOpen();
      },
      assertOpen: dependencies.assertOpen,
      ...(signal === undefined ? {} : { signal }),
    });
    const baseResult: EffectResult = {
      schema_version: 1,
      kind: "git_integrate",
      repository_id: request.repository_id,
      accepted_base: request.accepted_base,
      integrated_head: outcome.integratedHead,
      integration_ref: request.integration_ref,
      prior_ref_oid: outcome.priorRefOid,
      source_artifact_ref: outcome.sourceArtifact.ref,
      source_artifact_sha256: outcome.sourceArtifact.sha256,
    };
    const result = Object.freeze({
      ...baseResult,
      source_workspace_descriptor: {
        ref: request.source_workspace_descriptor.ref,
        head_commit: request.source_workspace_descriptor.head_commit,
        tree_id: request.source_workspace_descriptor.tree_id,
        inventory_digest: request.source_workspace_descriptor.inventory_digest,
        file_count: request.source_workspace_descriptor.file_count,
        byte_length: request.source_workspace_descriptor.byte_length,
        patches_digest: request.source_workspace_descriptor.patches_digest,
        patches: request.source_workspace_descriptor.patches.map((entry) => ({
          ref: entry.ref,
          sha256: entry.sha256,
          byte_length: entry.byte_length,
          accepted_base: entry.accepted_base,
          allowed_paths: [...entry.allowed_paths],
        })),
      },
    });
    assertEffectResultInScope(authority, request, result);
    return { kind: "applied", result };
  }
  if (request.kind === "git_promote") {
    const outcome = await executors.promote({
      authority,
      request,
      resolveEvidence: (claim) => dependencies.resolveHeadEvidence(authority.grant.id, claim),
      persistPrepared: (value) => persist(gitPostcondition(value)),
      assertEffectOpen: async () => {
        await currentEffectAuthority(
          dependencies,
          authority.grant.id,
          authority.grant.adapter_id,
          authority,
        );
        dependencies.assertOpen();
      },
      assertOpen: dependencies.assertOpen,
      ...(signal === undefined ? {} : { signal }),
    });
    const result: EffectResult = {
      schema_version: 1,
      kind: "git_promote",
      repository_id: request.repository_id,
      source_ref: request.source_ref,
      reviewed_head: request.reviewed_head,
      target_ref: request.target_ref,
      prior_target_oid: outcome.priorTargetOid,
      promoted_head: outcome.promotedHead,
    };
    assertEffectResultInScope(authority, request, result);
    return { kind: "applied", result };
  }
  await executors.verifyDeliverySource({
    authority,
    request,
    resolveEvidence: (claim) => dependencies.resolveHeadEvidence(authority.grant.id, claim),
  });
  const observed = await executors.deliver({
    authority,
    request,
    operationId,
    credentialFiles: dependencies.credentialFiles,
    persistPrepared: (value) => persist(remotePostcondition(value)),
    assertOpen: dependencies.assertOpen,
    ...(signal === undefined ? {} : { signal }),
  });
  return observed.kind === "unknown"
    ? { kind: "uncertain", diagnosticCode: observed.diagnosticCode }
    : observed;
}

/** Observe an admitted effect without replaying its write. */
export async function reconcileEffect(
  dependencies: EffectBrokerDependencies,
  executors: Required<NonNullable<EffectBrokerDependencies["executors"]>>,
  authority: PinnedEffectAuthority,
  request: EffectRequest,
  prepared: ControllerEffectPreparedRecord,
  append: (record: ControllerEffectRecord) => Promise<void>,
  signal?: AbortSignal,
): Promise<EffectObservation> {
  dependencies.assertOpen();
  signal?.throwIfAborted();
  if (request.kind === "local_program")
    return runLocalProgramEffect({
      dependencies,
      authority,
      request,
      operationId: prepared.operation_id,
      command: "inspect",
      append,
      ...(signal === undefined ? {} : { signal }),
    });
  if (request.kind !== "deliver_ref") {
    const observed = await executors.reconcileGit(authority, fromGitPostcondition(prepared));
    if (observed.kind === "uncertain") return observed;
    if (observed.kind === "not_applied")
      return { kind: "not_applied", observedOid: observed.observedHead };
    return { kind: "applied", result: resultFromPrepared(request, prepared) };
  }
  const observed = await executors.reconcileRemote({
    authority,
    request,
    operationId: prepared.operation_id,
    credentialFiles: dependencies.credentialFiles,
    assertOpen: dependencies.assertOpen,
    ...(signal === undefined ? {} : { signal }),
  });
  return observed.kind === "unknown"
    ? { kind: "uncertain", diagnosticCode: observed.diagnosticCode }
    : observed;
}
