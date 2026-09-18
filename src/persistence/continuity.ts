/**
 * Pure durable-continuity contracts — spec §6, §10, §11.
 *
 * Pure module. No I/O. No pi imports. This is the single source of
 * truth for:
 *  - packet normalization + UTF-8 byte measurement
 *  - stable diagnostic codes for packet validation
 *  - continuity envelope shape (host-derived provenance + packet)
 *  - evidence resolution shape (declarative; the actual lookup API
 *    lives in `src/host/continuity-evidence.ts` so the host can wire
 *    its durable lookups without pi-leaking into pure modules)
 *  - ledger and bounded-seed types
 *  - the narrow materializer / renderer signatures consumed by host
 *    and CLI lanes
 *  - the additive child-continuity sibling type that both transport
 *    lanes persist on durable records (spec §8, §9, §10)
 *
 * Implementation of the chronological materializer, deterministic
 * bounded seed selection, and renderers lives in
 * `src/persistence/continuity-materialization.ts` and
 * `src/persistence/continuity-render.ts` (Lane C, dispatched later).
 */

import type { Static } from "typebox";
import type { ContinuityEvidenceResolution, Role } from "../core/types.js";
import { CONTINUITY_CONSTRAINTS, type ContinuityPacketV1 } from "../seam/continuity.js";
import type { continuitySiblingSchema } from "./delegation-lifecycle-schema.js";
import type { PersistedRecord } from "./log.js";

// ─── Stable diagnostic codes (spec §6, §7, §11, §14) ──────────────────

/** Stable reason a packet fails host-side acceptance. */
export type ContinuityDiagnosticCode =
  | "continuity_packet_not_object"
  | "continuity_packet_wrong_schema_version"
  | "continuity_packet_too_large"
  | "continuity_packet_duplicate_ids"
  | "continuity_supersedes_forward_reference"
  | "continuity_supersedes_missing_item"
  | "continuity_supersedes_self_reference"
  | "continuity_supersedes_cycle"
  | "continuity_verified_requires_resolved_evidence"
  | "continuity_okf_candidate_unknown"
  | "continuity_okf_candidate_not_verified"
  | "continuity_okf_candidate_superseded"
  | "continuity_evaluations_outside_run_authority"
  | "continuity_evaluations_cross_run"
  | "continuity_summary_out_of_bounds"
  | "continuity_evidence_audience_denied"
  | "continuity_evidence_cross_run"
  | "continuity_unsupported_version"
  | "continuity_malformed_record";

export interface ContinuityDiagnostic {
  readonly code: ContinuityDiagnosticCode;
  readonly message: string;
  readonly item_id?: string;
  readonly collection?: string;
}

