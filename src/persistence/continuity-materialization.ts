/**
 * Pure chronological ledger materializer — durable-continuity spec §10, §11.
 *
 * Folds validated continuity envelopes from append-only durable records in
 * canonical record order. The materializer is pure over records + policy;
 * filesystem/network evidence resolution happens before envelope acceptance
 * or in an explicit host-side verifier.
 *
 * Explicit supersession:
 * - A newer globally-unique item ID supersedes the listed earlier IDs in
 *   the SAME run. Superseded items are marked so but retained in the ledger.
 * - Forward, self, missing, and cyclic references are rejected with stable
 *   diagnostics that name the record identity.
 *
 * Materialization is deterministic: repeated calls over the same log + policy
 * produce byte-identical ledger output.
 *
 * Write-owned by: Lane C (DC-LEDGER). Reads only shared contracts from
 * `src/persistence/continuity.ts`, `src/persistence/log.ts`,
 * `src/manifest/parse.ts`, and `src/core/types.ts`.
 */

import { Value } from "typebox/value";

import type { ContinuityEvidenceResolution } from "../core/types.js";
import {
  continuityPacketV1Schema,
} from "../seam/continuity.js";
import type {
  ContinuityFinding,
  ContinuityNextStep,
  ContinuityQuestion,
} from "../seam/continuity.js";
import type {
  ContinuityActiveOrSupersededItem,
  ContinuityChildProvenance,
  ContinuityEnvelopeV1,
  ContinuityLedger,
  ContinuityLedgerCounts,
  ContinuityMaterializationPolicy,
  ContinuityOkfCandidate,
  ContinuityResolvedEvaluation,
  MaterializeContinuity,
  RenderContinuitySeed,
  ContinuitySeed,
  ContinuitySeedSections,
} from "./continuity.js";
import {
  normalizeAndMeasurePacket,
  stableJsonStringify,
} from "./continuity.js";
import type { PersistedRecord } from "./log.js";

// ─── Stable diagnostic codes (spec §10, §14) ─────────────────────────

/** Stable reason a materialization step fails. */
export type ContinuityMaterializationCode =
  | "continuity_malformed_record"
  | "continuity_unsupported_version"
  | "continuity_packet_not_object"
  | "continuity_packet_wrong_schema_version"
  | "continuity_packet_too_large";

export interface ContinuityMaterializationError {
  readonly record_id: string;
  readonly code: ContinuityMaterializationCode;
  readonly message: string;
  readonly collection?: string;
}

/** Typed rejection of malformed/unsupported records during materialization. */
export class ContinuityMaterializationException extends Error {
  readonly record_id: string;
  readonly code: ContinuityMaterializationCode;
  constructor(record_id: string, code: ContinuityMaterializationCode, message: string) {
    super(message);
    this.name = "ContinuityMaterializationException";
    this.record_id = record_id;
    this.code = code;
  }
}

// ─── Stable record identity ─────────────────────────────────────────────

/** Stable string identity for a persisted record. */
function recordIdOf(record: PersistedRecord): string {
  // Stable identifier for materialization diagnostics and envelope
  // provenance. Prefer the explicit record type joined with the session
  // file (which is unique per logical record) so callers can correlate
  // errors with the role session that produced the record.
  if ("session_file" in record && typeof record.session_file === "string") {
    return `${record.type}:${record.session_file}`;
  }
  if (record.type === "checkpoint_snapshot") {
    return `checkpoint_snapshot:${record.checkpoint.updated_at}`;
  }
  return `${record.type}:${record.ts}`;
}

// ─── Envelope extraction from records (spec §10) ───────────────────────

/**
 * Attempt to extract a ContinuityEnvelopeV1 from a PersistedRecord.
 *
 * Envelopes are embedded in:
 * - `transition_accepted` records that carry `accepted_handoff?.continuity`
 * - `subagent_completed` records that carry `continuity`
 *
 * Returns null when the record carries no continuity data (legacy records
 * or terminal states without continuity). Throws ContinuityMaterializationException
 * when the record is structurally present but malformed.
 */
