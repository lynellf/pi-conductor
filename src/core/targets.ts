/**
 * Cap-aware vs cap-unaware legal-target helpers — spec §7.2 / §7.4.
 *
 * Split into two helpers so the cap-evaluation site is explicit:
 *   - `declaredTargets(state, def)` — the uniform table (§7.2) ignoring caps.
 *     Used by callers that want the full declared topology (e.g. UI hints,
 *     schema documentation). Never used by the reducer for legality.
 *   - `availableTargets(checkpoint, def)` — same, with the visit-cap guard
 *     applied (§7.4). Used by the reducer to build `legal_targets` on a
 *     `transition_rejected` record (§11.3) so retry guidance is cap-aware.
 *
 * Pure. No mutation, no I/O. Both return frozen result objects so callers
 * can safely cache/store them.
 */

import type { Checkpoint, LegalTargets, MachineDefinition, Role } from "./types.js";

/**
 * The uniform transition table (§7.2) ignoring visit caps.
 *
 * - From the orchestrator: every declared worker is a legal handoff
 *   target; `end` is legal in legacy mode.
 * - From any worker: the orchestrator is the only legal handoff target;
 *   `end` is illegal.
 * - From `done`: nothing is legal (terminal).
 */
export function declaredTargets(state: Role | "done", def: MachineDefinition): LegalTargets {
  if (state === "done") {
    return { handoff: Object.freeze([]), end: false };
  }
  if (state === def.orchestrator) {
    return { handoff: Object.freeze([...def.workers]), end: def.end_request_roles === null };
  }
  // Worker → orchestrator only; `end` is illegal from a worker.
  return { handoff: Object.freeze([def.orchestrator]), end: false };
}

/**
 * The cap-aware legal-target set (§7.4).
 *
 * Same shape as `declaredTargets`, but workers whose
 * `visit_count[W] >= max_visits[W]` are removed from the handoff list.
 * Used to surface retry guidance on `transition_rejected` records.
 */
export function availableTargets(checkpoint: Checkpoint, def: MachineDefinition): LegalTargets {
  const base = declaredTargets(checkpoint.current_role, def);
  const end =
    checkpoint.current_role === def.orchestrator
      ? base.end || (checkpoint.end_request !== null && checkpoint.end_request !== undefined)
      : base.end;

  // The orchestrator's `done` branch and a worker's [orchestrator]-only
  // branch have no cap-relevant handoff targets, so short-circuit.
  if (base.handoff.length === 0) {
    return { handoff: base.handoff, end };
  }

  // Only the orchestrator's handoff set contains workers (and is therefore
  // cap-relevant). A worker's only target is the orchestrator, which has
  // no cap.
  if (checkpoint.current_role !== def.orchestrator) {
    return { handoff: base.handoff, end };
  }

  const allowed: Role[] = [];
  for (const w of base.handoff) {
    const cap = def.max_visits[w];
    if (cap === undefined) {
      // Defensive: validateManifest guarantees every worker has a finite
      // max_visits before a MachineDefinition is derived. A missing entry
      // here is a corrupted `def`, not a runtime concern.
      throw new Error(`availableTargets: worker '${w}' has no max_visits in def`);
    }
    const count = checkpoint.visit_count[w] ?? 0;
    if (count < cap) {
      allowed.push(w);
    }
  }

  return { handoff: Object.freeze(allowed), end };
}
