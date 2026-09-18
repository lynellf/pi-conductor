/** Pure durable-continuity replay — spec §10–§11. */
import { Value } from "typebox/value";
import type { ContinuityEvidenceResolution } from "../core/types.js";
import type {
  ContinuityFinding,
  ContinuityNextStep,
  ContinuityQuestion,
} from "../seam/continuity.js";
import { continuityPacketV1Schema } from "../seam/continuity.js";
import type {
  ContinuityActiveOrSupersededItem,
  ContinuityChildProvenance,
  ContinuityEnvelopeV1,
  ContinuityLedger,
  ContinuityLedgerCounts,
  ContinuityOkfCandidate,
  ContinuityResolvedEvaluation,
  MaterializeContinuity,
} from "./continuity.js";
import { CONTINUITY_MAX_PACKET_BYTES, normalizeAndMeasurePacket } from "./continuity.js";
import type { PersistedRecord } from "./log.js";
import {
  isToolExecutionRecord,
  reconstructToolExecutionTimeline,
  type ToolExecutionRecord,
} from "./tool-execution.js";

export type ContinuityMaterializationCode =
  | "continuity_malformed_record"
  | "continuity_unsupported_version"
  | "continuity_packet_not_object"
  | "continuity_packet_wrong_schema_version"
  | "continuity_packet_too_large";

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

type Parent = { readonly role: string; readonly visit: number; readonly attempt: number };
type Item = ContinuityFinding | ContinuityQuestion | ContinuityNextStep;

/** Fold records in their append order. Reordering a log is never recovery. */
export const materializeContinuity: MaterializeContinuity = (records, policy) => {
  const parents = new Map<string, Parent>();
  const executions = executionOutcomes(records, policy.run_id);
  const envelopes: ContinuityEnvelopeV1[] = [];
  let bytes = 0;
  for (const record of records) {
    if (recordRunId(record) !== policy.run_id) continue;
    if (record.type === "subagent_started") {
      parents.set(record.child_id, {
        role:
          record.parent_role ??
          fail(id(record), "continuity_malformed_record", "child start lacks parent role"),
        visit:
          record.parent_visit_index ??
          fail(id(record), "continuity_malformed_record", "child start lacks parent visit"),
        attempt: 1,
      });
    }
    const envelope = envelopeFromRecord(record, parents);
    if (envelope === null) continue;
    validateEnvelope(envelope);
    envelopes.push(envelope);
    bytes += envelope.packet_utf8_bytes;
  }
  const items = resolveItems(envelopes);
  const evaluations = resolveEvaluations(envelopes, executions);
  const evidence = Object.freeze(envelopes.flatMap((envelope) => envelope.evidence_resolutions));
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
    evidence_resolutions: evidence,
    okf_candidates: candidates,
    counts,
  }) as ContinuityLedger;
};

function envelopeFromRecord(
  record: PersistedRecord,
  parents: ReadonlyMap<string, Parent>,
): ContinuityEnvelopeV1 | null {
  if (record.type === "transition_accepted") {
    const handoff = record.accepted_handoff;
    if (handoff === undefined || handoff === null) return null;
    const hasMetadata =
      handoff.continuity_evidence !== undefined ||
      handoff.continuity_packet_utf8_bytes !== undefined;
    if (!hasMetadata) return null;
    if (
      handoff.continuity_evidence === undefined ||
      handoff.continuity_packet_utf8_bytes === undefined
    )
      return fail(
        id(record),
        "continuity_malformed_record",
        "handoff continuity metadata is partial",
      );
    const packet = objectField(handoff.payload, "continuity", id(record));
    return envelope(
      record,
      "handoff",
      record.role,
      visit(record.session_file),
      packet,
      handoff.continuity_packet_utf8_bytes,
      handoff.continuity_evidence,
    );
  }
  if (record.type !== "subagent_completed" || record.continuity === undefined) return null;
  const parent = parents.get(record.child_id);
  if (parent === undefined)
    return fail(
      id(record),
      "continuity_malformed_record",
      "child completion has no preceding start",
    );
  return envelope(
    record,
    "delegated_result",
    parent.role,
    parent.visit,
    record.continuity.packet,
    record.continuity.packet_utf8_bytes,
    record.continuity.evidence_resolutions,
    {
      child_id: record.child_id,
      subagent: record.subagent,
      task_id: record.task_id,
      attempt: parent.attempt,
    },
  );
}