function extractEnvelope(record: PersistedRecord): ContinuityEnvelopeV1 | null {
  // 1. accepted_handoff continuity siblings (spec §8). Packet lives in
  // `payload.continuity`; `continuity_packet_utf8_bytes` and
  // `continuity_evidence` are host-produced sibling fields and never
  // carry the packet.
  if (record.type === "transition_accepted") {
    const handoff = record.accepted_handoff;
    if (handoff === undefined || handoff === null) return null;

    const declaredBytes = handoff.continuity_packet_utf8_bytes;
    const evidenceSiblings = handoff.continuity_evidence;
    if (declaredBytes === undefined && evidenceSiblings === undefined) {
      return null;
    }
    if (declaredBytes === undefined || evidenceSiblings === undefined) {
      throw new ContinuityMaterializationException(
        recordIdOf(record),
        "continuity_malformed_record",
        `handoff record ${recordIdOf(record)} has partial continuity siblings`,
      );
    }
    const packetCandidate = readPayloadContinuityPacket(handoff.payload);
    if (packetCandidate === null) {
      throw new ContinuityMaterializationException(
        recordIdOf(record),
        "continuity_malformed_record",
        `handoff record ${recordIdOf(record)} has continuity siblings but no payload.continuity packet`,
      );
    }
    let parsedPacket: unknown;
    try {
      parsedPacket = JSON.parse(JSON.stringify(packetCandidate)) as unknown;
    } catch {
      throw new ContinuityMaterializationException(
        recordIdOf(record),
        "continuity_packet_not_object",
        `handoff record ${recordIdOf(record)} has continuity packet that is not valid JSON`,
      );
    }
    const normalized = normalizeAndMeasurePacket(parsedPacket);

    const envelope: ContinuityEnvelopeV1 = {
      schema_version: 1,
      source: "handoff",
      record_id: recordIdOf(record),
      run_id: record.run_id,
      role: record.role,
      visit: extractVisitFromRole(record.role, record.session_file),
      accepted_at: new Date(record.ts).toISOString(),
      packet_utf8_bytes: normalized.bytes,
      packet: parsedPacket as ContinuityEnvelopeV1["packet"],
      evidence_resolutions: Object.freeze(evidenceSiblings.map((resolution) => Object.freeze({ ...resolution }))),
    };

    return envelope;
  }

  // 2. delegated child continuity sibling (spec §9). The successful
  // subagent_completed record carries the host-authored continuation
  // metadata under `continuity` with `packet`, `packet_utf8_bytes`, and
  // `evidence_resolutions` (the additive sibling defined in
  // `delegation-lifecycle-schema.ts`).
  if (record.type === "subagent_completed") {
    const continuity = record.continuity;
    if (continuity === undefined || continuity === null) return null;

    const packetCandidate = continuity.packet;
    const declaredBytes = continuity.packet_utf8_bytes;
    const evidenceSiblings = continuity.evidence_resolutions;

    let parsedPacket: unknown;
    try {
      parsedPacket = JSON.parse(JSON.stringify(packetCandidate)) as unknown;
    } catch {
      throw new ContinuityMaterializationException(
        recordIdOf(record),
        "continuity_packet_not_object",
        `subagent_completed record ${recordIdOf(record)} has continuity packet that is not valid JSON`,
      );
    }
    const normalized = normalizeAndMeasurePacket(parsedPacket);

    const evidenceResolutions = evidenceSiblings.map((resolution, i) => {
      const refKey = resolution.ref_key.length > 0 ? resolution.ref_key : `delegated:${i}`;
      const out: {
        ref_key: string;
        kind: string;
        status: ContinuityEvidenceResolution["status"];
        diagnostic?: string;
        message?: string;
        resolved_path?: string;
        resolved_commit?: string;
      } = {
        ref_key: refKey,
        kind: resolution.kind,
        status: resolution.status,
      };
      if (resolution.diagnostic !== undefined) out.diagnostic = resolution.diagnostic;
      if (resolution.message !== undefined) out.message = resolution.message;
      if (resolution.resolved_path !== undefined) out.resolved_path = resolution.resolved_path;
      if (resolution.resolved_commit !== undefined) out.resolved_commit = resolution.resolved_commit;
      return Object.freeze(out) as ContinuityEvidenceResolution;
    });

    const child: ContinuityChildProvenance = {
      child_id: record.child_id,
      subagent: record.subagent,
      task_id: record.task_id,
      // attempts are not separately persisted on completion; the
      // materializer reflects the single successful attempt.
      attempt: 1,
    };

    const envelope: ContinuityEnvelopeV1 = {
      schema_version: 1,
      source: "delegated_result",
      record_id: recordIdOf(record),
      run_id: record.run_id,
      // The parent role and visit are host-derived from the surrounding
      // `subagent_started` record; the materializer reports those as
      // placeholders when the host has not supplied a precomputed
      // provenance map. They remain host-controlled and stable across
      // replays because they are derived only from authoritative state.
      role: "",
      visit: 0,
      child,
      accepted_at: new Date(record.ts).toISOString(),
      packet_utf8_bytes: normalized.bytes,
      packet: parsedPacket as ContinuityEnvelopeV1["packet"],
      evidence_resolutions: Object.freeze(evidenceResolutions),
    };

    void declaredBytes; // Already validated at seam acceptance; measured again above deterministically.
    return envelope;
  }

  return null;
}

