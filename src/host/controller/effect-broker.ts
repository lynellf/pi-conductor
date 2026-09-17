/** Host-owned effect broker: authority, journal, lane, execution, and recovery — issue #116 B4. */
import {
  type ControllerEffectIntentRecord,
  type ControllerEffectPreparedRecord,
  type ControllerEffectRecord,
  controllerEffectOperationId,
  controllerLogicalEffectDigest,
  effectConflictLaneKeys,
  logicalRequestDigest,
} from "../../persistence/controller-effect-records.js";
import {
  getControllerEffect,
  reconstructControllerEffectTimeline,
} from "../../persistence/controller-effect-timeline.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import {
  type ControllerEffectBroker,
  type EffectBrokerDependencies,
  EffectBrokerPoisonedError,
  type ExecuteControllerEffectInput,
} from "./effect-broker-contract.js";
import { dispatchEffect, reconcileEffect } from "./effect-broker-execution.js";
import {
  currentEffectAuthority,
  effectLane,
  effectRecordIdentity,
  effectTimelineContext,
  inEffectLanes,
  resolveEffectRequest,
  settleEffect,
} from "./effect-broker-support.js";
import { assertEffectRequestInScope } from "./effect-registry.js";
import {
  assertDeliverySource,
  integrateGitEffect,
  promoteGitEffect,
  reconcileGitEffect,
} from "./git-effect.js";
import { executeRemoteEffect, reconcileRemoteEffect } from "./remote-effect.js";

export { EffectBrokerPoisonedError } from "./effect-broker-contract.js";