function envelope(
  record: PersistedRecord,
  source: ContinuityEnvelopeV1["source"],
  role: string,
  visitIndex: number,
  packet: unknown,
  declaredBytes: number,
  evidence: readonly ContinuityEvidenceResolution[],
  child?: ContinuityChildProvenance,
): ContinuityEnvelopeV1 {
  const recordId = id(record);
  if (!isObject(packet))
    return fail(recordId, "continuity_packet_not_object", "continuity packet is not an object");
  const measured = normalizeAndMeasurePacket(packet);
  if (
    !Number.isSafeInteger(declaredBytes) ||
    declaredBytes <= 0 ||
    declaredBytes !== measured.bytes ||
    measured.bytes > CONTINUITY_MAX_PACKET_BYTES
  )
    return fail(
      recordId,
      "continuity_packet_too_large",
      "continuity packet byte count is not exact",
    );
  return Object.freeze({
    schema_version: 1,
    source,
    record_id: recordId,
    run_id: recordRunId(record),
    role,
    visit: visitIndex,
    ...(child === undefined ? {} : { child }),
    accepted_at: new Date(timestamp(record)).toISOString(),
    packet_utf8_bytes: measured.bytes,
    packet: packet as ContinuityEnvelopeV1["packet"],
    evidence_resolutions: Object.freeze(evidence.map((value) => Object.freeze({ ...value }))),
  });
}

function validateEnvelope(envelope: ContinuityEnvelopeV1): void {
  if (envelope.packet.schema_version !== 1)
    fail(
      envelope.record_id,
      "continuity_unsupported_version",
      "unsupported continuity packet version",
    );
  if (!Value.Check(continuityPacketV1Schema, envelope.packet))
    fail(
      envelope.record_id,
      "continuity_malformed_record",
      "continuity packet fails TypeBox schema",
    );
  const expected = evidenceKeys(envelope.packet);
  const actual = new Map(
    envelope.evidence_resolutions.map((resolution) => [resolution.ref_key, resolution]),
  );
  if (
    actual.size !== envelope.evidence_resolutions.length ||
    expected.some((key) => !actual.has(key))
  )
    fail(
      envelope.record_id,
      "continuity_malformed_record",
      "continuity evidence resolution keys are incomplete",
    );
  for (const finding of envelope.packet.findings) {
    if (
      finding.confidence === "verified" &&
      (!finding.evidence.length ||
        finding.evidence.some(
          (_ref, index) => actual.get(`findings:${finding.id}:${index}`)?.status !== "verified",
        ))
    )
      fail(
        envelope.record_id,
        "continuity_malformed_record",
        "verified finding lacks verified durable evidence",
      );
  }
}

function resolveItems(envelopes: readonly ContinuityEnvelopeV1[]) {
  const seen = new Map<string, { superseded_by: string[] }>();
  const findings: [ContinuityFinding, ContinuityEnvelopeV1][] = [];
  const questions: [ContinuityQuestion, ContinuityEnvelopeV1][] = [];
  const nextSteps: [ContinuityNextStep, ContinuityEnvelopeV1][] = [];
  for (const envelope of envelopes) {
    const groups: readonly [readonly Item[], (item: Item) => void][] = [
      [envelope.packet.findings, (item) => findings.push([item as ContinuityFinding, envelope])],
      [
        envelope.packet.open_questions,
        (item) => questions.push([item as ContinuityQuestion, envelope]),
      ],
      [
        envelope.packet.next_steps,
        (item) => nextSteps.push([item as ContinuityNextStep, envelope]),
      ],
    ];
    for (const [group, add] of groups)
      for (const item of group) {
        if (seen.has(item.id))
          fail(
            envelope.record_id,
            "continuity_malformed_record",
            `duplicate global item id '${item.id}'`,
          );
        for (const target of item.supersedes) {
          if (target === item.id || !seen.has(target))
            fail(
              envelope.record_id,
              "continuity_malformed_record",
              `supersedes target '${target}' is not an earlier item`,
            );
          seen.get(target)?.superseded_by.push(item.id);
        }
        seen.set(item.id, { superseded_by: [] });
        add(item);
      }
  }
  const project = <T extends Item>(entries: readonly [T, ContinuityEnvelopeV1][]) =>
    Object.freeze(
      entries.map(([item, envelope]) =>
        Object.freeze({
          item,
          superseded_by: Object.freeze([...(seen.get(item.id)?.superseded_by ?? [])]),
          envelope_source: envelope.source,
          record_id: envelope.record_id,
        }),
      ),
    );
  return Object.freeze({
    findings: project(findings),
    questions: project(questions),
    nextSteps: project(nextSteps),
  });
}