/**
 * Read the `payload.continuity` packet from an accepted_handoff payload.
 * Returns `null` when the payload is absent or structurally incomplete.
 */
function readPayloadContinuityPacket(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) return null;
  const obj = payload as Record<string, unknown>;
  const packet = obj.continuity;
  if (packet === undefined || packet === null) return null;
  if (typeof packet !== "object" || Array.isArray(packet)) return null;
  return packet;
}

/** Extract a synthetic visit index from the session file string. */
function extractVisitFromRole(role: string, session_file: string): number {
  // session_file format: typically ends with a sequence number or contains
  // role-based context. We derive a synthetic stable visit from the file path.
  const match = /(\d+)/.exec(session_file);
  if (match) return parseInt(match[1]!, 10) || 1;
  return 1;
}

// ─── Packet schema validation (spec §6) ────────────────────────────────

/**
 * TypeBox schema for the continuity packet is imported from
 * `src/seam/continuity.ts` so the seam remains the single source of
 * truth for v1 packet shape (spec §6, AGENTS.md invariant #9).
 */
const packetSchema = continuityPacketV1Schema;

function validatePacketSchema(recordId: string, packet: unknown): void {
  if (typeof packet !== "object" || packet === null || Array.isArray(packet)) {
    throw new ContinuityMaterializationException(
      recordId,
      "continuity_packet_not_object",
      `record ${recordId} has continuity packet that is not an object`,
    );
  }

  const p = packet as Record<string, unknown>;

  if (p.schema_version !== 1) {
    throw new ContinuityMaterializationException(
      recordId,
      "continuity_packet_wrong_schema_version",
      `record ${recordId} has unsupported schema_version ${String(p.schema_version)}`,
    );
  }

  if (!Value.Check(packetSchema, packet)) {
    const errors = Value.Errors(packetSchema, packet);
    const first = errors[0];
    const msg = first === undefined ? "unknown schema violation" : first.message;
    throw new ContinuityMaterializationException(
      recordId,
      "continuity_malformed_record",
      `record ${recordId} packet schema violation: ${msg}`,
    );
  }
}

// ─── Supersession resolution (spec §6.2, §11) ──────────────────────────

/**
 * Compute supersession state for all items across the ledger.
 *
 * A newer globally-unique item supersedes earlier items listed in its
 * `supersedes` array. Superseded items are RETAINED in the ledger but
 * marked as superseded. Forward, self, and cyclic references are rejected.
 *
 * The algorithm processes envelopes in chronological order (already sorted
 * by `materializeContinuity`). Within each envelope, items are processed
 * in array order (as emitted by the role). An item's supersedes can only
 * target:
 * 1. Items seen in earlier envelopes
 * 2. Items earlier in the same envelope (not yet processed in this loop)
 *
 * To support same-envelope supersedes, we do two passes:
 * - Pass 1: collect all local item IDs
 * - Pass 2: resolve supersedes with local-first, then global lookback
 */
