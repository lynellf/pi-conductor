/**
 * `buildRunMemory` — spec §8.4 (run memory artifact).
 *
 * Fresh orchestrator sessions (one per orchestrator invocation) have
 * no built-in routing continuity. The driver maintains a run memory
 * artifact — a single structured record keyed by `run_id` — that each
 * fresh orchestrator session reads at startup. This is the
 * orchestrator's externalized memory: bounded, stable, parseable by
 * small models.
 *
 * The artifact is **structured, not prose**, so a small model can
 * parse and act on it consistently. The fields pinned by §8.4:
 *
 *   run_id, goal, current_role, state,
 *   visit_history: [{ role, visit_index, model, outcome, usage }],
 *   run_cost_to_date, run_cost_cap, remaining_budget,
 *   per_role_cost: { role: { tokens, cost } },
 *   next_candidates: [role]
 *
 * `open_concerns` is dropped for v1 (§8.4) — the machine does not
 * inspect payload content (§3), so no core code can populate it; a
 * free-form prose field would let a small model drift.
 *
 * **Single writer: the orchestrator only.** Workers write their
 * handoff payload; the orchestrator reads payloads, updates the
 * artifact, hands off. If workers could write memory, bilateral-
 * contract friction returns.
 *
 * **next_candidates rules (§8.4 + §7.4 + §11.7):**
 *  - Excludes workers that are visit-capped (`visit_count[W] >= max_visits[W]`).
 *  - Excludes ALL workers when `remaining_budget <= 0`. Cost-exclusion
 *    keys off the RUN budget, not lifetime worker spend: `max_session_cost_usd`
 *    is per-INVOCATION and shared across model fallbacks (§11.7), so it
 *    cannot gate candidacy across visits. The run budget is the only
 *    cost-relevant gate for candidacy.
 *  - When `runCostCap == null` (uncapped run), the cost gate is dropped;
 *    only visit caps gate candidacy.
 *  - When `current_role === "done"`, next_candidates is empty (terminal).
 *
 * Pure. No I/O, no pi imports.
 */

import { rollup } from "../cost/rollup.js";
import type { PersistedRecord } from "../persistence/log.js";
import type { Checkpoint, MachineDefinition, SessionLifecycleEvent } from "./types.js";

// ─── §8.4 shape ────────────────────────────────────────────────────────

/** Per-visit summary the orchestrator reads from `visit_history`. */
export interface VisitHistoryEntry {
  readonly role: string;
  readonly visit_index: number;
  readonly model: string | null;
  readonly outcome: "session_ended" | "session_failed";
  readonly usage: { readonly tokens: number; readonly cost: number };
}

/** Per-role cost summary the orchestrator reads from `per_role_cost`. */
export interface RoleCostEntry {
  readonly tokens: number;
  readonly cost: number;
}

/** §8.4 run memory artifact. */
export interface RunMemory {
  readonly run_id: string;
  readonly goal: string;
  readonly current_role: Checkpoint["current_role"];
  readonly state: Checkpoint["current_role"];
  readonly visit_history: readonly VisitHistoryEntry[];
  readonly run_cost_to_date: number;
  readonly run_cost_cap: number | null;
  readonly remaining_budget: number | null;
  readonly per_role_cost: Readonly<Record<string, RoleCostEntry>>;
  readonly next_candidates: readonly string[];
  // open_concerns intentionally absent (dropped for v1, §8.4).
}

/** Options for `buildRunMemory`. */
export interface BuildRunMemoryOptions {
  /** The initial goal the orchestrator is steering toward. */
  readonly goal: string;
  /** The run-level cost cap (`max_run_cost_usd`); null = uncapped. */
  readonly runCostCap: number | null;
}

// ─── Builder ────────────────────────────────────────────────────────────

