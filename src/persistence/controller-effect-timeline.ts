/** Pure chronology and recovery projection for the controller effect journal — issue #116 B4. */
import type { EffectRequest } from "../manifest/controller-effect.js";
import {
  assertControllerEffectRecord,
  type ControllerEffectIntentRecord,
  type ControllerEffectPreparedRecord,
  type ControllerEffectRecord,
  ControllerEffectRecordError,
  type ControllerEffectSettledRecord,
  isControllerEffectRecord,
} from "./controller-effect-records.js";
import { sha256Canonical } from "./trajectory-records.js";

export interface ControllerEffectState {
  readonly intent: ControllerEffectIntentRecord;
  readonly prepared: ControllerEffectPreparedRecord | null;
  readonly settled: ControllerEffectSettledRecord | null;
}
export interface ControllerEffectTimeline {
  readonly effects: readonly ControllerEffectState[];
  readonly unresolved: readonly ControllerEffectState[];
}
export interface ControllerEffectTimelineContext {
  readonly runId: string;
  readonly controllerId: string;
  readonly definitionDigest: string;
  readonly isKnownOwner: (activationId: string, ownerEpoch: number) => boolean;
  readonly hasAdapterActionIntent: (actionId: string, adapterId: string) => boolean;
}

/** Reconstruct the closed journal and reject conflicting or incomplete chronology. */
export function reconstructControllerEffectTimeline(
  records: readonly unknown[],
  context?: ControllerEffectTimelineContext,
): ControllerEffectTimeline {
  const effects = new Map<string, MutableEffect>();
  const logical = new Map<string, MutableEffect>();
  const lanes = new Map<string, MutableEffect>();
  for (const candidate of records) {
    if (!isControllerEffectRecord(candidate)) continue;
    assertControllerEffectRecord(candidate);
    if (context !== undefined) assertControllerContext(candidate, context);
    if (candidate.type === "controller_effect_intent") {
      if (effects.has(candidate.operation_id)) throw invalid("duplicate effect operation identity");
      const prior = logical.get(candidate.logical_effect_digest);
      if (prior !== undefined && prior.settled?.outcome !== "not_applied")
        throw invalid("logical effect is already pending, applied, or uncertain");
      const lane = lanes.get(candidate.lane_key);
      if (lane !== undefined && (lane.settled === null || lane.settled.outcome === "uncertain"))
        throw invalid("effect lane has an unresolved operation");
      const state = { intent: candidate, prepared: null, settled: null };
      effects.set(candidate.operation_id, state);
      logical.set(candidate.logical_effect_digest, state);
      lanes.set(candidate.lane_key, state);
      continue;
    }
    const state = effects.get(candidate.operation_id);
    if (state === undefined) throw invalid("effect record precedes durable intent");
    assertIdentity(candidate, state.intent);
    const intentDigest = sha256Canonical(state.intent);
    if (candidate.intent_digest !== intentDigest)
      throw invalid("effect record intent digest mismatch");
    if (candidate.type === "controller_effect_prepared") {
      if (state.prepared !== null || state.settled !== null)
        throw invalid("duplicate or late effect preparation");
      assertPostcondition(candidate, state.intent.request);
      state.prepared = candidate;
      continue;
    }
    if (state.prepared === null && candidate.outcome !== "not_applied")
      throw invalid("effect settlement precedes prepared postcondition");
    if (
      state.settled !== null &&
      !(state.settled.outcome === "uncertain" && candidate.recovery !== null)
    )
      throw invalid("duplicate effect settlement");
    const preparedDigest = state.prepared === null ? null : sha256Canonical(state.prepared);
    if (candidate.prepared_digest !== preparedDigest)
      throw invalid("effect settlement prepared digest mismatch");
    if (candidate.recovery !== null) {
      if (
        candidate.recovery.prior_intent_digest !== intentDigest ||
        candidate.recovery.prior_prepared_digest !== preparedDigest
      )
        throw invalid("effect recovery does not link its prior records");
    }
    if (candidate.outcome === "applied") {
      if (state.prepared === null) throw invalid("applied effect has no preparation");
      assertResult(candidate, state.intent.request, state.prepared);
    }
    state.settled = candidate;
  }
  const frozen = Object.freeze([...effects.values()].map(freezeState));
  return Object.freeze({
    effects: frozen,
    unresolved: Object.freeze(
      frozen.filter((state) => state.settled === null || state.settled.outcome === "uncertain"),
    ),
  });
}

function assertControllerContext(
  record: ControllerEffectRecord,
  context: ControllerEffectTimelineContext,
): void {
  if (
    record.run_id !== context.runId ||
    record.controller_id !== context.controllerId ||
    record.definition_digest !== context.definitionDigest ||
    !context.isKnownOwner(record.activation_id, record.owner_epoch)
  )
    throw invalid("effect record does not belong to the current controller owner");
  if (!context.hasAdapterActionIntent(record.action_id, record.adapter_id))
    throw invalid("effect record has no matching durable adapter action intent");
}