/** Typed rejection of a packet at the seam. Carries bounded diagnostics. */
export class ContinuityValidationError extends Error {
  readonly diagnostics: readonly ContinuityDiagnostic[];
  constructor(diagnostics: readonly ContinuityDiagnostic[]) {
    const summary = diagnostics.map((d) => d.message).join("; ");
    super(`continuity packet rejected: ${summary}`);
    this.name = "ContinuityValidationError";
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

// ─── Normalization + measurement (spec §6, §8, §9) ─────────────────────

/** Public byte-budget constants mirrored for pure callers. */
export const CONTINUITY_MAX_PACKET_BYTES = CONTINUITY_CONSTRAINTS.MAX_PACKET_BYTES;

/**
 * Deterministically normalize a packet value into its JSON-safe form
 * and measure the resulting UTF-8 byte length. The output is byte-
 * identical across runs and replays so the materializer is stable.
 *
 * A raw string input is treated as the canonical form itself: a
 * pre-serialized packet read from the record log should not be
 * re-encoded (which would add JSON quotes and inflate the byte
 * count past the 32 KiB budget). Any other input is canonicalized
 * with sorted keys via `stableJsonStringify`.
 */
export function normalizeAndMeasurePacket(value: unknown): {
  readonly compact: string;
  readonly bytes: number;
} {
  const compact = typeof value === "string" ? value : stableJsonStringify(value);
  const bytes = new TextEncoder().encode(compact).byteLength;
  return { compact, bytes };
}

/** Stable JSON serialization for byte measurement. Object keys sorted. */
export function stableJsonStringify(value: unknown): string {
  return stringifyStable(value, new WeakSet<object>());
}

function stringifyStable(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("continuity packet value must be JSON-safe (no NaN/Infinity)");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value !== "object") {
    throw new TypeError("continuity packet contains non-JSON-safe value");
  }
  if (ancestors.has(value)) {
    throw new TypeError("continuity packet contains a cycle");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const parts: string[] = [];
      for (const item of value) parts.push(stringifyStable(item, ancestors));
      return `[${parts.join(",")}]`;
    }
    const obj = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(obj);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("continuity packet contains non-plain object value");
    }
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      parts.push(`${JSON.stringify(key)}:${stringifyStable(obj[key], ancestors)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

// ─── Semantic packet validation (spec §6.2, §6.3, §6.4, §6.5) ──────────

export interface PacketValidationContext {
  /** Earlier item IDs already present in the current ledger (handoff-time). */
  readonly knownItemIds: ReadonlySet<string>;
  /** Execution IDs verified as belonging to the same run. */
  readonly verifiedExecutionIds: ReadonlySet<string>;
  /** Whether the resolved evidence for this packet is verified-or-declared. */
  readonly evidenceVerifiedByKey: ReadonlyMap<string, ContinuityEvidenceResolution>;
}

/**
 * Validate the semantic packet constraints the TypeBox schema does not
 * pin: duplicate IDs, supersession topology, verified-confidence evidence,
 * OKF candidate references, evaluation execution authority. Returns
 * diagnostics (empty list means the packet passes).
 */
export function validatePacketSemantics(
  packet: ContinuityPacketV1,
  ctx: PacketValidationContext,
): readonly ContinuityDiagnostic[] {
  const errors: ContinuityDiagnostic[] = [];
  errors.push(...validateUniqueIds(packet));
  errors.push(...validateSupersession(packet, ctx.knownItemIds));
  errors.push(...validateFindingsConfidence(packet, ctx));
  errors.push(...validateEvaluations(packet, ctx));
  errors.push(...validateOkfCandidates(packet));
  return Object.freeze(errors);
}

function validateUniqueIds(packet: ContinuityPacketV1): readonly ContinuityDiagnostic[] {
  const seen = new Map<string, "findings" | "evaluations" | "open_questions" | "next_steps">();
  const errors: ContinuityDiagnostic[] = [];
  const collections: { readonly name: string; readonly items: readonly { id: string }[] }[] = [
    { name: "findings", items: packet.findings },
    { name: "evaluations", items: packet.evaluations },
    { name: "open_questions", items: packet.open_questions },
    { name: "next_steps", items: packet.next_steps },
  ];
  for (const { name, items } of collections) {
    for (const item of items) {
      const prior = seen.get(item.id);
      if (prior !== undefined) {
        errors.push({
          code: "continuity_packet_duplicate_ids",
          message: `duplicate continuity item id '${item.id}' (already present in '${prior}')`,
          item_id: item.id,
          collection: name,
        });
        continue;
      }
      seen.set(item.id, name as "findings" | "evaluations" | "open_questions" | "next_steps");
    }
  }
  return errors;
}

function validateSupersession(
  packet: ContinuityPacketV1,
  knownItemIds: ReadonlySet<string>,
): readonly ContinuityDiagnostic[] {
  const errors: ContinuityDiagnostic[] = [];
  const localIds = new Set<string>();
  for (const collection of [
    packet.findings,
    packet.evaluations,
    packet.open_questions,
    packet.next_steps,
  ]) {
    for (const item of collection) localIds.add(item.id);
  }
  for (const collection of [
    { name: "findings", items: packet.findings },
    { name: "evaluations", items: packet.evaluations },
    { name: "open_questions", items: packet.open_questions },
    { name: "next_steps", items: packet.next_steps },
  ]) {
    for (const item of collection.items) {
      for (const target of item.supersedes) {
        if (target === item.id) {
          errors.push({
            code: "continuity_supersedes_self_reference",
            message: `item '${item.id}' lists itself in supersedes`,
            item_id: item.id,
            collection: collection.name,
          });
          continue;
        }
        if (localIds.has(target)) {
          errors.push({
            code: "continuity_supersedes_forward_reference",
            message: `item '${item.id}' supersedes '${target}' which is also new in this packet`,
            item_id: item.id,
            collection: collection.name,
          });
          continue;
        }
        if (!knownItemIds.has(target)) {
          errors.push({
            code: "continuity_supersedes_missing_item",
            message: `item '${item.id}' supersedes unknown item '${target}'`,
            item_id: item.id,
            collection: collection.name,
          });
        }
      }
    }
  }
  // Cycle detection: supersedes must point at strictly earlier items, so
  // localId-vs-supersedes forms a DAG by construction. The only cycle
  // possibility is two items in the same packet both referencing each
  // other; that case is captured by `continuity_supersedes_forward_reference`
  // when one is a localId, and remains detectable as a duplicate-of-self
  // when both are local and mutually superseding. Both cases close.
  return errors;
}

function validateFindingsConfidence(
  packet: ContinuityPacketV1,
  ctx: PacketValidationContext,
): readonly ContinuityDiagnostic[] {
  const errors: ContinuityDiagnostic[] = [];
  packet.findings.forEach((finding, index) => {
    if (finding.confidence !== "verified") return;
    if (finding.evidence.length === 0) {
      errors.push({
        code: "continuity_verified_requires_resolved_evidence",
        message: `finding '${finding.id}' claims verified confidence without evidence`,
        item_id: finding.id,
        collection: "findings",
      });
      return;
    }
    const allVerified = finding.evidence.every((_ref, offset) => {
      const key = `findings:${finding.id}:${offset}`;
      return ctx.evidenceVerifiedByKey.get(key)?.status === "verified";
    });
    if (!allVerified) {
      errors.push({
        code: "continuity_verified_requires_resolved_evidence",
        message: `finding '${finding.id}' claims verified confidence but at least one evidence reference is not verified`,
        item_id: finding.id,
        collection: "findings",
      });
    }
    if (index < 0) {
      // Defensive: index never negative. Saturate the type for downstream
      // noUnusedParameters compliance.
      void index;
    }
  });
  return errors;
}

function validateEvaluations(
  packet: ContinuityPacketV1,
  ctx: PacketValidationContext,
): readonly ContinuityDiagnostic[] {
  const errors: ContinuityDiagnostic[] = [];
  for (const evaluation of packet.evaluations) {
    if (!ctx.verifiedExecutionIds.has(evaluation.execution_id)) {
      errors.push({
        code: "continuity_evaluations_cross_run",
        message: `evaluation '${evaluation.id}' references execution '${evaluation.execution_id}' that is not verified in this run`,
        item_id: evaluation.id,
        collection: "evaluations",
      });
    }
  }
  return errors;
}

function validateOkfCandidates(packet: ContinuityPacketV1): readonly ContinuityDiagnostic[] {
  const errors: ContinuityDiagnostic[] = [];
  const findingsById = new Map<
    string,
    { finding: (typeof packet.findings)[number]; index: number }
  >();
  packet.findings.forEach((finding, index) => {
    findingsById.set(finding.id, { finding, index });
  });
  const supersededLocal = new Set<string>();
  for (const finding of packet.findings) {
    for (const target of finding.supersedes) supersededLocal.add(target);
  }
  const seen = new Set<string>();
  for (const candidate of packet.okf_candidate_ids) {
    if (seen.has(candidate)) {
      errors.push({
        code: "continuity_okf_candidate_unknown",
        message: `okf candidate id '${candidate}' is repeated`,
        item_id: candidate,
        collection: "okf_candidate_ids",
      });
      continue;
    }
    seen.add(candidate);
    const located = findingsById.get(candidate);
    if (located === undefined) {
      errors.push({
        code: "continuity_okf_candidate_unknown",
        message: `okf candidate id '${candidate}' does not name a finding in this packet`,
        item_id: candidate,
        collection: "okf_candidate_ids",
      });
      continue;
    }
    if (located.finding.confidence !== "verified") {
      errors.push({
        code: "continuity_okf_candidate_not_verified",
        message: `okf candidate '${candidate}' is not a verified finding`,
        item_id: candidate,
        collection: "okf_candidate_ids",
      });
    }
    if (supersededLocal.has(candidate)) {
      errors.push({
        code: "continuity_okf_candidate_superseded",
        message: `okf candidate '${candidate}' is superseded by another finding in this packet`,
        item_id: candidate,
        collection: "okf_candidate_ids",
      });
    }
  }
  return errors;
}

// ─── Host-derived envelope shape (spec §10) ────────────────────────────

/** Source distinguishing the durable envelope. */
export type ContinuityEnvelopeSource = "handoff" | "delegated_result";

/** Bounded host-authored child provenance for `delegated_result` envelopes. */
export interface ContinuityChildProvenance {
  readonly child_id: string;
  readonly subagent: string;
  readonly task_id: string;
  readonly attempt: number;
}

/** Normalized continuity envelope materialized from durable records. */
export interface ContinuityEnvelopeV1 {
  readonly schema_version: 1;
  readonly source: ContinuityEnvelopeSource;
  readonly record_id: string;
  readonly run_id: string;
  readonly role: Role;
  readonly visit: number;
  readonly child?: ContinuityChildProvenance;
  readonly accepted_at: string;
  readonly packet_utf8_bytes: number;
  readonly packet: ContinuityPacketV1;
  readonly evidence_resolutions: readonly ContinuityEvidenceResolution[];
}

/**
 * Spec §9 / §10: additive host-authored continuity sibling persisted on
 * successful child completion records. Derived from the TypeBox schema in
 * `delegation-lifecycle-schema.ts` so the durable record shape stays in
 * one place. The surrounding `subagent_completed` record remains the
 * source of run/parent/child/task/attempt provenance — never the child.
 */
export type ChildContinuitySibling = Static<typeof continuitySiblingSchema>;

// ─── Materialized ledger + bounded seed (spec §11) ──────────────────────

/** Bounded, deterministic projection of the run's continuity envelopes. */
export interface ContinuityLedger {
  readonly run_id: string;
  readonly generated_at: string;
  readonly envelopes: readonly ContinuityEnvelopeV1[];
  readonly findings: readonly ContinuityActiveOrSupersededItem[];
  readonly evaluations: readonly ContinuityResolvedEvaluation[];
  readonly open_questions: readonly ContinuityActiveOrSupersededItem[];
  readonly next_steps: readonly ContinuityActiveOrSupersededItem[];
  readonly evidence_resolutions: readonly ContinuityEvidenceResolution[];
  readonly okf_candidates: readonly ContinuityOkfCandidate[];
  readonly counts: ContinuityLedgerCounts;
}

export interface ContinuityLedgerCounts {
  readonly envelope_count: number;
  readonly byte_count: number;
  readonly active_finding_count: number;
  readonly superseded_finding_count: number;
  readonly active_question_count: number;
  readonly superseded_question_count: number;
  readonly active_next_step_count: number;
  readonly superseded_next_step_count: number;
  readonly okf_candidate_count: number;
}

/** Generic active-or-superseded item shape reused for findings/questions/next-steps. */
export interface ContinuityActiveOrSupersededItem<T = unknown> {
  readonly item: T;
  readonly superseded_by: readonly string[];
  readonly envelope_source: ContinuityEnvelopeSource;
  readonly record_id: string;
}

/** Host-derived evaluation outcome (spec §6.3: model cannot supply). */
export interface ContinuityResolvedEvaluation {
  readonly id: string;
  readonly label: string;
  readonly execution_id: string;
  readonly status: "passed" | "failed" | "incomplete" | "unverified";
  readonly exit_summary: string;
  readonly cleanup_disposition: "confirmed" | "unconfirmed" | "unknown";
  readonly command_digest: string | null;
  readonly superseded_by: readonly string[];
  readonly envelope_source: ContinuityEnvelopeSource;
  readonly record_id: string;
}

/** Verified OKF candidate projection (spec §6.5). */
export interface ContinuityOkfCandidate {
  readonly finding_id: string;
  readonly statement: string;
  readonly evidence: readonly {
    readonly kind: ContinuityEvidenceResolution["kind"];
    readonly ref_key: string;
    readonly status: ContinuityEvidenceResolution["status"];
    readonly resolved_path?: string;
    readonly resolved_commit?: string;
  }[];
  readonly envelope_source: ContinuityEnvelopeSource;
  readonly record_id: string;
}

/** Bounded materializer seed (spec §11) injected into fresh role memory. */
export interface ContinuitySeed {
  readonly schema_version: 1;
  readonly run_id: string;
  readonly budget: {
    readonly max_bytes: number;
    readonly used_bytes: number;
  };
  readonly omitted: {
    readonly items: number;
    readonly packets: number;
  };
  readonly rendered: string;
  /** Stable JSON projection used by `renderContinuitySeed` callers. */
  readonly sections: ContinuitySeedSections;
}

export interface ContinuitySeedSections {
  readonly blocking_questions: readonly unknown[];
  readonly recipient_next_steps: readonly unknown[];
  readonly risks_and_decisions: readonly unknown[];
  readonly other_active_findings: readonly unknown[];
  readonly evaluations: readonly ContinuityResolvedEvaluation[];
  readonly packet_summaries: readonly unknown[];
}

// ─── Materializer + renderer signatures (spec §11) ─────────────────────

/**
 * Fold validated envelopes in canonical record order. Pure over the
 * record log and the resolved evidence map; filesystem/network
 * resolution happens before this call. Implementations live in
 * `src/persistence/continuity-materialization.ts`.
 */
export type MaterializeContinuity = (
  records: readonly PersistedRecord[],
  policy: ContinuityMaterializationPolicy,
) => ContinuityLedger;

export interface ContinuityMaterializationPolicy {
  readonly run_id: string;
  /** Policy supplied from the pinned manifest snapshot; absent = no policy. */
  readonly continuity?: {
    readonly schema_version: 1;
    readonly require_handoff: boolean;
    readonly require_delegated_result: boolean;
    readonly seed_max_utf8_bytes: number;
  };
  /** Optional caller-supplied current time; null uses record timestamps. */
  readonly now?: () => Date;
}

/**
 * Render the bounded seed for a fresh role session. Atomic truncation:
 * the byte budget is consumed item-by-item and the function records the
 * omitted counts. Byte-identical across replays of the same ledger.
 */
export type RenderContinuitySeed = (ledger: ContinuityLedger, maxBytes: number) => ContinuitySeed;

// ─── Stable textual seed builders (used by the renderer) ──────────────

/** Escape a continuity text value for safe Markdown rendering (spec §14). */
export function escapeMarkdownText(text: string): string {
  // Conservative escape: keep newlines for readability but escape the
  // Markdown control characters that can flip a paragraph into a
  // heading, list, link, code span, or HTML block. Parentheses are
  // escaped because the inline-link syntax `[text](url)` would
  // otherwise render as a clickable link in downstream consumers.
  return text.replace(/([\\`*_[\](){}<>!#|])/g, "\\$1");
}

/** Stable evidence key namespace used by both lanes. */
export function evidenceRefKey(
  collection: "findings" | "evaluations" | "open_questions" | "next_steps",
  itemId: string,
  index: number,
): string {
  return `${collection}:${itemId}:${index}`;
}

/** Stable OKF candidate key for record→ledger mapping. */
export function okfCandidateKey(envelope: ContinuityEnvelopeV1, findingId: string): string {
  return `${envelope.record_id}:${findingId}`;
}
