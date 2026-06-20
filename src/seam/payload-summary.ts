/**
 * `summarizePayload` — spec §11.2 payload-summary enrichment.
 *
 * `reduce` (the pure reducer) emits `transition_accepted` records with a
 * structural placeholder `payload_summary: { field_names: [] }` because the
 * reducer never inspects payload content (§3 / §12). The seam is the
 * declared writer that enriches the record with the real structural
 * fingerprint before the host persists it: the payload's top-level
 * `field_names` and a surfaced `reason` string (§5.1 — `reason` is the
 * free-form, machine-unbounded message channel a worker uses to talk to the
 * orchestrator; the machine stores it for observability and never branches
 * on it).
 *
 * `reason` is **unbounded by the machine**. Brevity is a prompt-convention
 * concern (each role's system prompt instructs the worker to keep its
 * `reason` concise), not an implementation detail — capping it at the seam
 * would risk dropping a verdict on a length technicality and couple the
 * contract to a tokenizer/word count. The orchestrator reads `reason` via
 * the run-memory `last_message` slot (§8.4).
 *
 * Pure. No I/O. No pi imports.
 */

import type { PayloadSummary } from "../core/types.js";

/**
 * Build a `PayloadSummary` from a shape-validated event payload: the
 * top-level field names (a stable structural fingerprint) plus a surfaced
 * `reason` string when the payload carries one.
 *
 * `suggests_next` is intentionally NOT extracted here — the reducer already
 * surfaces it at the top level of `TransitionAccepted` (`record.suggests_next`),
 * which is the single source the run-memory `last_message` reads. Duplicating
 * it into `payload_summary` would create two truths.
 */
export function summarizePayload(payload: unknown): PayloadSummary {
  if (typeof payload !== "object" || payload === null) {
    return Object.freeze({ field_names: Object.freeze([]) }) as PayloadSummary;
  }
  const obj = payload as Record<string, unknown>;
  const field_names = Object.freeze(Object.keys(obj)) as readonly string[];
  const reason = typeof obj.reason === "string" ? obj.reason : undefined;
  // `exactOptionalPropertyTypes`: include `reason` only when present as a
  // string; omit it otherwise (never assign `reason: undefined`).
  return reason !== undefined
    ? (Object.freeze({ reason, field_names }) as PayloadSummary)
    : (Object.freeze({ field_names }) as PayloadSummary);
}
