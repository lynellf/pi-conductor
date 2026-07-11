/**
 * Orchestrator run-memory seed formatter — spec §8.4, plan Task 16.5.
 *
 * Before each orchestrator session's `prompt`, the host rebuilds
 * the run-memory artifact via `buildRunMemory` (Phase 3 Task 12)
 * from the persisted records + checkpoint and injects it into the
 * seed (the first user message of the orchestrator's turn).
 *
 * **Single-writer rule (§8.4).** Only orchestrator sessions
 * receive the artifact. Worker sessions are focused on the handoff
 * payload (Task 15's `formatHandoffSeed`) and don't see the
 * run-memory — bilateral-contract friction would otherwise return.
 *
 * ## Format
 *
 * Human-readable structured text — the orchestrator LLM parses
 * and acts on it. Fields are surfaced in a stable order so an
 * orchestrator can rely on the shape across turns:
 *
 *   - run_id, goal, current_role, state — identity
 *   - run_cost_to_date, remaining_budget, run_cost_cap — budget
 *   - visit_history — past sessions
 *   - per_role_cost — cost roll-up
 *   - next_candidates — workers still dispatchable
 *
 * The orchestrator is told explicitly what to do: dispatch via
 * `handoff(target_role=<worker>)` or `end` if no candidates.
 */

import type { RunMemory } from "../core/run-memory.js";

const TERMINAL_LINE =
  "Continue your orchestration. Call handoff(target_role=<worker>) to dispatch work, or call end if the goal is complete and next_candidates is empty.";

/**
 * Format a `RunMemory` artifact as a structured prompt for the next
 * orchestrator session. Pure over `memory` — no I/O.
 */
export function formatRunMemorySeed(memory: RunMemory): string {
  const remaining =
    memory.remaining_budget === null
      ? "uncapped"
      : `$${memory.remaining_budget.toFixed(4)} remaining`;

  const historyText =
    memory.visit_history.length === 0
      ? "(no sessions yet)"
      : memory.visit_history
          .map(
            (v) =>
              `  - ${v.role} (visit ${v.visit_index}, ${v.outcome}, $${v.usage.cost.toFixed(4)})`,
          )
          .join("\n");

  const perRoleText =
    Object.keys(memory.per_role_cost).length === 0
      ? "(no role cost yet)"
      : Object.entries(memory.per_role_cost)
          .map(([role, c]) => `  - ${role}: $${c.cost.toFixed(4)} (${c.tokens} tokens)`)
          .join("\n");

  const candidatesText =
    memory.next_candidates.length > 0
      ? `Available workers (visit-capped AND run-budget-uncapped): ${memory.next_candidates.join(", ")}.`
      : "No candidates: all workers are visit-capped or the run budget is exhausted. Call end.";

  const lastMessageText =
    memory.last_message === null
      ? "(no prior worker message — this is the first orchestrator turn)"
      : [
          `  from: ${memory.last_message.from}`,
          memory.last_message.text === null
            ? "  text: (worker omitted reason)"
            : `  text: ${memory.last_message.text}`,
          `  suggests_next: ${
            memory.last_message.suggests_next === null
              ? "(none)"
              : memory.last_message.suggests_next
          }`,
          memory.last_message.context_ref === null
            ? "  context_ref: (no readable source session exists)"
            : [
                "  context_ref:",
                `    run_id: ${memory.last_message.context_ref.run_id}`,
                `    source_role: ${memory.last_message.context_ref.source_role}`,
                `    source_session_file: ${memory.last_message.context_ref.source_session_file}`,
              ].join("\n"),
        ].join("\n");

  return [
    "[run memory]",
    `run_id: ${memory.run_id}`,
    `goal: ${memory.goal}`,
    `current_role: ${memory.current_role}`,
    `state: ${memory.state}`,
    `run_cost_to_date: $${memory.run_cost_to_date.toFixed(4)} (${remaining})`,
    `run_cost_cap: ${
      memory.run_cost_cap === null ? "uncapped" : `$${memory.run_cost_cap.toFixed(4)}`
    }`,
    "",
    "last_message:",
    lastMessageText,
    "",
    "visit_history:",
    historyText,
    "",
    "per_role_cost:",
    perRoleText,
    "",
    "next_candidates:",
    candidatesText,
    "",
    TERMINAL_LINE,
  ].join("\n");
}
