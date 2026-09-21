/** Bounded atomic fresh-session seed — durable-continuity spec §11. */
import type {
  ContinuityFinding,
  ContinuityNextStep,
  ContinuityQuestion,
} from "../seam/continuity.js";
import type {
  ContinuityLedger,
  ContinuityResolvedEvaluation,
  ContinuitySeedSections,
  RenderContinuitySeed,
} from "./continuity.js";
import { stableJsonStringify } from "./continuity.js";
import type { HostEvidenceSeedItem } from "./handoff-evidence-seed.js";

type Key = keyof ContinuitySeedSections;
type Candidate = { readonly key: Key; readonly value: unknown; readonly packet: boolean };
const encoder = new TextEncoder();

/** Render a seed by measuring the exact final serialized bytes on every atomic admission. */
export const renderContinuitySeed: RenderContinuitySeed = (ledger, maxBytes) => {
  const all = candidates(ledger);
  const accepted: Record<Key, unknown[]> = empty();
  let admitted = 0;
  for (const candidate of all) {
    accepted[candidate.key].push(candidate.value);
    const rendered = serialize(ledger.run_id, maxBytes, accepted, omissions(all, admitted + 1));
    if (encoder.encode(rendered).byteLength > maxBytes) {
      accepted[candidate.key].pop();
      break;
    }
    admitted += 1;
  }
  const omitted = omissions(all, admitted);
  const rendered = serialize(ledger.run_id, maxBytes, accepted, omitted);
  const used = encoder.encode(rendered).byteLength;
  if (used > maxBytes)
    throw new Error(`continuity seed fixed metadata exceeds max_bytes cap (${maxBytes})`);
  return Object.freeze({
    schema_version: 1,
    run_id: ledger.run_id,
    budget: Object.freeze({ max_bytes: maxBytes, used_bytes: used }),
    omitted: Object.freeze(omitted),
    rendered,
    sections: freeze(accepted),
  });
};
function candidates(ledger: ContinuityLedger): readonly Candidate[] {
  const active = <T>(
    entries: readonly { readonly item: T; readonly superseded_by: readonly string[] }[],
  ) =>
    entries
      .filter((entry) => entry.superseded_by.length === 0)
      .reverse()
      .map((entry) => entry.item);
  const output: Candidate[] = [];
  for (const value of active(ledger.open_questions).filter(
    (item): item is ContinuityQuestion => item.blocking,
  ))
    output.push({ key: "blocking_questions", value, packet: false });
  for (const value of active(ledger.next_steps).filter(
    (item): item is ContinuityNextStep => item.owner === "recipient" || item.owner === "parent",
  ))
    output.push({ key: "recipient_next_steps", value, packet: false });
  for (const value of active(ledger.findings).filter(
    (item): item is ContinuityFinding => item.kind === "risk" || item.kind === "decision",
  ))
    output.push({ key: "risks_and_decisions", value, packet: false });
  for (const value of active(ledger.findings).filter(
    (item): item is ContinuityFinding => item.kind !== "risk" && item.kind !== "decision",
  ))
    output.push({ key: "other_active_findings", value, packet: false });
  for (const value of [...ledger.evaluations].reverse())
    output.push({ key: "evaluations", value, packet: false });
  for (const envelope of [...ledger.envelopes].reverse())
    output.push({
      key: "packet_summaries",
      value: {
        source: envelope.source,
        role: envelope.role,
        record_id: envelope.record_id,
        summary: envelope.packet.summary,
      },
      packet: true,
    });
  // Host-observed evidence is projected last so it is only dropped once every
  // deterministic continuity item has been admitted — it is never the first
  // thing silenced by the byte budget (plan bounds).
  for (const item of ledger.host_evidence ?? [])
    output.push({ key: "host_evidence", value: item, packet: false });
  return Object.freeze(output);
}
function empty(): Record<Key, unknown[]> {
  return {
    blocking_questions: [],
    recipient_next_steps: [],
    risks_and_decisions: [],
    other_active_findings: [],
    evaluations: [],
    packet_summaries: [],
    host_evidence: [],
  };
}
function omissions(
  all: readonly Candidate[],
  admitted: number,
): { items: number; packets: number } {
  let items = 0;
  let packets = 0;
  for (const candidate of all.slice(admitted)) {
    if (candidate.packet) packets += 1;
    else items += 1;
  }
  return { items, packets };
}
function serialize(
  runId: string,
  maxBytes: number,
  sections: Record<Key, unknown[]>,
  omitted: { items: number; packets: number },
): string {
  let used = 0;
  // `used_bytes` itself changes the serialized length at decimal boundaries.
  // Iterate to the fixed point, which is bounded by the decimal width.
  for (let attempt = 0; attempt < 16; attempt += 1) {
    // When no evidence item is admitted, omit the key entirely so the rendered
    // seed is byte-identical to the v2 baseline, which never emitted an
    // evidence section. The baseline serializes exactly six section keys.
    const serializedSections =
      sections.host_evidence.length > 0 ? sections : omitHostEvidence(sections);
    const text = stableJsonStringify({
      schema_version: 1,
      run_id: runId,
      budget: { max_bytes: maxBytes, used_bytes: used },
      omitted,
      sections: serializedSections,
      packet_summaries: serializedSections.packet_summaries,
    });
    const measured = encoder.encode(text).byteLength;
    if (measured === used) return text;
    used = measured;
  }
  throw new Error("continuity seed byte accounting did not converge");
}

/**
 * Copy `sections` without the `host_evidence` key. The cast is sound: the
 * rest object carries every key that was present (none, here), and an empty
 * evidence section must not alter the serialized seed bytes.
 */
function omitHostEvidence(
  sections: Record<Key, unknown[]>,
): Record<Exclude<Key, "host_evidence">, unknown[]> {
  const { host_evidence: _host_evidence, ...rest } = sections;
  return rest as Record<Exclude<Key, "host_evidence">, unknown[]>;
}
function freeze(sections: Record<Key, unknown[]>): ContinuitySeedSections {
  return Object.freeze({
    blocking_questions: Object.freeze([...sections.blocking_questions]),
    recipient_next_steps: Object.freeze([...sections.recipient_next_steps]),
    risks_and_decisions: Object.freeze([...sections.risks_and_decisions]),
    other_active_findings: Object.freeze([...sections.other_active_findings]),
    evaluations: Object.freeze([
      ...sections.evaluations,
    ]) as readonly ContinuityResolvedEvaluation[],
    packet_summaries: Object.freeze([...sections.packet_summaries]),
    ...(sections.host_evidence.length > 0
      ? {
          host_evidence: Object.freeze([
            ...sections.host_evidence,
          ]) as readonly HostEvidenceSeedItem[],
        }
      : {}),
  });
}