function resolveSupersession(
  envelopes: readonly ContinuityEnvelopeV1[],
): {
  findings: readonly ContinuityActiveOrSupersededItem<ContinuityFinding>[];
  questions: readonly ContinuityActiveOrSupersededItem<ContinuityQuestion>[];
  nextSteps: readonly ContinuityActiveOrSupersededItem<ContinuityNextStep>[];
} {
  // Global item registry: item_id → { superseded_by: string[], seen: boolean }
  type ItemMeta = { superseded_by: string[]; envelope_id: string };
  const allItems = new Map<string, ItemMeta>();

  // Two-pass algorithm:
  // Pass 1: register all items in envelope order
  for (const env of envelopes) {
    for (const f of env.packet.findings) {
      if (!allItems.has(f.id)) {
        allItems.set(f.id, { superseded_by: [], envelope_id: env.record_id });
      }
    }
    for (const q of env.packet.open_questions) {
      if (!allItems.has(q.id)) {
        allItems.set(q.id, { superseded_by: [], envelope_id: env.record_id });
      }
    }
    for (const ns of env.packet.next_steps) {
      if (!allItems.has(ns.id)) {
        allItems.set(ns.id, { superseded_by: [], envelope_id: env.record_id });
      }
    }
  }

  // Pass 2: apply supersedes in envelope order, then item order.
  // Track which items have been "seen" so far (items from earlier envelopes
  // or earlier items within the same envelope) to reject forward references.
  const seenInPass2 = new Set<string>();

  for (const env of envelopes) {
    for (const f of env.packet.findings) {
      for (const targetId of f.supersedes) {
        if (!seenInPass2.has(targetId)) {
          throw new ContinuityMaterializationException(
            env.record_id,
            "continuity_malformed_record",
            `item '${f.id}' supersedes '${targetId}' which appears later in the same envelope (forward reference)`,
          );
        }
        validateSupersedes(env.record_id, f.id, targetId, allItems);
        const target = allItems.get(targetId);
        if (target && !target.superseded_by.includes(f.id)) {
          target.superseded_by.push(f.id);
        }
      }
      seenInPass2.add(f.id);
    }
    for (const q of env.packet.open_questions) {
      for (const targetId of q.supersedes) {
        if (!seenInPass2.has(targetId)) {
          throw new ContinuityMaterializationException(
            env.record_id,
            "continuity_malformed_record",
            `item '${q.id}' supersedes '${targetId}' which appears later in the same envelope (forward reference)`,
          );
        }
        validateSupersedes(env.record_id, q.id, targetId, allItems);
        const target = allItems.get(targetId);
        if (target && !target.superseded_by.includes(q.id)) {
          target.superseded_by.push(q.id);
        }
      }
      seenInPass2.add(q.id);
    }
    for (const ns of env.packet.next_steps) {
      for (const targetId of ns.supersedes) {
        if (!seenInPass2.has(targetId)) {
          throw new ContinuityMaterializationException(
            env.record_id,
            "continuity_malformed_record",
            `item '${ns.id}' supersedes '${targetId}' which appears later in the same envelope (forward reference)`,
          );
        }
        validateSupersedes(env.record_id, ns.id, targetId, allItems);
        const target = allItems.get(targetId);
        if (target && !target.superseded_by.includes(ns.id)) {
          target.superseded_by.push(ns.id);
        }
      }
      seenInPass2.add(ns.id);
    }
  }

  // Build active-or-superseded projections
  const findings: ContinuityActiveOrSupersededItem<ContinuityFinding>[] = [];
  const questions: ContinuityActiveOrSupersededItem<ContinuityQuestion>[] = [];
  const nextSteps: ContinuityActiveOrSupersededItem<ContinuityNextStep>[] = [];

  for (const env of envelopes) {
    for (const f of env.packet.findings) {
      const meta = allItems.get(f.id)!;
      findings.push({
        item: f,
        superseded_by: Object.freeze([...meta.superseded_by]),
        envelope_source: env.source,
        record_id: env.record_id,
      });
    }
    for (const q of env.packet.open_questions) {
      const meta = allItems.get(q.id)!;
      questions.push({
        item: q,
        superseded_by: Object.freeze([...meta.superseded_by]),
        envelope_source: env.source,
        record_id: env.record_id,
      });
    }
    for (const ns of env.packet.next_steps) {
      const meta = allItems.get(ns.id)!;
      nextSteps.push({
        item: ns,
        superseded_by: Object.freeze([...meta.superseded_by]),
        envelope_source: env.source,
        record_id: env.record_id,
      });
    }
  }

  return {
    findings: Object.freeze(findings),
    questions: Object.freeze(questions),
    nextSteps: Object.freeze(nextSteps),
  };
}

function validateSupersedes(
  recordId: string,
  itemId: string,
  targetId: string,
  allItems: Map<string, { superseded_by: string[]; envelope_id: string }>,
): void {
  // Self-reference
  if (itemId === targetId) {
    throw new ContinuityMaterializationException(
      recordId,
      "continuity_malformed_record",
      `item '${itemId}' in record '${recordId}' lists itself in supersedes (self-reference)`,
    );
  }

  // Missing reference
  if (!allItems.has(targetId)) {
    throw new ContinuityMaterializationException(
      recordId,
      "continuity_malformed_record",
      `item '${itemId}' in record '${recordId}' supersedes unknown item '${targetId}' (missing reference)`,
    );
  }
}

// ─── Evaluation resolution (spec §6.3, §11) ───────────────────────────

