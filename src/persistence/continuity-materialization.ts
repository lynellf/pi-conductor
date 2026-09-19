/** Pure durable-continuity replay — spec §10–§11. */
import { Value } from "typebox/value";
import type { ContinuityEvidenceResolution } from "../core/types.js";
import type {
  ContinuityFinding,
  ContinuityNextStep,
  ContinuityQuestion,
  EvidenceRef,
} from "../seam/continuity.js";
import { continuityPacketV1Schema } from "../seam/continuity.js";
import type {
  ContinuityActiveOrSupersededItem,
  ContinuityEnvelopeV1,
  ContinuityLedger,
  ContinuityLedgerCounts,
  ContinuityOkfCandidate,
  ContinuityResolvedEvaluation,
  MaterializeContinuity,
} from "./continuity.js";
import {
  buildContinuityItemIndex,
  type ContinuityItemIndex,
  ContinuityItemIndexError,
} from "./continuity-item-index.js";
import { executionOutcomes } from "./continuity-materialization-executions.js";
import {
  assertRequiredPacket,
  continuityRequirements,
} from "./continuity-materialization-policy.js";
import {
  ContinuityLifecycleIndex,
  continuityEnvelope,
  type MaterializationFail,
  recordId,
  recordRunId,
  timestamp,
} from "./continuity-materialization-provenance.js";
import {
  type DurableContinuityExecution,
  expectedReplayEvidenceStatus,
} from "./continuity-replay-evidence.js";
import type { PersistedRecord } from "./log.js";

export type ContinuityMaterializationCode =
  | "continuity_malformed_record"
  | "continuity_unsupported_version"
  | "continuity_packet_not_object"
  | "continuity_packet_wrong_schema_version"
  | "continuity_packet_too_large"
  | "continuity_required_handoff"
  | "continuity_required_delegated_result";

/** Error carrying the immutable record identity that failed replay. */
export class ContinuityMaterializationException extends Error {
  constructor(
    readonly record_id: string,
    readonly code: ContinuityMaterializationCode,
    message: string,
  ) {
    super(message);
    this.name = "ContinuityMaterializationException";
  }
}

type Item = ContinuityFinding | ContinuityQuestion | ContinuityNextStep;

function isHostOnlySyntheticRecord(record: PersistedRecord): boolean {
  if (!("session_file" in record) || typeof record.session_file !== "string") return false;
  return (
    record.session_file.startsWith("<operator-routing:") ||
    record.session_file.startsWith("<synthesized:")
  );
}

/** Fold records in append order; malformed authority or resolution metadata never replays. */
export const materializeContinuity: MaterializeContinuity = (records, policy) => {
  const lifecycle = new ContinuityLifecycleIndex();
  const envelopes: ContinuityEnvelopeV1[] = [];
  let bytes = 0;
  const fail: MaterializationFail = (identity, message) => {
    throw new ContinuityMaterializationException(identity, codeFor(message), message);
  };
  const requirements = continuityRequirements(policy);
  for (const record of records) {
    if (recordRunId(record) !== policy.run_id) continue;
    // Operator routing and synthesized terminal records are host-only
    // placeholders, not continuity authority. Ignore them before lifecycle
    // reconstruction so repeated routing attempts cannot poison replay.
    if (isHostOnlySyntheticRecord(record)) continue;
    lifecycle.observe(record, fail);
    assertRequiredPacket(record, requirements, lifecycle, fail);
    const envelope = envelopeFromRecord(record, lifecycle, fail);
    if (envelope === null) continue;
    envelopes.push(envelope);
    bytes += envelope.packet_utf8_bytes;
  }
  const executions = executionOutcomes(records, policy.run_id, fail);
  for (const envelope of envelopes) validateEnvelope(envelope, executions, records, fail);
  const items = resolveItems(envelopes, fail);
  const evaluations = resolveEvaluations(envelopes, executions, items.index, fail);
  const candidates = candidatesFrom(items.findings, envelopes);
  const active = <T>(entries: readonly ContinuityActiveOrSupersededItem<T>[]) =>
    entries.filter((entry) => entry.superseded_by.length === 0).length;
  const counts: ContinuityLedgerCounts = Object.freeze({
    envelope_count: envelopes.length,
    byte_count: bytes,
    active_finding_count: active(items.findings),
    superseded_finding_count: items.findings.length - active(items.findings),
    active_question_count: active(items.questions),
    superseded_question_count: items.questions.length - active(items.questions),
    active_next_step_count: active(items.nextSteps),
    superseded_next_step_count: items.nextSteps.length - active(items.nextSteps),
    okf_candidate_count: candidates.length,
  });
  const last = records.length === 0 ? 0 : timestamp(records[records.length - 1] as PersistedRecord);
  return Object.freeze({
    run_id: policy.run_id,
    generated_at: (policy.now ?? (() => new Date(last)))().toISOString(),
    envelopes: Object.freeze(envelopes),
    findings: items.findings,
    evaluations,
    open_questions: items.questions,
    next_steps: items.nextSteps,
    evidence_resolutions: Object.freeze(
      envelopes.flatMap((envelope) => envelope.evidence_resolutions),
    ),
    okf_candidates: candidates,
    counts,
  }) as ContinuityLedger;
};