/** Create one broker whose lane locks serialize only conflicting effect resources. */
export function createControllerEffectBroker(
  dependencies: EffectBrokerDependencies,
): ControllerEffectBroker {
  let poisoned = false;
  const lanes = new Map<string, Promise<void>>();
  const now = dependencies.now ?? Date.now;
  const executors = {
    integrate: dependencies.executors?.integrate ?? integrateGitEffect,
    promote: dependencies.executors?.promote ?? promoteGitEffect,
    reconcileGit: dependencies.executors?.reconcileGit ?? reconcileGitEffect,
    deliver: dependencies.executors?.deliver ?? executeRemoteEffect,
    reconcileRemote: dependencies.executors?.reconcileRemote ?? reconcileRemoteEffect,
    verifyDeliverySource: dependencies.executors?.verifyDeliverySource ?? assertDeliverySource,
  };

  const append = async (record: ControllerEffectRecord): Promise<void> => {
    if (poisoned) throw new EffectBrokerPoisonedError();
    try {
      await dependencies.append(record);
    } catch {
      poisoned = true;
      throw new EffectBrokerPoisonedError();
    }
  };

  const execute = async (input: ExecuteControllerEffectInput): Promise<ControllerEffectRecord> => {
    if (poisoned) throw new EffectBrokerPoisonedError();
    dependencies.assertActionIntent(input.actionId, input.adapterId);
    const authority = await currentEffectAuthority(
      dependencies,
      input.effectId,
      input.adapterId,
      input.pinnedAuthority,
    );
    const request = await resolveEffectRequest(dependencies, input, authority);
    assertEffectRequestInScope(authority, request);
    const requestDigest = sha256Canonical(request);
    const operationId = controllerEffectOperationId({
      runId: dependencies.runId,
      definitionDigest: dependencies.definitionDigest,
      actionId: input.actionId,
      artifact: input.requestArtifact,
      authorityDigest: authority.authority_digest,
    });
    const logicalEffectDigest = controllerLogicalEffectDigest({
      definitionDigest: dependencies.definitionDigest,
      authorityDigest: authority.authority_digest,
      requestDigest: logicalRequestDigest(request),
    });
    const lane = effectLane(authority, request);
    const intent: ControllerEffectIntentRecord = {
      type: "controller_effect_intent",
      schema_version: 1,
      run_id: dependencies.runId,
      controller_id: dependencies.controllerId,
      definition_digest: dependencies.definitionDigest,
      activation_id: dependencies.activationId,
      owner_epoch: dependencies.ownerEpoch,
      action_id: input.actionId,
      adapter_id: input.adapterId,
      effect_id: input.effectId,
      operation_id: operationId,
      logical_effect_digest: logicalEffectDigest,
      authority_digest: authority.authority_digest,
      request_artifact: input.requestArtifact,
      request_digest: requestDigest,
      request,
      lane_resource: lane.resource,
      lane_key: lane.key,
      ts: now(),
    };
    return inEffectLanes(lanes, effectConflictLaneKeys(lane.resource), async () => {
      dependencies.assertOpen();
      const admittedAuthority = await currentEffectAuthority(
        dependencies,
        input.effectId,
        input.adapterId,
        input.pinnedAuthority,
      );
      const executionSignal = effectDeadlineSignal(
        admittedAuthority.grant.timeout_seconds,
        input.signal,
      );
      executionSignal.throwIfAborted();
      reconstructControllerEffectTimeline(
        [...dependencies.records(), intent],
        effectTimelineContext(dependencies),
      );
      executionSignal.throwIfAborted();
      await append(intent);
      let prepared: ControllerEffectPreparedRecord | null = null;
      const persistPrepared = async (
        postcondition: ControllerEffectPreparedRecord["postcondition"],
      ) => {
        await currentEffectAuthority(
          dependencies,
          input.effectId,
          input.adapterId,
          input.pinnedAuthority,
        );
        dependencies.assertOpen();
        const record: ControllerEffectPreparedRecord = {
          ...effectRecordIdentity(intent, now()),
          type: "controller_effect_prepared",
          schema_version: 1,
          intent_digest: sha256Canonical(intent),
          postcondition,
        };
        await append(record);
        prepared = record;
      };
      try {
        const refreshed = await currentEffectAuthority(
          dependencies,
          input.effectId,
          input.adapterId,
          input.pinnedAuthority,
        );
        const result = await dispatchEffect(
          dependencies,
          executors,
          refreshed,
          request,
          operationId,
          persistPrepared,
          append,
          executionSignal,
        );
        return await settleEffect(append, intent, prepared, result, now(), null);
      } catch {
        if (poisoned) throw new EffectBrokerPoisonedError();
        return await settleEffect(
          append,
          intent,
          prepared,
          prepared === null
            ? { kind: "not_applied" as const, observedOid: null }
            : { kind: "uncertain" as const, diagnosticCode: "execution_after_prepared_failed" },
          now(),
          null,
        );
      }
    });
  };

  const reconcile = async (
    operationId: string,
    signal?: AbortSignal,
  ): Promise<ControllerEffectRecord> => {
    if (poisoned) throw new EffectBrokerPoisonedError();
    const state = getControllerEffect(
      reconstructControllerEffectTimeline(
        dependencies.records(),
        effectTimelineContext(dependencies),
      ),
      operationId,
    );
    if (state === null) throw new Error("effect operation is not journaled");
    if (state.settled !== null && state.settled.outcome !== "uncertain") return state.settled;
    return inEffectLanes(lanes, effectConflictLaneKeys(state.intent.lane_resource), async () => {
      const refreshed = getControllerEffect(
        reconstructControllerEffectTimeline(
          dependencies.records(),
          effectTimelineContext(dependencies),
        ),
        operationId,
      );
      if (refreshed === null) throw new Error("effect operation disappeared during reconciliation");
      if (refreshed.settled !== null && refreshed.settled.outcome !== "uncertain")
        return refreshed.settled;
      const pinned = dependencies.pinnedAuthority(refreshed.intent.effect_id);
      if (pinned.authority_digest !== refreshed.intent.authority_digest)
        throw new Error("effect journal authority differs from pinned definition");
      const authority = await currentEffectAuthority(
        dependencies,
        refreshed.intent.effect_id,
        refreshed.intent.adapter_id,
        pinned,
      );
      const prepared = refreshed.prepared;
      const result =
        prepared === null
          ? { kind: "not_applied" as const, observedOid: null }
          : await reconcileEffect(
              dependencies,
              executors,
              authority,
              refreshed.intent.request,
              prepared,
              append,
              effectDeadlineSignal(authority.grant.timeout_seconds, signal),
            );
      return settleEffect(
        append,
        refreshed.intent,
        prepared,
        result,
        now(),
        {
          prior_intent_digest: sha256Canonical(refreshed.intent),
          prior_prepared_digest: prepared === null ? null : sha256Canonical(prepared),
        },
        { activationId: dependencies.activationId, ownerEpoch: dependencies.ownerEpoch },
      );
    });
  };

  return Object.freeze({ execute, reconcile });
}

function effectDeadlineSignal(timeoutSeconds: number, parent?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutSeconds * 1000);
  return parent === undefined ? deadline : AbortSignal.any([parent, deadline]);
}