function executionOutcomes(
  records: readonly PersistedRecord[],
  runId: string,
): ReadonlyMap<string, ContinuityResolvedEvaluation> {
  const toolRecords = records.filter(
    (record): record is ToolExecutionRecord =>
      recordRunId(record) === runId && isToolExecutionRecord(record),
  );
  const out = new Map<string, ContinuityResolvedEvaluation>();
  try {
    reconstructToolExecutionTimeline(toolRecords);
  } catch {
    return out;
  }
  for (const record of toolRecords)
    if (record.type === "tool_execution_finished")
      out.set(record.execution_id, {
        id: "",
        label: "",
        execution_id: record.execution_id,
        status:
          record.outcome === "completed"
            ? "passed"
            : record.outcome === "failed"
              ? "failed"
              : "incomplete",
        exit_summary: record.outcome,
        cleanup_disposition: record.cleanup,
        command_digest: null,
        superseded_by: [],
        envelope_source: "handoff",
        record_id: id(record),
      });
  return out;
}
function resolveEvaluations(
  envelopes: readonly ContinuityEnvelopeV1[],
  executions: ReadonlyMap<string, ContinuityResolvedEvaluation>,
): readonly ContinuityResolvedEvaluation[] {
  const ids = new Set<string>();
  const items: ContinuityResolvedEvaluation[] = [];
  for (const envelope of envelopes)
    for (const evaluation of envelope.packet.evaluations) {
      if (ids.has(evaluation.id) || evaluation.supersedes.some((target) => !ids.has(target)))
        fail(
          envelope.record_id,
          "continuity_malformed_record",
          "evaluation identity or supersession is invalid",
        );
      const outcome = executions.get(evaluation.execution_id);
      if (outcome === undefined)
        fail(
          envelope.record_id,
          "continuity_malformed_record",
          `evaluation execution '${evaluation.execution_id}' is not durable`,
        );
      ids.add(evaluation.id);
      items.push(
        Object.freeze({
          ...outcome,
          id: evaluation.id,
          label: evaluation.label,
          superseded_by: Object.freeze([...evaluation.supersedes]),
          envelope_source: envelope.source,
          record_id: envelope.record_id,
        }),
      );
    }
  return Object.freeze(items);
}
function candidatesFrom(
  findings: readonly ContinuityActiveOrSupersededItem<ContinuityFinding>[],
  envelopes: readonly ContinuityEnvelopeV1[],
): readonly ContinuityOkfCandidate[] {
  const packetCandidates = new Map(
    envelopes.map((envelope) => [envelope.record_id, new Set(envelope.packet.okf_candidate_ids)]),
  );
  const evidence = new Map(
    envelopes.flatMap((envelope) =>
      envelope.evidence_resolutions.map(
        (resolution) => [`${envelope.record_id}:${resolution.ref_key}`, resolution] as const,
      ),
    ),
  );
  return Object.freeze(
    findings.flatMap((finding) => {
      if (
        !packetCandidates.get(finding.record_id)?.has(finding.item.id) ||
        finding.item.confidence !== "verified" ||
        finding.superseded_by.length
      )
        return [];
      const refs = finding.item.evidence.map((_ref, index) =>
        evidence.get(`${finding.record_id}:findings:${finding.item.id}:${index}`),
      );
      if (refs.some((ref) => ref?.status !== "verified")) return [];
      return [
        {
          finding_id: finding.item.id,
          statement: finding.item.statement,
          envelope_source: finding.envelope_source,
          record_id: finding.record_id,
          evidence: Object.freeze(
            refs.map((ref) => ({
              kind: ref?.kind ?? "repository",
              ref_key: ref?.ref_key ?? "",
              status: ref?.status ?? "missing",
              ...(ref?.resolved_path === undefined ? {} : { resolved_path: ref.resolved_path }),
              ...(ref?.resolved_commit === undefined
                ? {}
                : { resolved_commit: ref.resolved_commit }),
            })),
          ),
        },
      ];
    }),
  );
}
function evidenceKeys(packet: ContinuityEnvelopeV1["packet"]): string[] {
  return [packet.findings, packet.open_questions, packet.next_steps].flatMap((items, group) =>
    items.flatMap((item) =>
      item.evidence.map(
        (_ref, index) =>
          `${["findings", "open_questions", "next_steps"][group]}:${item.id}:${index}`,
      ),
    ),
  );
}
function id(record: PersistedRecord): string {
  return "session_file" in record
    ? `${record.type}:${record.session_file}`
    : `${record.type}:${timestamp(record)}`;
}
function timestamp(record: PersistedRecord): number {
  return record.type === "checkpoint_snapshot" ? record.checkpoint.updated_at : record.ts;
}
function recordRunId(record: PersistedRecord): string {
  return record.type === "checkpoint_snapshot" ? record.checkpoint.run_id : record.run_id;
}
function objectField(value: unknown, key: string, recordId: string): unknown {
  if (!isObject(value) || !(key in value))
    return fail(recordId, "continuity_malformed_record", `missing ${key}`);
  return value[key];
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function visit(sessionFile: string): number {
  const match = /(\d+)/.exec(sessionFile);
  return match === null ? 1 : Number(match[1]) || 1;
}
function fail(recordId: string, code: ContinuityMaterializationCode, message: string): never {
  throw new ContinuityMaterializationException(recordId, code, message);
}

export { renderContinuitySeed } from "./continuity-seed.js";
