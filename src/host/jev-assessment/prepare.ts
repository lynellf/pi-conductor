/**
 * Host-owned Jev advisory assessment preparation — issue #139 Jev
 * comment (replay-or-attempt orchestration).
 *
 * `prepareJevAssessment` persists exactly one terminal record before
 * the recipient prompt (or reuses the matching terminal without a new
 * Jev call), and returns null when no assessment should run. Pure
 * advisory rendering and the inspection heuristic live in
 * `advisory.ts`; nothing here branches routing on judgments.
 */

import { Value } from "typebox/value";
import type { JevAssessmentPolicy } from "../../manifest/types.js";
import { redactOutboundText } from "../../persistence/context-enrichment-v2.js";
import {
  assertJevAssessmentFresh,
  assertJevAssessmentRecord,
  findJevAssessmentConflicts,
  findJevAssessmentReplay,
  type JevAssessmentJudgments,
  type JevAssessmentRecord,
  JevAssessmentStaleError,
  sha256HexString,
} from "../../persistence/jev-assessment-record.js";
import type { PersistedRecord, RecordLog } from "../../persistence/log.js";
import type { PhaseWorkPacketRecord } from "../../persistence/phase-work-packet.js";
import {
  type JevAssessmentOutcome,
  type JevAssessmentWireJudgments,
  jevActionableAnswerSchema,
  jevConsistencyAnswerSchema,
  jevNextActionAnswerSchema,
  jevRelevanceAnswerSchema,
} from "../../seam/jev-assessment.js";
import type { AssessmentEnricher, JevAssessmentState } from "./contracts.js";
import { createTypesafeAssessmentEnricher } from "./typesafe-assessment-client.js";

/* ─── Replay-or-attempt orchestration (Phase C) ─────────────────────── */

/** Bounded state sizes: redacted text caps and entry caps. */
const MAX_STATE_TEXT_CHARS = 1000;
const MAX_STATE_COMMANDS = 8;
const MAX_STATE_VERIFICATION = 16;

/** Inputs for `prepareJevAssessment`. */
export interface PrepareJevAssessmentArgs {
  readonly log: RecordLog;
  readonly runId: string;
  readonly packet: PhaseWorkPacketRecord;
  readonly policy?: JevAssessmentPolicy | undefined;
  readonly enricher?: AssessmentEnricher;
  readonly apiKey?: string | null;
  readonly now?: () => number;
}

function boundText(value: string | null): string | null {
  if (value === null) return null;
  const redacted = redactOutboundText(value);
  return redacted.length > MAX_STATE_TEXT_CHARS
    ? redacted.slice(0, MAX_STATE_TEXT_CHARS)
    : redacted;
}

/** Build the bounded redacted Jev state from durable packet contents. */
export function buildJevAssessmentState(packet: PhaseWorkPacketRecord): JevAssessmentState {
  const process = packet.phase_process;
  const observed = packet.host_observed;
  const reported = packet.reported_narrative;
  const label =
    process.state.kind === "fsm_visit"
      ? process.state.role
      : `${process.state.phase_id}/${process.state.gate_id}`;
  const gateState =
    process.gate_state === null
      ? "none"
      : process.gate_state.kind === "incomplete"
        ? `incomplete:${process.gate_state.reason}`
        : process.gate_state.kind;
  const worktree =
    observed.worktree.kind === "snapshot"
      ? `snapshot:${observed.worktree.head.slice(0, 64)}:${String(observed.worktree.dirty_paths.length)} dirty paths`
      : observed.worktree.kind === "unavailable"
        ? `unavailable:${observed.worktree.reason}`
        : "not_configured";
  return {
    phase: {
      kind: process.state.kind,
      label,
      gate_state: gateState,
      legal_action: process.legal_action.kind,
      host_directive: process.host_directive,
    },
    observed: {
      worktree,
      commands: observed.commands.slice(0, MAX_STATE_COMMANDS).map((entry) => ({
        id: entry.source_key,
        outcome: entry.outcome,
      })),
      verification: observed.verification.slice(0, MAX_STATE_VERIFICATION).map((entry) => ({
        name: entry.name,
        outcome: entry.outcome,
      })),
    },
    reported: {
      objective: boundText(reported.objective),
      action: boundText(reported.action),
      summary: boundText(reported.summary),
      reason: boundText(reported.reason) ?? "",
    },
  };
}