/** Find one stable effect operation without inferring execution from intent alone. */
export function getControllerEffect(
  timeline: ControllerEffectTimeline,
  operationId: string,
): ControllerEffectState | null {
  return timeline.effects.find((state) => state.intent.operation_id === operationId) ?? null;
}

interface MutableEffect {
  readonly intent: ControllerEffectIntentRecord;
  prepared: ControllerEffectPreparedRecord | null;
  settled: ControllerEffectSettledRecord | null;
}

function assertIdentity(
  record: Exclude<ControllerEffectRecord, ControllerEffectIntentRecord>,
  intent: ControllerEffectIntentRecord,
): void {
  for (const key of [
    "run_id",
    "controller_id",
    "definition_digest",
    "action_id",
    "adapter_id",
    "effect_id",
    "operation_id",
    "logical_effect_digest",
    "authority_digest",
  ] as const)
    if (record[key] !== intent[key]) throw invalid("effect record identity changed");
  if (
    (record.type === "controller_effect_prepared" || record.recovery === null) &&
    (record.activation_id !== intent.activation_id || record.owner_epoch !== intent.owner_epoch)
  )
    throw invalid("non-recovery effect record changed owner");
}

function assertPostcondition(record: ControllerEffectPreparedRecord, request: EffectRequest): void {
  const post = record.postcondition;
  if (post.kind !== request.kind) throw invalid("prepared effect kind differs from request");
  if (request.kind === "git_integrate" && post.kind === "git_integrate") {
    if (
      post.source_head !== request.accepted_base ||
      post.target_ref !== request.integration_ref ||
      post.expected_prior !== request.expected_ref_oid ||
      post.source_artifact === null
    )
      throw invalid("prepared integration postcondition differs from request");
  } else if (request.kind === "git_promote" && post.kind === "git_promote") {
    if (
      post.source_head !== request.reviewed_head ||
      post.target_ref !== request.target_ref ||
      post.expected_prior !== request.expected_target_oid ||
      post.applied_head !== request.reviewed_head ||
      post.source_artifact !== null
    )
      throw invalid("prepared promotion postcondition differs from request");
  } else if (request.kind === "deliver_ref" && post.kind === "deliver_ref") {
    if (
      post.remote_id !== request.remote_id ||
      post.target_ref !== request.target_ref ||
      post.reviewed_head !== request.reviewed_head ||
      post.expected_prior !== request.expected_remote_oid ||
      post.idempotency_key !== request.idempotency_key
    )
      throw invalid("prepared delivery postcondition differs from request");
  }
}

function assertResult(
  record: ControllerEffectSettledRecord,
  request: EffectRequest,
  prepared: ControllerEffectPreparedRecord,
): void {
  const result = record.result;
  if (
    result === undefined ||
    result.kind !== request.kind ||
    result.repository_id !== request.repository_id
  )
    throw invalid("applied effect result differs from request");
  if (request.kind === "git_integrate" && result.kind === "git_integrate") {
    if (
      result.accepted_base !== request.accepted_base ||
      result.integration_ref !== request.integration_ref ||
      result.prior_ref_oid !== request.expected_ref_oid ||
      prepared.postcondition.kind !== "git_integrate" ||
      result.integrated_head !== prepared.postcondition.applied_head ||
      prepared.postcondition.source_artifact === null ||
      result.source_artifact_ref !== prepared.postcondition.source_artifact.ref ||
      result.source_artifact_sha256 !== prepared.postcondition.source_artifact.sha256
    )
      throw invalid("integration result differs from request");
  } else if (request.kind === "git_promote" && result.kind === "git_promote") {
    if (
      result.reviewed_head !== request.reviewed_head ||
      result.source_ref !== request.source_ref ||
      result.promoted_head !== request.reviewed_head ||
      result.target_ref !== request.target_ref ||
      result.prior_target_oid !== request.expected_target_oid
    )
      throw invalid("promotion result differs from request");
  } else if (request.kind === "deliver_ref" && result.kind === "deliver_ref") {
    if (
      result.remote_id !== request.remote_id ||
      result.reviewed_head !== request.reviewed_head ||
      result.remote_object_oid !== request.reviewed_head ||
      result.target_ref !== request.target_ref ||
      result.prior_remote_oid !== request.expected_remote_oid ||
      result.idempotency_key !== request.idempotency_key
    )
      throw invalid("delivery result differs from request");
  }
}

function freezeState(state: MutableEffect): ControllerEffectState {
  return Object.freeze({ intent: state.intent, prepared: state.prepared, settled: state.settled });
}
function invalid(message: string): ControllerEffectRecordError {
  return new ControllerEffectRecordError(message);
}
