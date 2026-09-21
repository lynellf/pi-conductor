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
 *   - last_message — surfaced worker return (reported/untrusted)
 *   - visit_history — past sessions
 *   - per_role_cost — cost roll-up
 *   - configured_workers, next_candidates — top-level FSM handoff topology
 *   - continuity_seed — bounded, structured fresh-session continuity
 *
 * The orchestrator is told explicitly what to do: dispatch top-level work via
 * `handoff(target_role=<worker>)`, use `delegate` only through its separately
 * admitted tool interface, and call `end` only when `can_end` is true.
 *
 * **Last message — reported/untrusted (issue #137 Phase 2).** The
 * worker's return envelope's supported narrative fields (`reason`,
 * `summary`, `verification`) are rendered under a `reported hints:`
 * sub-block inside `last_message`, with the `ignored optional fields:`
 * line below. The sub-block is labelled reported/untrusted and is
 * visually/semantically distinct from the host continuity section
 * (`continuity_seed:`). The legacy `text:` line is preserved for
 * backward compatibility — it is the same value as `reported hints.reason`
 * when reason is present; otherwise it falls back to the v1
 * `payload_summary.reason`. The reported narrative is **never** labelled
 * `(worker omitted reason)` while a non-empty reason is in scope.
 *
 * **Continuity seed rendering (spec §8, §11).** When the run memory carries
 * a `continuity_seed`, the formatter injects its `rendered` text and the
 * omission / budget summary verbatim — the host never reformats the prose
 * (which would duplicate raw packet content) and never strips its omission
 * counts (which come from the materializer, not the host).
 */

import { recipientHandoffPayload } from "../core/accepted-handoff.js";
import type { RunMemory } from "../core/run-memory.js";
import type { DelegationInterface } from "../manifest/types.js";
import type { ContinuitySeedSection } from "./loop-format.js";

/**
 * Format a `RunMemory` artifact as a structured prompt for the next
 * orchestrator session. Pure over `memory` — no I/O.
 */
export function formatRunMemorySeed(
  memory: RunMemory,
  continuitySeedOverride?: ContinuitySeedSection | null,
  delegationInterface?: DelegationInterface,
): string {
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
  const delegationGuidance = formatDelegationGuidance(memory, delegationInterface);
  const continuitySection = formatContinuitySection(memory, continuitySeedOverride);

  const lastMessageText =
    memory.last_message === null
      ? "(no prior worker message \u2014 this is the first orchestrator turn)"
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
          ...formatReportedHints(memory.last_message),
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
    ...(continuitySection === null ? [] : ["", continuitySection]),
  ].join("\n");
}

/**
 * Issue #137 Phase 2: render the returned worker's reported narrative
 * (`reported_hints`) and ignored optional fields under a labelled
 * reported/untrusted sub-block inside the `last_message:` block. The
 * sub-block is visually/semantically distinct from the host
 * `continuity_seed:` section and the host-observed `visit_history` /
 * `per_role_cost` lines. Legacy records (no `accepted_control`) emit
 * nothing here — the `text:` line above already carries the v1
 * `payload_summary.reason`. A present non-empty `reason` is always
 * surfaced (never relabelled omitted); the section is omitted
 * entirely when no reported narrative or ignored fields exist.
 */
function formatReportedHints(lastMessage: import("../core/run-memory.js").LastMessage): string[] {
  const control = lastMessage.accepted_control;
  if (control === undefined) return [];
  const hints = control.reported_hints;
  const lines: string[] = ["  reported hints: (reported/untrusted; distinct from host continuity)"];
  let emitted = false;
  if (typeof hints.reason === "string") {
    lines.push(`    reason: ${hints.reason}`);
    emitted = true;
  }
  if (typeof hints.summary === "string") {
    lines.push(`    summary: ${hints.summary}`);
    emitted = true;
  }
  if (hints.verification !== undefined) {
    for (const item of hints.verification) {
      lines.push(`    verification: ${item}`);
      emitted = true;
    }
  }
  if (
    !emitted &&
    control.ignored_hint_fields.length === 0 &&
    (control.ignored_hint_diagnostics?.length ?? 0) === 0
  )
    return [];
  if (control.ignored_hint_fields.length > 0) {
    lines.push(
      `    ignored optional fields: ${control.ignored_hint_fields
        .map(safeReportedLine)
        .join(", ")}`,
    );
  }
  if (
    control.ignored_hint_diagnostics !== undefined &&
    control.ignored_hint_diagnostics.length > 0
  ) {
    lines.push(
      `    ignored return diagnostics: ${control.ignored_hint_diagnostics
        .map(safeReportedLine)
        .join(", ")}`,
    );
  }
  return lines;
}

function safeReportedLine(value: string): string {
  return value.replace(/[\r\n]/g, (character) => (character === "\r" ? "\\r" : "\\n"));
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

function formatDelegationGuidance(
  memory: RunMemory,
  delegationInterface: DelegationInterface | undefined,
): string {
  if (memory.current_role === "done") {
    return "This run is terminal. Do not call handoff, delegate, or end.";
  }

  if (memory.remaining_budget !== null && memory.remaining_budget <= 0) {
    return "The exhausted run budget applies to all further work. Do not use handoff or delegate to continue it.";
  }

  if (delegationInterface === "assignments_v1") {
    return "If a top-level target is listed, use handoff to route this FSM run to it. Assignment delegation submits one pinned child task without changing the active FSM role; use delegation_control for child status, result, wait, or cancel. This list does not determine delegation availability. Live child and run-budget limits plus admission, projection, and cleanup gates decide whether a request can be accepted.";
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

/**
 * Format the bounded continuity seed section (spec §11). The seed's
 * `rendered` text is injected verbatim so the materializer/renderer own
 * the prose. Omission counts and budget summary are surfaced so the
 * orchestrator can recognize truncation without re-fetching the ledger.
 * When the host has not wired the seed pipeline (legacy preservation),
 * the field is absent and the section is omitted entirely.
 */
function formatContinuitySection(
  memory: RunMemory,
  override: ContinuitySeedSection | null | undefined,
): string | null {
  if (override === null) return null;
  const seed =
    override === undefined
      ? memory.continuity_seed
      : {
          schema_version: memory.continuity_seed?.schema_version ?? 1,
          run_id: memory.continuity_seed?.run_id ?? memory.run_id,
          budget: { used_bytes: override.used_bytes, max_bytes: override.max_bytes },
          omitted: { items: override.omitted_items, packets: override.omitted_packets },
          rendered: override.rendered,
        };
  if (seed === undefined || seed === null) return null;
  const budgetText = `budget: ${seed.budget.used_bytes}/${seed.budget.max_bytes} UTF-8 bytes`;
  const omittedText =
    seed.omitted.items > 0 || seed.omitted.packets > 0
      ? `omitted: ${seed.omitted.items} item(s), ${seed.omitted.packets} packet(s)`
      : "omitted: (none)";
  return [
    "continuity_seed:",
    `  schema_version: ${seed.schema_version}`,
    `  run_id: ${seed.run_id}`,
    `  ${budgetText}`,
    `  ${omittedText}`,
    "",
    seed.rendered,
  ].join("\n");
}