export function buildRunMemory(
  checkpoint: Checkpoint,
  records: readonly PersistedRecord[],
  def: MachineDefinition,
  opts: BuildRunMemoryOptions,
): RunMemory {
  // §11.6 usage rollup keyed by run_id, with orchestrator overhead
  // isolated for the orchestrator-aware view. We use the rollup here
  // rather than re-deriving costs inline; the rollup is the single
  // source of truth for usage aggregation across the core.
  const r = rollup(records, checkpoint.run_id, def.orchestrator);

  // §8.4 visit_history: one entry per terminal lifecycle event. Both
  // session_ended and session_failed contribute (both terminals cost,
  // §11.4). visit_index + model + usage flow from the record.
  const visit_history = buildVisitHistory(records, checkpoint.run_id);

  // §8.4 per_role_cost: reduce the rollup's per-role aggregate into
  // the {tokens, cost} shape the spec pins (the rollup's per-role
  // shape includes more fields; the artifact is a focused subset).
  const per_role_cost: Record<string, RoleCostEntry> = {};
  for (const [role, agg] of Object.entries(r.perRole)) {
    per_role_cost[role] = Object.freeze({ tokens: agg.tokens, cost: agg.cost }) as RoleCostEntry;
  }

  // §8.4 / §11.7 cost fields.
  const run_cost_to_date = r.perRun.cost;
  const run_cost_cap = opts.runCostCap;
  const remaining_budget = opts.runCostCap === null ? null : opts.runCostCap - run_cost_to_date;

  // §8.4 / §7.4 next_candidates:
  //  - Excludes visit-capped workers.
  //  - Excludes ALL workers when remaining_budget <= 0.
  //  - Empty when current_role === "done".
  const next_candidates = computeNextCandidates(checkpoint, def, remaining_budget);

  return Object.freeze({
    run_id: checkpoint.run_id,
    goal: opts.goal,
    current_role: checkpoint.current_role,
    state: checkpoint.current_role,
    visit_history: Object.freeze([...visit_history]),
    run_cost_to_date,
    run_cost_cap,
    remaining_budget,
    per_role_cost: Object.freeze(per_role_cost),
    next_candidates: Object.freeze([...next_candidates]),
  }) as RunMemory;
}

// ─── Internals ──────────────────────────────────────────────────────────

function buildVisitHistory(
  records: readonly PersistedRecord[],
  runId: string,
): VisitHistoryEntry[] {
  const out: VisitHistoryEntry[] = [];
  for (const record of records) {
    // CheckpointSnapshot doesn't carry run_id directly — the wrapped
    // Checkpoint is the source of truth. Other record shapes carry
    // run_id at the top level.
    const recordRunId =
      record.type === "checkpoint_snapshot" ? record.checkpoint.run_id : record.run_id;
    if (recordRunId !== runId) continue;
    if (record.type !== "session_ended" && record.type !== "session_failed") continue;
    const ev: SessionLifecycleEvent = record;
    if (ev.usage === undefined) continue;
    out.push({
      role: ev.role,
      visit_index: ev.visit_index,
      model: ev.model,
      outcome: record.type,
      usage: Object.freeze({
        tokens: ev.usage.tokens,
        cost: ev.usage.cost,
      }) as VisitHistoryEntry["usage"],
    });
  }
  return out;
}

function computeNextCandidates(
  checkpoint: Checkpoint,
  def: MachineDefinition,
  remaining_budget: number | null,
): string[] {
  // Terminal state: no candidates. The machine is done; nothing to dispatch.
  if (checkpoint.current_role === "done") {
    return [];
  }

  // Cost gate (§11.7 + §8.4): when the run budget is exhausted
  // (remaining_budget <= 0), no candidate can be dispatched. This
  // keys off the run budget, NOT per-session caps (per-session caps
  // are per-invocation and cannot gate candidacy across visits).
  if (remaining_budget !== null && remaining_budget <= 0) {
    return [];
  }

  // Visit-cap gate (§7.4): drop workers at their cap. The orchestrator
  // has no cap (it doesn't appear in `def.max_visits`).
  const out: string[] = [];
  for (const w of def.workers) {
    const cap = def.max_visits[w];
    if (cap === undefined) {
      // Defensive: validateManifest ensures every worker has a finite cap.
      // A missing cap means a corrupted def; skip rather than throw
      // (buildRunMemory is a read query for the host's seeder).
      continue;
    }
    const count = checkpoint.visit_count[w] ?? 0;
    if (count < cap) {
      out.push(w);
    }
  }
  return out;
}
