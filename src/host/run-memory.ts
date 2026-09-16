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
 *   - end_request, can_end — completion authority
 *   - run_cost_to_date, remaining_budget, run_cost_cap — budget
 *   - visit_history — past sessions
 *   - per_role_cost — cost roll-up
 *   - configured_workers, next_candidates — top-level FSM handoff topology
 *
 * The orchestrator is told explicitly what to do: dispatch top-level work via
 * `handoff(target_role=<worker>)`, use `delegate` only through its separately
 * admitted tool interface, and call `end` only when `can_end` is true.
 */

import { recipientHandoffPayload } from "../core/accepted-handoff.js";
import type { RunMemory } from "../core/run-memory.js";

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

  const candidatesText = formatCandidateGuidance(memory);

  const endRequestText =
    memory.end_request === null ? "(none)" : `role: ${memory.end_request.role}`;
  const terminalLine = formatTerminalGuidance(memory);
  const delegationGuidance = formatDelegationGuidance(memory);

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
          memory.last_message.accepted_handoff === undefined
            ? "  accepted_handoff: (legacy or synthesized reason-only record)"
            : [
                "  accepted_handoff:",
                `    recipient_role: ${memory.last_message.accepted_handoff.recipient_role}`,
                `    payload: ${JSON.stringify(recipientHandoffPayload(memory.last_message.accepted_handoff))}`,
              ].join("\n"),
        ].join("\n");

  return [
    "[run memory]",
    `run_id: ${memory.run_id}`,
    `goal: ${memory.goal}`,
    `current_role: ${memory.current_role}`,
    `state: ${memory.state}`,
    `end_request: ${endRequestText}`,
    `can_end: ${String(memory.can_end)}`,
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
    delegationGuidance,
    "",
    terminalLine,
  ].join("\n");
}

function formatCandidateGuidance(memory: RunMemory): string {
  if (memory.current_role === "done") {
    return "The top-level FSM run is terminal.";
  }

  if (memory.next_candidates.length > 0) {
    return `Top-level FSM handoff candidates: ${memory.next_candidates.join(", ")}.`;
  }

  if (memory.configured_workers?.length === 0) {
    return "No top-level FSM workers are configured. An empty handoff list does not mean the goal is complete.";
  }

  if (memory.remaining_budget !== null && memory.remaining_budget <= 0) {
    return "The run budget is exhausted; no top-level FSM handoff is available. An empty handoff list does not mean the goal is complete.";
  }

  if (memory.configured_workers === undefined) {
    return "No top-level FSM handoff candidates are listed; worker topology is unavailable in this legacy memory. An empty handoff list does not mean the goal is complete.";
  }

  return "All top-level FSM workers are visit-capped. An empty handoff list does not mean the goal is complete.";
}

function formatDelegationGuidance(memory: RunMemory): string {
  if (memory.current_role === "done") {
    return "This run is terminal. Do not call handoff, delegate, or end.";
  }

  if (memory.remaining_budget !== null && memory.remaining_budget <= 0) {
    return "The exhausted run budget applies to all further work. Do not use handoff or delegate to continue it.";
  }

  return "If a top-level target is listed, use handoff to route this FSM run to it. Delegate submits child work without changing the active FSM role. This list does not determine delegate availability. If delegate is available in your toolset, consult its interface; live child and run-budget limits plus admission, projection, and cleanup gates decide whether a request can be accepted.";
}

function formatTerminalGuidance(memory: RunMemory): string {
  if (memory.current_role === "done") {
    return "No further orchestration is possible.";
  }

  if (memory.remaining_budget !== null && memory.remaining_budget <= 0) {
    return "The run budget is exhausted. Do not dispatch further work; follow the run-cap completion path.";
  }

  return memory.can_end
    ? "Continue toward the goal using the permitted routing above; call end only if the goal is complete."
    : "Continue toward the goal using the permitted routing above. Do not call end: this gated run has no pending authorized end request.";
}