function envelopeFromRecord(
  record: PersistedRecord,
  lifecycle: ContinuityLifecycleIndex,
  fail: MaterializationFail,
): ContinuityEnvelopeV1 | null {
  if (record.type === "transition_accepted") {
    const handoff = record.accepted_handoff;
    if (handoff === undefined || handoff === null) return null;
    if (
      handoff.continuity_evidence === undefined &&
      handoff.continuity_packet_utf8_bytes === undefined
    )
      return null;
    if (
      handoff.continuity_evidence === undefined ||
      handoff.continuity_packet_utf8_bytes === undefined
    )
      return fail(recordId(record), "handoff continuity metadata is partial");
    const payload = handoff.payload;
    if (!isObject(payload) || !("continuity" in payload))
      return fail(recordId(record), "missing continuity");
    const source = lifecycle.handoff(record, fail);
    return continuityEnvelope(
      record,
      "handoff",
      source.role,
      source.visit,
      payload.continuity,
      handoff.continuity_packet_utf8_bytes,
      handoff.continuity_evidence,
      fail,
    );
  }
  if (record.type !== "subagent_completed" || record.continuity === undefined) return null;
  const source = lifecycle.child(record, fail);
  return continuityEnvelope(
    record,
    "delegated_result",
    source.role,
    source.visit,
    record.continuity.packet,
    record.continuity.packet_utf8_bytes,
    record.continuity.evidence_resolutions,
    fail,
    source.child,
  );
}

function validateEnvelope(
  envelope: ContinuityEnvelopeV1,
  executions: ReadonlyMap<string, DurableContinuityExecution>,
  records: readonly PersistedRecord[],
  fail: MaterializationFail,
): void {
  if (envelope.packet.schema_version !== 1)
    fail(envelope.record_id, "unsupported continuity packet version");
  if (!Value.Check(continuityPacketV1Schema, envelope.packet))
    fail(envelope.record_id, "continuity packet fails TypeBox schema");
  const expected = evidenceEntries(envelope.packet);
  const actual = envelope.evidence_resolutions;
  if (actual.length !== expected.length)
    fail(envelope.record_id, "continuity evidence resolution count is not exact");
  for (let index = 0; index < expected.length; index += 1) {
    const wanted = expected[index];
    const resolved = actual[index];
    if (
      wanted === undefined ||
      resolved === undefined ||
      wanted.key !== resolved.ref_key ||
      wanted.ref.kind !== resolved.kind
    )
      fail(envelope.record_id, "continuity evidence resolution does not bind its exact reference");
    const expectedStatus = expectedReplayEvidenceStatus(wanted.ref, envelope, executions, records);
    if (expectedStatus !== undefined && resolved.status !== expectedStatus)
      fail(envelope.record_id, "continuity evidence resolution does not match durable audience");
  }
  for (const finding of envelope.packet.findings) {
    if (
      finding.confidence === "verified" &&
      (!finding.evidence.length ||
        finding.evidence.some(
          (_ref, index) =>
            actual.find((r) => r.ref_key === `findings:${finding.id}:${index}`)?.status !==
            "verified",
        ))
    )
      fail(envelope.record_id, "verified finding lacks verified durable evidence");
  }
}