/** Deterministic fingerprint over the exact Jev inputs. */
export function computeJevAssessmentInputFingerprint(args: {
  readonly model: string;
  readonly request_timeout_ms: number;
  readonly max_attempts: number;
  readonly state: JevAssessmentState;
}): string {
  return sha256HexString(
    JSON.stringify({
      model: args.model,
      request_timeout_ms: args.request_timeout_ms,
      max_attempts: args.max_attempts,
      state: args.state,
    }),
  );
}

/** Strip wire envelopes to the durable judgments shape. */
function toPersistedJudgments(wire: JevAssessmentWireJudgments): JevAssessmentJudgments {
  return {
    relevance: {
      choice: wire.relevance.choice,
      confidence: wire.relevance.confidence,
      probabilities: { ...wire.relevance.probabilities },
    },
    consistency: {
      choice: wire.consistency.choice,
      confidence: wire.consistency.confidence,
      probabilities: { ...wire.consistency.probabilities },
    },
    actionable: { noul: wire.actionable.noul },
    next_action: {
      choice: wire.next_action.choice,
      confidence: wire.next_action.confidence,
      probabilities: { ...wire.next_action.probabilities },
    },
  };
}

function probabilitySum(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

function isDistribution(probabilities: Readonly<Record<string, number>>): boolean {
  const values = Object.values(probabilities);
  return (
    values.every((value) => typeof value === "number" && Number.isFinite(value)) &&
    Math.abs(probabilitySum(values) - 1) <= 1e-6
  );
}

/**
 * Validate a custom enricher's completed outcome before persistence.
 * The HTTP adapter validates wire bytes itself; this guards the
 * in-process seam against misbehaving custom enrichers. Returns the
 * failure code for an invalid outcome, or null when valid.
 */
function validateCompletedOutcome(
  outcome: Extract<JevAssessmentOutcome, { kind: "completed" }>,
  maxAttempts: number,
): "response_invalid" | null {
  const attempts = outcome.attempts ?? 1;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > maxAttempts) {
    return "response_invalid";
  }
  if (
    typeof outcome.actual_model !== "string" ||
    outcome.actual_model.length === 0 ||
    outcome.actual_model.length > 128
  ) {
    return "response_invalid";
  }
  const usage = outcome.usage;
  if (
    typeof usage !== "object" ||
    usage === null ||
    !Number.isInteger(usage.input_tokens) ||
    !Number.isInteger(usage.output_tokens) ||
    usage.input_tokens < 0 ||
    usage.output_tokens < 0
  ) {
    return "response_invalid";
  }
  const judgments = outcome.judgments;
  if (
    typeof judgments !== "object" ||
    judgments === null ||
    !Value.Check(jevRelevanceAnswerSchema, judgments.relevance) ||
    !Value.Check(jevConsistencyAnswerSchema, judgments.consistency) ||
    !Value.Check(jevActionableAnswerSchema, judgments.actionable) ||
    !Value.Check(jevNextActionAnswerSchema, judgments.next_action)
  ) {
    return "response_invalid";
  }
  if (
    !isDistribution(judgments.relevance.probabilities) ||
    !isDistribution(judgments.consistency.probabilities) ||
    !isDistribution(judgments.next_action.probabilities)
  ) {
    return "response_invalid";
  }
  return null;
}

/**
 * Prepare or replay one terminal assessment before prompting. Returns
 * the persisted terminal record, or null when no assessment should run
 * (policy absent or no reported reason — legacy seed unchanged).
 *
 * The function never throws on provider failures; every rejection
 * becomes one `unavailable` terminal. Stale same-visit terminals
 * throw `JevAssessmentStaleError` (fail closed).
 */