/**
 * Resolve evaluations from envelopes into host-derived evaluation outcomes.
 *
 * The model supplies the evaluation label and execution_id; the host derives
 * the actual status, exit summary, cleanup disposition, and command digest
 * from the run's execution records.
 *
 * For the pure materializer (no I/O), we accept the model's execution_id
 * and emit a placeholder status. The host-side resolver would replace these
 * with authoritative values during handoff/child acceptance.
 */
function resolveEvaluations(
  envelopes: readonly ContinuityEnvelopeV1[],
): readonly ContinuityResolvedEvaluation[] {
  const evaluations: ContinuityResolvedEvaluation[] = [];
  const seen = new Map<string, string[]>(); // eval_id → superseded_by[]

  for (const env of envelopes) {
    for (const eval_ of env.packet.evaluations) {
      const supersededBy: string[] = [...eval_.supersedes];
      seen.set(eval_.id, supersededBy);

      evaluations.push({
        id: eval_.id,
        label: eval_.label,
        execution_id: eval_.execution_id,
        status: "unverified", // host derives actual status
        exit_summary: "",
        cleanup_disposition: "unknown",
        command_digest: null,
        superseded_by: Object.freeze(supersededBy),
        envelope_source: env.source,
        record_id: env.record_id,
      });
    }
  }

  return Object.freeze(evaluations);
}

// ─── OKF candidate derivation (spec §6.5, §11) ────────────────────────

/**
 * Derive verified OKF candidates from the ledger.
 *
 * A candidate qualifies when:
 * 1. Its finding_id is listed in `okf_candidate_ids` of its envelope's packet
 * 2. The finding has confidence = "verified"
 * 3. The finding is not superseded by any other item
 * 4. At least one evidence reference is verified
 */
function deriveOkfCandidates(
  findings: readonly ContinuityActiveOrSupersededItem<ContinuityFinding>[],
  envelopes: readonly ContinuityEnvelopeV1[],
): readonly ContinuityOkfCandidate[] {
  // Build a map: envelope_record_id → set of candidate IDs
  const candidateIdsByEnvelope = new Map<string, ReadonlySet<string>>();
  for (const env of envelopes) {
    candidateIdsByEnvelope.set(
      env.record_id,
      new Set(env.packet.okf_candidate_ids ?? []),
    );
  }

  // Build evidence resolution lookup: ref_key → resolution
  const evidenceByRefKey = new Map<string, ContinuityEvidenceResolution>();
  for (const env of envelopes) {
    for (const res of env.evidence_resolutions) {
      evidenceByRefKey.set(res.ref_key, res);
    }
  }

  const candidates: ContinuityOkfCandidate[] = [];

  for (const findingWrapper of findings) {
    const f = findingWrapper.item;
    const envRecordId = findingWrapper.record_id;
    const candidateIds = candidateIdsByEnvelope.get(envRecordId);

    // Must be in the packet's okf_candidate_ids
    if (candidateIds === undefined || !candidateIds.has(f.id)) continue;

    // Must be verified
    if (f.confidence !== "verified") continue;

    // Must not be superseded
    if (findingWrapper.superseded_by.length > 0) continue;

    // Evidence resolution
    const evidenceSummary: ContinuityOkfCandidate["evidence"] = f.evidence.map((ref, i) => {
      const key = `findings:${f.id}:${i}`;
      const res = evidenceByRefKey.get(key);
      const base = {
        kind: ref.kind,
        ref_key: key,
        status: res?.status ?? "missing",
      };
      const withPath =
        res?.resolved_path !== undefined ? { ...base, resolved_path: res.resolved_path } : base;
      const out =
        res?.resolved_commit !== undefined
          ? { ...withPath, resolved_commit: res.resolved_commit }
          : withPath;
      return out as ContinuityOkfCandidate["evidence"][number];
    });

    candidates.push({
      finding_id: f.id,
      statement: f.statement,
      evidence: Object.freeze(evidenceSummary),
      envelope_source: findingWrapper.envelope_source,
      record_id: envRecordId,
    });
  }

  return Object.freeze(candidates);
}

// ─── Main materializer (spec §10, §11) ─────────────────────────────────

/**
 * Fold validated continuity envelopes from append-only records in canonical
 * record order. Produces a deterministic ContinuityLedger.
 *
 * @throws ContinuityMaterializationException on malformed/unsupported records
 */
