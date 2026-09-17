// Kept together (~400 LOC): production assembly and its receipt publication share one authority context.
/** Production assembly for operator-approved controller effects — issue #116. */

import type { ControllerAction } from "../../manifest/controller-protocol.js";
import type { ControllerEffectRecord } from "../../persistence/controller-effect-records.js";
import {
  getControllerAction,
  reconstructControllerTimeline,
} from "../../persistence/controller-timeline.js";
import type { ControllerActivationStartedRecord, PersistedRecord } from "../../persistence/log.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import type { ApprovedControllerDefinition } from "./approved-definition.js";
import type { ArtifactStore } from "./artifact-store.js";
import {
  effectPatchAudience,
  effectRequestArtifact,
  intersectEffectConsumers,
  publishEffectResult,
  publishEffectSource,
  resolveEffectEvidence,
  resolveEffectPatch,
} from "./effect-artifacts.js";
import { createControllerEffectBroker } from "./effect-broker.js";
import type { ControllerAdapterInvocationResult } from "./executable-host-contract.js";
import type { VerifiedHeadEvidence } from "./git-effect.js";
import type { ControllerHostApproval } from "./host-approval.js";
import type { ResolvedControllerOutput } from "./output-resolver.js";
import { localEffectResultConsumers } from "./production-effect-audience.js";
import {
  measureProductionEffectImplementations,
  verifyProductionEffectImplementations,
} from "./production-effect-inventory.js";
import {
  assertCredentialSources,
  durableEffectIntent,
  effectContext,
  pinnedEffectForAdapter,
  pinnedEffects,
  resultConsumers,
  sourceConsumers,
} from "./production-effect-support.js";
import { controllerRecoveryReceipt } from "./recovery-contract.js";

export class ControllerEffectPendingError extends Error {
  constructor(readonly operationId: string) {
    super("controller effect outcome requires reconciliation");
    this.name = "ControllerEffectPendingError";
  }
}

/** Stable pre-intent rejection that never exposes protected paths or artifact bytes. */
export class ControllerEffectRejectedError extends Error {
  constructor() {
    super("controller effect request rejected");
    this.name = "ControllerEffectRejectedError";
  }
}

export interface ProductionEffectOutcome {
  readonly outcome: "completed" | "failed";
  readonly operation_id: string;
  readonly result_refs: string[];
  readonly diagnostic: string | null;
}

export interface ProductionEffectsOptions {
  readonly definition: ApprovedControllerDefinition;
  readonly activation: ControllerActivationStartedRecord;
  readonly artifacts: ArtifactStore;
  readonly outputResolver: {
    readonly resolveRef: (
      ref: string,
      principal: import("../../manifest/controller-output.js").ControllerOutputPrincipal,
    ) => Promise<ResolvedControllerOutput>;
  };
  readonly records: () => readonly PersistedRecord[];
  readonly persist: (record: ControllerEffectRecord) => void | Promise<void>;
  readonly loadApproval: () => Promise<ControllerHostApproval>;
  readonly runStateDir: string;
  readonly assertOpen: () => void;
  readonly credentialFiles: Readonly<Record<string, string>>;
}

/** Skip inventory and broker assembly entirely when the pinned controller has no effects. */
export async function createConfiguredProductionEffects(
  options: Omit<ProductionEffectsOptions, "credentialFiles"> & {
    readonly approval: ControllerHostApproval;
  },
) {
  if (!options.definition.config.adapters.some((adapter) => adapter.effect_id !== undefined))
    return undefined;
  return createProductionEffects({
    ...options,
    credentialFiles: Object.fromEntries(
      (options.approval.credential_sources ?? []).map((entry) => [entry.id, entry.path]),
    ),
  });
}