export async function prepareJevAssessment(
  args: PrepareJevAssessmentArgs,
): Promise<JevAssessmentRecord | null> {
  const reason = args.packet.reported_narrative.reason;
  if (args.policy === undefined || reason === null || reason.length === 0) return null;
  const policy = args.policy;
  const packetSha = sha256HexString(args.packet.rendered);
  const reasonSha = sha256HexString(reason);
  const state = buildJevAssessmentState(args.packet);
  const inputSha = computeJevAssessmentInputFingerprint({
    model: policy.model,
    request_timeout_ms: policy.request_timeout_ms,
    max_attempts: policy.max_attempts,
    state,
  });
  const records = args.log.records(args.runId);
  const identity = {
    run_id: args.runId,
    recipient_role: args.packet.recipient_role,
    recipient_visit_index: args.packet.recipient_visit_index,
    packet_sha256: packetSha,
    reason_sha256: reasonSha,
  };
  const replay = findJevAssessmentReplay(records, identity);
  if (replay !== null) {
    if (replay.input_sha256 !== inputSha) {
      throw new JevAssessmentStaleError(
        "jev_assessment input shape changed since the terminal was persisted; refusing reuse",
      );
    }
    assertJevAssessmentFresh(replay, { packet_sha256: packetSha, reason_sha256: reasonSha });
    return replay;
  }
  if (findJevAssessmentConflicts(records, identity).length > 0) {
    throw new JevAssessmentStaleError(
      "jev_assessment inputs changed since a terminal was persisted; refusing reuse",
    );
  }
  const enricher =
    args.enricher ??
    createTypesafeAssessmentEnricher({
      apiKey: args.apiKey ?? null,
      requestTimeoutMs: policy.request_timeout_ms,
      maxAttempts: policy.max_attempts,
    });
  const ts = (args.now ?? Date.now)();
  let outcome: JevAssessmentOutcome;
  try {
    outcome = await enricher.assess({
      identity: {
        run_id: args.runId,
        recipient_role: args.packet.recipient_role,
        recipient_visit: args.packet.recipient_visit_index,
        packet_sha256: packetSha,
        reason_sha256: reasonSha,
        input_sha256: inputSha,
      },
      state,
      policy: {
        provider: "typesafe_jev",
        model: policy.model,
        request_timeout_ms: policy.request_timeout_ms,
        max_attempts: policy.max_attempts,
      },
    });
  } catch {
    outcome = { kind: "unavailable", code: "network_error", attempts: policy.max_attempts };
  }
  const base = {
    type: "jev_assessment" as const,
    schema_version: 1 as const,
    run_id: args.runId,
    recipient_role: args.packet.recipient_role,
    recipient_visit_index: args.packet.recipient_visit_index,
    packet_sha256: packetSha,
    reason_sha256: reasonSha,
    input_sha256: inputSha,
    dispatch_source_kind: args.packet.dispatch_source.kind,
    dispatch_source_ts: args.packet.dispatch_source.ts,
    ...(args.packet.dispatch_source.kind === "initial_run"
      ? {}
      : { source_record_key: args.packet.dispatch_source.source_record_key }),
    requested_model: policy.model,
    ts,
  };
  let record: JevAssessmentRecord;
  if (outcome.kind === "unavailable") {
    record = {
      ...base,
      status: "unavailable",
      failure: { code: outcome.code, attempts: outcome.attempts },
    };
  } else {
    const invalid = validateCompletedOutcome(outcome, policy.max_attempts);
    if (invalid !== null) {
      record = {
        ...base,
        status: "unavailable",
        failure: { code: invalid, attempts: policy.max_attempts },
      };
    } else {
      record = {
        ...base,
        status: "completed",
        judgments: toPersistedJudgments(outcome.judgments),
        actual_model: outcome.actual_model,
        usage: { ...outcome.usage },
      };
    }
  }
  assertJevAssessmentRecord(record);
  args.log.append(record as unknown as PersistedRecord);
  return record;
}