function resolveItems(envelopes: readonly ContinuityEnvelopeV1[], fail: MaterializationFail) {
  let index: ContinuityItemIndex;
  try {
    index = buildContinuityItemIndex(
      envelopes.map((envelope) => ({ record_id: envelope.record_id, packet: envelope.packet })),
    );
  } catch (cause) {
    if (cause instanceof ContinuityItemIndexError) fail(cause.record_id, cause.message);
    throw cause;
  }
  const groups = {
    findings: [] as [ContinuityFinding, ContinuityEnvelopeV1][],
    questions: [] as [ContinuityQuestion, ContinuityEnvelopeV1][],
    nextSteps: [] as [ContinuityNextStep, ContinuityEnvelopeV1][],
  };
  for (const envelope of envelopes) {
    for (const item of envelope.packet.findings) groups.findings.push([item, envelope]);
    for (const item of envelope.packet.open_questions) groups.questions.push([item, envelope]);
    for (const item of envelope.packet.next_steps) groups.nextSteps.push([item, envelope]);
  }
  const project = <T extends Item>(entries: readonly [T, ContinuityEnvelopeV1][]) =>
    Object.freeze(
      entries.map(([item, envelope]) =>
        Object.freeze({
          item,
          superseded_by: index.superseded_by.get(item.id) ?? Object.freeze([]),
          envelope_source: envelope.source,
          record_id: envelope.record_id,
        }),
      ),
    );
  return Object.freeze({
    index,
    findings: project(groups.findings),
    questions: project(groups.questions),
    nextSteps: project(groups.nextSteps),
  });
}

function resolveEvaluations(
  envelopes: readonly ContinuityEnvelopeV1[],
  executions: ReadonlyMap<string, DurableContinuityExecution>,
  index: ReturnType<typeof buildContinuityItemIndex>,
  fail: MaterializationFail,
): readonly ContinuityResolvedEvaluation[] {
  const out: ContinuityResolvedEvaluation[] = [];
  for (const envelope of envelopes)
    for (const evaluation of envelope.packet.evaluations) {
      const outcome = executions.get(evaluation.execution_id);
      if (outcome === undefined)
        fail(
          envelope.record_id,
          `evaluation execution '${evaluation.execution_id}' is not durable`,
        );
      out.push(
        Object.freeze({
          ...outcome,
          id: evaluation.id,
          label: evaluation.label,
          superseded_by: index.superseded_by.get(evaluation.id) ?? Object.freeze([]),
          envelope_source: envelope.source,
          record_id: envelope.record_id,
        }),
      );
    }
  return Object.freeze(out);
}

function candidatesFrom(
  findings: readonly ContinuityActiveOrSupersededItem<ContinuityFinding>[],
  envelopes: readonly ContinuityEnvelopeV1[],
): readonly ContinuityOkfCandidate[] {
  const candidates = new Map(
    envelopes.map((envelope) => [envelope.record_id, new Set(envelope.packet.okf_candidate_ids)]),
  );
  const resolutions = new Map(
    envelopes.flatMap((envelope) =>
      envelope.evidence_resolutions.map(
        (resolution) => [`${envelope.record_id}:${resolution.ref_key}`, resolution] as const,
      ),
    ),
  );
  return Object.freeze(
    findings.flatMap((finding) => {
      if (
        !candidates.get(finding.record_id)?.has(finding.item.id) ||
        finding.item.confidence !== "verified" ||
        finding.superseded_by.length
      )
        return [];
      const evidence = finding.item.evidence.map((ref, index) => ({
        ref,
        resolution: resolutions.get(`${finding.record_id}:findings:${finding.item.id}:${index}`),
      }));
      if (evidence.some(({ resolution }) => resolution?.status !== "verified")) return [];
      return [
        {
          finding_id: finding.item.id,
          statement: finding.item.statement,
          envelope_source: finding.envelope_source,
          record_id: finding.record_id,
          evidence: Object.freeze(
            evidence.map(({ ref, resolution }) => ({
              ref,
              ...(resolution as ContinuityEvidenceResolution),
            })),
          ),
        },
      ];
    }),
  );
}

function evidenceEntries(
  packet: ContinuityEnvelopeV1["packet"],
): readonly { readonly key: string; readonly ref: EvidenceRef }[] {
  return (
    [
      ["findings", packet.findings],
      ["open_questions", packet.open_questions],
      ["next_steps", packet.next_steps],
    ] as const
  ).flatMap(([collection, items]) =>
    items.flatMap((item) =>
      item.evidence.map((ref, index) => ({ key: `${collection}:${item.id}:${index}`, ref })),
    ),
  );
}
function codeFor(message: string): ContinuityMaterializationCode {
  if (message.includes("required handoff")) return "continuity_required_handoff";
  if (message.includes("required delegated-result")) return "continuity_required_delegated_result";
  if (message.includes("unsupported")) return "continuity_unsupported_version";
  if (message.includes("not an object")) return "continuity_packet_not_object";
  if (message.includes("byte count")) return "continuity_packet_too_large";
  return "continuity_malformed_record";
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { renderContinuitySeed } from "./continuity-seed.js";