/** Assemble one activation-scoped broker using only pinned and refreshed operator authority. */
export async function createProductionEffects(options: ProductionEffectsOptions) {
  const authorities = pinnedEffects(options.definition.record.pinned_definition) ?? [];
  let measured: Awaited<ReturnType<typeof measureProductionEffectImplementations>>;
  try {
    measured = await measureProductionEffectImplementations(authorities);
  } catch {
    throw new ControllerEffectRejectedError();
  }
  const definition = options.definition.record;
  const pinned = new Map(
    (pinnedEffects(definition.pinned_definition) ?? []).map((entry) => [entry.grant.id, entry]),
  );
  const allowedProfiles = new Map(
    (options.definition.config.child_outputs ?? [])
      .filter((policy) => policy.patch !== undefined)
      .map((policy) => [policy.profile_id, policy.patch?.paths ?? []] as const),
  );
  const adapterSchemas = new Map(
    options.definition.config.adapters.map((adapter) => {
      const schema = options.definition.approval.schemas.find(
        (entry) => entry.schema_id === adapter.output_schema_id,
      );
      if (schema === undefined) throw new Error("adapter evidence schema is not approved");
      return [adapter.id, { id: schema.schema_id, digest: schema.schema_digest }] as const;
    }),
  );

  const resolveEvidence = async (
    effectId: string,
    claim: {
      readonly artifact_ref: string;
      readonly sha256: string;
      readonly producer_id: string;
      readonly schema_id: string;
      readonly subject_head: string;
    },
  ): Promise<VerifiedHeadEvidence> => {
    return resolveEffectEvidence({
      claim,
      effectId,
      runId: definition.run_id,
      definitionDigest: definition.definition_digest,
      records: options.records(),
      artifacts: options.artifacts,
      resolveRef: options.outputResolver.resolveRef,
      adapterSchemas,
    });
  };

  const broker = createControllerEffectBroker({
    runId: definition.run_id,
    controllerId: definition.controller_id,
    definitionDigest: definition.definition_digest,
    activationId: options.activation.activation_id,
    ownerEpoch: options.activation.owner_epoch,
    records: options.records,
    append: options.persist,
    assertActionIntent: (actionId, adapterId) => {
      const action = getControllerAction(
        reconstructControllerTimeline(options.records()),
        actionId,
      );
      if (
        action?.intent.request.kind !== "adapter" ||
        action.intent.request.adapter_id !== adapterId
      )
        throw new Error("effect action has no durable adapter intent");
    },
    isKnownOwner: (activationId, ownerEpoch) =>
      options
        .records()
        .some(
          (record) =>
            record.type === "controller_activation_started" &&
            record.activation_id === activationId &&
            record.owner_epoch === ownerEpoch,
        ),
    resolveRequestArtifact: async (artifact) => {
      const value = await options.outputResolver.resolveRef(artifact.ref, {
        kind: "effect",
        effect_id: pinnedEffectForAdapter(pinned, artifact.producer.adapter_id),
      });
      if (value.sha256 !== artifact.sha256 || value.byteLength !== artifact.byte_length)
        throw new Error("effect request artifact metadata mismatch");
      return { artifact, bytes: value.bytes };
    },
    currentEffectGrants: async () => {
      const approval = await options.loadApproval();
      assertCredentialSources(pinned, approval, options.credentialFiles);
      return approval.effects ?? [];
    },
    pinnedAuthority: (effectId) => {
      const authority = pinned.get(effectId);
      if (authority === undefined) throw new Error("effect authority is not pinned");
      return authority;
    },
    currentSupportedImplementations: () =>
      verifyProductionEffectImplementations(authorities, measured),
    resolvePatch: async (effectId, claim) =>
      resolveEffectPatch({
        claim,
        effectId,
        records: options.records(),
        resolveRef: options.outputResolver.resolveRef,
        allowedProfiles,
        resolveEvidence: (entry) =>
          resolveEffectEvidence({
            claim: entry,
            effectId,
            runId: definition.run_id,
            definitionDigest: definition.definition_digest,
            records: options.records(),
            artifacts: options.artifacts,
            resolveRef: options.outputResolver.resolveRef,
            adapterSchemas,
          }),
      }),
    resolveHeadEvidence: resolveEvidence,
    resolveEvidenceBytes: async (effectId, claim) =>
      (
        await options.outputResolver.resolveRef(claim.artifact_ref, {
          kind: "effect",
          effect_id: effectId,
        })
      ).bytes,
    publishIntegratedSource: async (effectId, operationId, selected) => {
      const action = durableEffectIntent(options.records(), operationId);
      if (action.request.kind !== "git_integrate")
        throw new Error("selected source publication is not an integration effect");
      const requested = sourceConsumers(options.definition, action.adapter_id);
      const consumers = intersectEffectConsumers(
        requested,
        action.request.patches.map((patch) =>
          effectPatchAudience(options.records(), patch.artifact_ref),
        ),
      );
      return publishEffectSource({
        ...effectContext(options.definition, action.action_id, action.adapter_id, effectId),
        operationId,
        requestDigest: action.request_digest,
        artifacts: options.artifacts,
        assertOpen: options.assertOpen,
        selected,
        consumers,
      });
    },
    workspaceRoot: options.runStateDir,
    credentialFiles: options.credentialFiles,
    assertOpen: options.assertOpen,
  });

  return Object.freeze({
    async runAdapterEffect(
      action: Extract<ControllerAction, { readonly kind: "adapter" }>,
      invocation: ControllerAdapterInvocationResult,
      signal?: AbortSignal,
    ): Promise<ProductionEffectOutcome> {
      const adapter = options.definition.config.adapters.find(
        (entry) => entry.id === action.adapter_id,
      );
      if (adapter?.effect_id === undefined) throw new Error("adapter has no pinned effect");
      const authority = pinned.get(adapter.effect_id);
      if (authority === undefined) throw new Error("adapter effect authority is not pinned");
      let requestArtifact: ReturnType<typeof effectRequestArtifact>;
      try {
        await verifyProductionEffectImplementations(authorities, measured);
        requestArtifact = effectRequestArtifact(
          effectContext(options.definition, action.action_id, action.adapter_id, adapter.effect_id),
          invocation,
          { id: authority.grant.request_schema_id, digest: authority.grant.request_schema_digest },
        );
      } catch {
        throw new ControllerEffectRejectedError();
      }
      const settled = await broker.execute({
        actionId: action.action_id,
        adapterId: action.adapter_id,
        effectId: adapter.effect_id,
        requestArtifact,
        pinnedAuthority: authority,
        ...(signal === undefined ? {} : { signal }),
      });
      if (settled.type !== "controller_effect_settled")
        throw new Error("effect broker did not settle execution");
      return publishSettlement(options, settled);
    },
    async reconcilePending(): Promise<readonly ProductionEffectOutcome[]> {
      const latest = new Map<
        string,
        Extract<ControllerEffectRecord, { type: "controller_effect_settled" }>
      >();
      for (const record of options.records())
        if (record.type === "controller_effect_settled") latest.set(record.operation_id, record);
      const uncertain = [...latest.values()].filter((record) => record.outcome === "uncertain");
      const results: ProductionEffectOutcome[] = [];
      for (const record of uncertain) {
        const settled = await broker.reconcile(record.operation_id);
        if (settled.type !== "controller_effect_settled")
          throw new Error("effect reconciliation did not settle");
        results.push(await publishSettlement(options, settled));
      }
      return Object.freeze(results);
    },
    async recoverEffectAction(
      action: import("../../persistence/controller-timeline.js").ControllerActionState,
      requestArtifact: import("./artifact-store.js").PublishedArtifact,
    ) {
      const intents = options
        .records()
        .filter(
          (
            record,
          ): record is Extract<ControllerEffectRecord, { type: "controller_effect_intent" }> =>
            record.type === "controller_effect_intent" && record.action_id === action.actionId,
        );
      if (intents.length === 0)
        return Object.freeze({
          receipts: Object.freeze([
            controllerRecoveryReceipt(action, "interrupted", [], "effect intent was not durable"),
          ]),
          blocked: Object.freeze([]),
        });
      if (intents.length !== 1) throw new Error("effect action has multiple durable intents");
      const intent = intents[0];
      if (
        intent === undefined ||
        intent.request_artifact.ref !== requestArtifact.ref ||
        intent.request_artifact.sha256 !== requestArtifact.sha256 ||
        sha256Canonical(intent.request_artifact.producer) !==
          sha256Canonical({
            adapter_id: intent.adapter_id,
            action_id: action.actionId,
            operation_id:
              requestArtifact.binding.producer.kind === "operation"
                ? requestArtifact.binding.producer.operationId
                : "",
          })
      )
        throw new Error("effect recovery request artifact does not match its durable intent");
      const settled = await broker.reconcile(intent.operation_id);
      if (settled.type !== "controller_effect_settled")
        throw new Error("effect recovery did not produce a settlement");
      if (settled.outcome === "uncertain")
        return Object.freeze({
          receipts: Object.freeze([]),
          blocked: Object.freeze([
            `effect action ${action.actionId} remains uncertain after read-only reconciliation`,
          ]),
        });
      const outcome = await publishSettlement(options, settled);
      return Object.freeze({
        receipts: Object.freeze([
          controllerRecoveryReceipt(
            action,
            outcome.outcome === "completed" ? "completed" : "failed",
            outcome.result_refs,
            outcome.diagnostic,
            outcome.operation_id,
          ),
        ]),
        blocked: Object.freeze([]),
      });
    },
  });
}