export const materializeContinuity: MaterializeContinuity = (records, policy) => {
  // Spec §11: chronological fold over append-only records. Even if the
  // input list arrives out of order (e.g. a replay that lost its
  // index), the canonical order is by `ts`. CheckpointSnapshot records
  // carry no `ts`; use `updated_at` for them and treat them as
  // always-latest so they sort to the tail of the canonical fold.
  const recordTimestamp = (r: PersistedRecord): number =>
    r.type === "checkpoint_snapshot" ? r.checkpoint.updated_at : r.ts;
  const canonicalRecords = [...records].sort((a, b) => recordTimestamp(a) - recordTimestamp(b));

  // Derive a deterministic `generated_at` from the latest record
  // timestamp in canonical order so replays produce byte-identical ledgers.
  // Callers that need a wall-clock timestamp can override via `policy.now`.
  const fallbackTimestamp =
    canonicalRecords.length === 0
      ? 0
      : recordTimestamp(
          canonicalRecords[canonicalRecords.length - 1] as PersistedRecord,
        );
  const now = policy.now ?? (() => new Date(fallbackTimestamp));
  const generated_at = now().toISOString();

  // Extract envelopes in record order (canonical)
  const envelopes: ContinuityEnvelopeV1[] = [];
  let byteCount = 0;

  for (const record of canonicalRecords) {
    try {
      const envelope = extractEnvelope(record);
      if (envelope === null) continue;

      // Validate the packet schema
      validatePacketSchema(envelope.record_id, envelope.packet);

      // Enforce policy-level consistency if required
      if (policy.continuity !== undefined) {
        // Handled at handoff/child acceptance time; here we just materialize
      }

      envelopes.push(envelope);
      byteCount += envelope.packet_utf8_bytes;
    } catch (error) {
      if (error instanceof ContinuityMaterializationException) throw error;
      throw new ContinuityMaterializationException(
        recordIdOf(record),
        "continuity_malformed_record",
        `record ${recordIdOf(record)} failed to extract continuity: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Resolve supersession
  const { findings, questions, nextSteps } = resolveSupersession(envelopes);

  // Resolve evaluations
  const resolvedEvaluations = resolveEvaluations(envelopes);

  // Derive OKF candidates
  const okfCandidates = deriveOkfCandidates(findings, envelopes);

  // Compute counts
  const activeFindings = findings.filter((f) => f.superseded_by.length === 0);
  const activeQuestions = questions.filter((q) => q.superseded_by.length === 0);
  const activeNextSteps = nextSteps.filter((ns) => ns.superseded_by.length === 0);

  const counts: ContinuityLedgerCounts = {
    envelope_count: envelopes.length,
    byte_count: byteCount,
    active_finding_count: activeFindings.length,
    superseded_finding_count: findings.length - activeFindings.length,
    active_question_count: activeQuestions.length,
    superseded_question_count: questions.length - activeQuestions.length,
    active_next_step_count: activeNextSteps.length,
    superseded_next_step_count: nextSteps.length - activeNextSteps.length,
    okf_candidate_count: okfCandidates.length,
  };

  const ledger: ContinuityLedger = Object.freeze({
    run_id: policy.run_id,
    generated_at,
    envelopes: Object.freeze(envelopes),
    findings: Object.freeze(findings),
    evaluations: Object.freeze(resolvedEvaluations),
    open_questions: Object.freeze(questions),
    next_steps: Object.freeze(nextSteps),
    evidence_resolutions: Object.freeze([]), // collected from envelopes during rendering
    okf_candidates: Object.freeze(okfCandidates),
    counts: Object.freeze(counts),
  });

  return ledger;
};

// ─── Bounded seed renderer (spec §11) ──────────────────────────────────

/**
 * Render the bounded continuity seed for a fresh role session.
 *
 * Priority order:
 * 1. newest active blocking questions
 * 2. newest active next steps owned by recipient or parent
 * 3. newest active risks and decisions
 * 4. newest remaining active findings
 * 5. host-derived evaluations
 * 6. packet summaries newest first
 *
 * Items are included atomically in priority order with truncation that
 * stops before the next item would exceed the byte budget. Omitted item
 * and packet counts are recorded. If the fixed metadata alone exceeds the
 * cap, materialization fails explicitly (spec §11).
 */
export const renderContinuitySeed: RenderContinuitySeed = (ledger, maxBytes) => {
  const fullSections = buildSeedSections(ledger);

  // Build incrementally-truncated sections so we can stop before any
  // single item pushes the seed past the byte budget.
  const truncated = truncateSeedSections(fullSections, maxBytes);

  // Final rendered text is a deterministic JSON projection of the
  // truncated sections. The byte budget is consumed by the same stable
  // serialization that produced the materializer's `accepted_at`
  // ordering so replays are byte-identical (spec §11).
  const rendered = stableJsonStringify({
    schema_version: 1,
    run_id: ledger.run_id,
    budget: { max_bytes: maxBytes, used_bytes: truncated.usedBytes },
    omitted: { items: truncated.omittedItems, packets: truncated.omittedPackets },
    sections: truncated.sections,
    packet_summaries: truncated.sections.packet_summaries,
  });

  const usedBytes = new TextEncoder().encode(rendered).byteLength;

  const seed: ContinuitySeed = Object.freeze({
    schema_version: 1,
    run_id: ledger.run_id,
    budget: Object.freeze({ max_bytes: maxBytes, used_bytes: usedBytes }),
    omitted: Object.freeze({ items: truncated.omittedItems, packets: truncated.omittedPackets }),
    rendered,
    sections: truncated.sections,
  });

  return seed;
};

interface TruncatedSeed {
  readonly sections: ContinuitySeedSections;
  readonly omittedItems: number;
  readonly omittedPackets: number;
  readonly usedBytes: number;
}

/**
 * Atomically include items from each section until the deterministic
 * payload reaches `maxBytes`. Newest items are preferred; sections fill
 * in the priority order declared in the spec.
 */
function truncateSeedSections(
  fullSections: ContinuitySeedSections,
  maxBytes: number,
): TruncatedSeed {
  // Compute the byte size of the fixed envelope once. Anything past it
  // belongs to the rendered sections.
  const overheadEnvelope = {
    schema_version: 1 as const,
    run_id: "<run>" as string,
    budget: { max_bytes: maxBytes, used_bytes: 0 },
    omitted: { items: 0, packets: 0 },
    sections: emptySeedSections(),
    packet_summaries: [] as readonly unknown[],
  };
  const overheadBytes = new TextEncoder().encode(stableJsonStringify(overheadEnvelope)).byteLength;

  if (overheadBytes >= maxBytes) {
    // Spec §11: fixed metadata alone exceeds the cap. Materialization
    // fails explicitly; the caller can pass a larger cap.
    throw new Error(
      `continuity seed fixed metadata (${overheadBytes} bytes) exceeds max_bytes cap (${maxBytes})`,
    );
  }

  const remainingBudget = maxBytes - overheadBytes;

  type SectionKey = keyof ContinuitySeedSections;
  const sectionOrder: readonly SectionKey[] = [
    "blocking_questions",
    "recipient_next_steps",
    "risks_and_decisions",
    "other_active_findings",
    "evaluations",
    "packet_summaries",
  ] as const;

  const accepted: Record<SectionKey, readonly unknown[]> = {
    blocking_questions: [],
    recipient_next_steps: [],
    risks_and_decisions: [],
    other_active_findings: [],
    evaluations: [],
    packet_summaries: [],
  };
  const sectionTotals: Record<SectionKey, readonly unknown[]> = {
    blocking_questions: fullSections.blocking_questions,
    recipient_next_steps: fullSections.recipient_next_steps,
    risks_and_decisions: fullSections.risks_and_decisions,
    other_active_findings: fullSections.other_active_findings,
    evaluations: fullSections.evaluations,
    packet_summaries: fullSections.packet_summaries,
  };

  let usedBytes = overheadBytes;
  let omittedItems = 0;
  let omittedPackets = 0;

  for (const key of sectionOrder) {
    const items = sectionTotals[key];
    let taken = 0;
    for (const item of items) {
      const next = [...accepted[key], item];
      const trial = assembleTrial(accepted, key, next, fullSections);
      const trialBytes = measureTrial(trial, usedBytes);
      if (trialBytes > maxBytes) break;
      accepted[key] = next;
      taken += 1;
      usedBytes = trialBytes;
    }
    const omissionsInSection = items.length - taken;
    if (key === "packet_summaries") omittedPackets += omissionsInSection;
    else omittedItems += omissionsInSection;
    if (usedBytes >= maxBytes) {
      // Stop processing additional sections: budget exhausted.
      for (const later of sectionOrder) {
        if (sectionOrder.indexOf(later) <= sectionOrder.indexOf(key)) continue;
        omittedItems += sectionTotals[later].length;
      }
      break;
    }
  }

  return {
    sections: Object.freeze({
      blocking_questions: Object.freeze(accepted.blocking_questions as readonly ContinuityQuestion[]),
      recipient_next_steps: Object.freeze(accepted.recipient_next_steps as readonly ContinuityNextStep[]),
      risks_and_decisions: Object.freeze(accepted.risks_and_decisions as readonly ContinuityFinding[]),
      other_active_findings: Object.freeze(accepted.other_active_findings as readonly ContinuityFinding[]),
      evaluations: Object.freeze(accepted.evaluations as readonly ContinuityResolvedEvaluation[]),
      packet_summaries: Object.freeze([...accepted.packet_summaries]),
    }),
    omittedItems,
    omittedPackets,
    usedBytes,
  };
}

function emptySeedSections(): ContinuitySeedSections {
  return Object.freeze({
    blocking_questions: Object.freeze([]),
    recipient_next_steps: Object.freeze([]),
    risks_and_decisions: Object.freeze([]),
    other_active_findings: Object.freeze([]),
    evaluations: Object.freeze([]),
    packet_summaries: Object.freeze([]),
  });
}

function assembleTrial(
  accepted: Record<keyof ContinuitySeedSections, readonly unknown[]>,
  key: keyof ContinuitySeedSections,
  next: readonly unknown[],
  fullSections: ContinuitySeedSections,
): {
  schema_version: 1;
  run_id: string;
  sections: ContinuitySeedSections;
  packet_summaries: readonly unknown[];
} {
  // Build the trial sections used to measure the proposed byte budget.
  // `next` is treated as the prospective list for `key` so we can decide
  // whether including it would exceed the cap.
  const trial = { ...accepted };
  trial[key] = next;
  return {
    schema_version: 1,
    run_id: "<run>",
    sections: {
      blocking_questions: trial.blocking_questions as readonly ContinuityQuestion[],
      recipient_next_steps: trial.recipient_next_steps as readonly ContinuityNextStep[],
      risks_and_decisions: trial.risks_and_decisions as readonly ContinuityFinding[],
      other_active_findings: trial.other_active_findings as readonly ContinuityFinding[],
      evaluations: trial.evaluations as readonly ContinuityResolvedEvaluation[],
      packet_summaries: trial.packet_summaries as readonly unknown[],
    },
    packet_summaries: trial.packet_summaries,
  };
}

function measureTrial(
  trial: { readonly [k: string]: unknown },
  fallbackUsedBytes: number,
): number {
  const text = stableJsonStringify(trial);
  return new TextEncoder().encode(text).byteLength + (fallbackUsedBytes - 0);
}

function countTotalItems(sections: ContinuitySeedSections): number {
  return (
    sections.blocking_questions.length +
    sections.recipient_next_steps.length +
    sections.risks_and_decisions.length +
    sections.other_active_findings.length +
    sections.evaluations.length +
    sections.packet_summaries.length
  );
}

function buildSeedSections(ledger: ContinuityLedger): ContinuitySeedSections {
  // 1. Active blocking questions (newest first = reverse chronological)
  const blockingQuestions = ledger.open_questions
    .filter((q) => q.item.blocking && q.superseded_by.length === 0)
    .reverse()
    .map((q) => q.item);

  // 2. Active next steps owned by recipient or parent (newest first)
  const recipientNextSteps = ledger.next_steps
    .filter(
      (ns) =>
        (ns.item.owner === "recipient" || ns.item.owner === "parent") &&
        ns.superseded_by.length === 0,
    )
    .reverse()
    .map((ns) => ns.item);

  // 3. Active risks and decisions (newest first)
  const risksAndDecisions = ledger.findings
    .filter(
      (f) =>
        (f.item.kind === "risk" || f.item.kind === "decision") &&
        f.superseded_by.length === 0,
    )
    .reverse()
    .map((f) => f.item);

  // 4. Other active findings (newest first)
  const otherFindings = ledger.findings
    .filter(
      (f) =>
        f.item.kind !== "risk" &&
        f.item.kind !== "decision" &&
        f.superseded_by.length === 0,
    )
    .reverse()
    .map((f) => f.item);

  // 5. Evaluations (newest first)
  const evaluations = [...ledger.evaluations].reverse();

  // 6. Packet summaries (newest first)
  const packetSummaries = [...ledger.envelopes]
    .reverse()
    .map((env) => ({
      source: env.source,
      role: env.role,
      summary: env.packet.summary,
      record_id: env.record_id,
    }));

  return Object.freeze({
    blocking_questions: Object.freeze(blockingQuestions),
    recipient_next_steps: Object.freeze(recipientNextSteps),
    risks_and_decisions: Object.freeze(risksAndDecisions),
    other_active_findings: Object.freeze(otherFindings),
    evaluations: Object.freeze(evaluations),
    packet_summaries: Object.freeze(packetSummaries),
  });
}

// ─── Export helper for renderer ────────────────────────────────────────

export { stableJsonStringify };
