/** Semantic packet checks and stable serialization — durable-continuity spec §6. */
import type { ContinuityEvidenceResolution } from "../core/types.js";
import type { ContinuityPacketV1, EvidenceRef } from "../seam/continuity.js";
import type { ContinuityDiagnostic } from "./continuity-packet.js";
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
  /** Optional host-owned synchronous record authority for child tool capture. */
  readonly resolveEvidence?: (key: string, ref: EvidenceRef) => ContinuityEvidenceResolution;
  /**
   * Spec §5 / §8 / §9: the pinned `ContinuityPolicy` derived from the
   * current manifest. When `require_handoff` is true, every accepted
   * FSM handoff must carry a valid packet; when `require_delegated_result`
   * is true, every successful delegated `report_result` must carry a
   * valid packet. The host transport lanes read these flags to decide
   * whether a missing packet is a missing-required violation
   * (protocol-failure path) or simply absent on an optional policy.
   * `null` means no policy was pinned (legacy manifest behavior).
   */
  readonly policy: {
    readonly require_handoff: boolean;
    readonly require_delegated_result: boolean;
    readonly seed_max_utf8_bytes: number;
  } | null;
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
  errors.push(...validateUniqueIds(packet, ctx.knownItemIds));
  errors.push(...validateSupersession(packet, ctx.knownItemIds));
  errors.push(...validateFindingsConfidence(packet, ctx));
  errors.push(...validateEvaluations(packet, ctx));
  errors.push(...validateOkfCandidates(packet));
  return Object.freeze(errors);
}

function validateUniqueIds(
  packet: ContinuityPacketV1,
  knownItemIds: ReadonlySet<string>,
): readonly ContinuityDiagnostic[] {
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
      if (prior !== undefined || knownItemIds.has(item.id)) {
        errors.push({
          code: "continuity_packet_duplicate_ids",
          message:
            prior === undefined
              ? `duplicate continuity item id '${item.id}' already exists in this run`
              : `duplicate continuity item id '${item.id}' (already present in '${prior}')`,
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
  ])
    for (const item of collection) localIds.add(item.id);
  // The visibility set advances in packet order. This permits a new item
  // to supersede a genuinely earlier sibling, while rejecting a forward
  // sibling and every cross-run/unknown target.
  const visible = new Set(knownItemIds);
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
        if (!visible.has(target)) {
          errors.push({
            code: localIds.has(target)
              ? "continuity_supersedes_forward_reference"
              : "continuity_supersedes_missing_item",
            message: localIds.has(target)
              ? `item '${item.id}' supersedes '${target}' before it appears in this packet`
              : `item '${item.id}' supersedes unknown item '${target}'`,
            item_id: item.id,
            collection: collection.name,
          });
          continue;
        }
        if (!knownItemIds.has(target) && !localIds.has(target)) {
          errors.push({
            code: "continuity_supersedes_missing_item",
            message: `item '${item.id}' supersedes unknown item '${target}'`,
            item_id: item.id,
            collection: collection.name,
          });
        }
      }
      visible.add(item.id);
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