async function publishSettlement(
  options: ProductionEffectsOptions,
  record: Extract<ControllerEffectRecord, { type: "controller_effect_settled" }>,
): Promise<ProductionEffectOutcome> {
  if (record.outcome === "uncertain") throw new ControllerEffectPendingError(record.operation_id);
  if (record.outcome === "not_applied")
    return Object.freeze({
      operation_id: record.operation_id,
      outcome: "failed",
      result_refs: [],
      diagnostic: "effect-not-applied",
    });
  if (record.result === undefined) throw new Error("applied effect has no result");
  const intent = durableEffectIntent(options.records(), record.operation_id);
  const authority = pinnedEffects(options.definition.record.pinned_definition)?.find(
    (entry) => entry.grant.id === record.effect_id,
  );
  if (authority === undefined) throw new Error("effect result authority is not pinned");
  const artifact = await publishEffectResult({
    ...effectContext(options.definition, record.action_id, record.adapter_id, record.effect_id),
    operationId: record.operation_id,
    requestDigest: intent.request_digest,
    artifacts: options.artifacts,
    assertOpen: options.assertOpen,
    result: record.result,
    outputSchema: {
      id: authority.grant.output_schema_id,
      digest: authority.grant.output_schema_digest,
    },
    consumers:
      intent.request.kind === "local_program"
        ? await localEffectResultConsumers(options, intent)
        : resultConsumers(options.definition, record.adapter_id),
  });
  return Object.freeze({
    operation_id: record.operation_id,
    outcome: "completed",
    result_refs: [artifact.ref],
    diagnostic: null,
  });
}
