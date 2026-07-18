import type { MachineDefinition, Role } from "../core/types.js";
import {
  type HandoffActionabilityFailure,
  type HandoffCandidate,
  validateActionableHandoff,
} from "../seam/schema.js";

/** Role and pinned definition needed to describe and validate a handoff call. */
export interface HandoffContractContext {
  readonly role: Role;
  readonly def: MachineDefinition;
}

/** Validate the actionable envelope and role-specific end-request mechanics. */
export function validateRoleHandoff(
  args: HandoffCandidate,
  context: HandoffContractContext | undefined,
): HandoffActionabilityFailure | null {
  const actionable = validateActionableHandoff(args);
  if (actionable !== null) return actionable;
  if (args.request_end !== true) return null;
  if (context === undefined) {
    return { missingFields: [], invalidFields: ["request_end"] };
  }

  const authorized = context.def.end_request_roles?.includes(context.role) === true;
  const returnsToOrchestrator = args.target_role === context.def.orchestrator;
  const complete = args.status === "complete";
  if (authorized && returnsToOrchestrator && complete) return null;
  return { missingFields: [], invalidFields: ["request_end"] };
}

/** Model-facing role-specific handoff tool description. */
export function formatHandoffDescription(context: HandoffContractContext | undefined): string {
  const required =
    "Required fields: target_role, status: ready | blocked | complete, objective, summary, requested_action.";
  if (context === undefined) {
    return `Terminate this role session by routing control. ${required} Workers route only to the orchestrator; the orchestrator routes to a declared worker. request_end defaults to false and is valid only for an authorized end-request role returning complete work to the orchestrator.`;
  }

  const { role, def } = context;
  const route =
    role === def.orchestrator
      ? `target_role must be one of: ${def.workers.join(", ")} (subject to visit caps).`
      : `target_role must be ${def.orchestrator}.`;
  const canRequest = def.end_request_roles?.includes(role) === true;
  const endRequest = canRequest
    ? `This role may set request_end: true only when target_role is ${def.orchestrator} and status is complete.`
    : "This role may not set request_end: true; omit it or set false.";
  return `Current role: ${role}. ${route} ${required} ${endRequest}`;
}

/** Same-session correction for an incomplete or mechanically invalid handoff. */
export function formatHandoffCorrection(
  failure: HandoffActionabilityFailure,
  context: HandoffContractContext | undefined,
): string {
  const fields = [
    ...failure.missingFields.map((field) => `missing '${field}'`),
    ...failure.invalidFields.map((field) => `invalid '${field}'`),
  ];
  const target =
    context === undefined
      ? "<legal-role>"
      : context.role === context.def.orchestrator
        ? (context.def.workers[0] ?? "<declared-worker>")
        : context.def.orchestrator;
  const correctingEndRequest = failure.invalidFields.includes("request_end");
  const requestEnd =
    correctingEndRequest && context?.def.end_request_roles?.includes(context.role) === true
      ? ', "request_end": true'
      : "";
  return [
    `Incomplete handoff: ${fields.join(", ")}.`,
    "Legal status values: ready | blocked | complete.",
    context === undefined ? "Use a legal routing target." : formatHandoffDescription(context),
    `Valid example: {"target_role":"${target}","status":"complete","objective":"State the objective","summary":"Summarize the work","requested_action":"State the next action"${requestEnd}}.`,
    "Correct the call now in this same session.",
  ].join(" ");
}

/** Recovery instruction when a role returned without a conductor emission. */
export function formatNoEmissionRecovery(role: Role, def: MachineDefinition): string {
  const context = { role, def };
  const action =
    role === def.orchestrator
      ? "Call exactly one conductor tool now: handoff using the contract below, or end when legally authorized."
      : "Call exactly one conductor tool now: handoff using the contract below. Do not call end; workers return control to the orchestrator.";
  return [
    "Your previous response did not call `handoff` or `end`, so the conductor cannot advance.",
    "Do not do more investigation or call any non-conductor tools.",
    action,
    formatHandoffDescription(context),
  ].join(" ");
}
