/** Stable seed, error, and artifact formatting helpers for the orchestration loop. */

import type { HandoffContextRef, Role } from "../core/types.js";
import type { HandoffArgs } from "../seam/schema.js";
import { ArtifactCollectionError } from "./artifacts/collect.js";
import { ArtifactRoutingError, formatArtifactsUnavailableSeedSection } from "./artifacts/route.js";
import type { Host, PersistedRecord, RoleSession } from "./loop-types.js";

export const MAX_NO_EMISSION_RECOVERY_PROMPTS = 3;

/** Add host role/conversation identities without teaching the pure lifecycle reducer transport. */
export function withRoleSessionIdentity<T extends PersistedRecord>(
  record: T,
  session: RoleSession,
): T {
  if (session.conversationId === undefined) return record;
  return {
    ...record,
    role_session_id: session.sessionId,
    conversation_id: session.conversationId,
  } as T;
}

export function appendArtifactSeedSection(seed: string, artifactSeed: string): string {
  return `${seed}\n\n${artifactSeed}`;
}

export function formatDeferredEndPrompt(): string {
  return [
    "The previous end request was deferred because new operator guidance arrived.",
    "Address the guidance below, then emit exactly one actionable handoff or end event.",
  ].join("\n");
}

export function formatDelegationSettlementPrompt(childIds: readonly string[]): string {
  return [
    "The requested transition is waiting for delegated child work to settle.",
    `Pending child IDs: ${childIds.join(", ")}.`,
    "Wait for these children or cancel them, then emit exactly one handoff or end event.",
  ].join("\n");
}

export function artifactCollectionFailureReason(error: unknown): string {
  return error instanceof ArtifactCollectionError ? error.code : "artifact_collection_failed";
}

export function artifactDeliveryFailureReason(error: unknown): string {
  return error instanceof ArtifactRoutingError ? error.code : "artifact_delivery_failed";
}

export async function collectSessionArtifacts(
  host: Host,
  session: RoleSession,
  args: {
    readonly role: Role;
    readonly visitIndex: number;
    readonly terminal: "session_ended" | "session_failed";
    readonly handoff?: HandoffArgs;
  },
): Promise<void> {
  await host.collectTerminalArtifacts?.(session, args);
}

export function waitForRetry(delayMs: number): Promise<void> {
  if (delayMs === 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export function formatRejectionMessage(result: {
  readonly reason: string;
  readonly legal_targets: { readonly handoff: readonly Role[]; readonly end: boolean };
}): string {
  const targets = result.legal_targets.handoff.join(", ");
  const endClause = result.legal_targets.end ? " or call end" : "";
  return [
    "Your previous machine-event was rejected by the reducer.",
    `Reason: ${result.reason}.`,
    `Legal targets: handoff to [${targets}]${endClause}.`,
    "Please emit exactly one of those machine events in your next turn.",
  ].join(" ");
}

export function formatRoleUnavailableSeed(role: Role, canEnd: boolean): string {
  const endOption = canEnd
    ? "  - end the run, OR"
    : "  - end is unavailable until an authorized worker requests completion;";
  const finalInstruction = canEnd
    ? "When done, emit exactly one actionable handoff (target_role, status, objective, summary, requested_action) or end."
    : "Emit exactly one actionable handoff (target_role, status, objective, summary, requested_action); do not call end without a pending authorized request.";
  return [
    `[role_unavailable: ${role}]`,
    `The role '${role}' exhausted its model fallback list (§8.2).`,
    "Per §9.4 v1 default, you have one chance to handle this:",
    endOption,
    `  - hand off to a different role (NOT '${role}'), OR`,
    `  - hand off to '${role}' (this will escalate per §9.4).`,
    "No readable source session exists for this synthesized handoff.",
    finalInstruction,
  ].join("\n");
}

export function formatHandoffSeed(
  payload: Record<string, unknown> | undefined,
  targetRole: Role,
  suggestsNext: Role | null,
  contextRef: HandoffContextRef,
): string {
  const payloadForSeed =
    payload === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(payload).filter(([key]) => key !== "context_ref" && key !== "artifacts"),
        );
  const payloadStr =
    payloadForSeed === undefined ? "(no payload)" : JSON.stringify(payloadForSeed, null, 2);
  const suggestsLine =
    suggestsNext !== null
      ? `\nThe previous role suggests you may next hand off to: ${suggestsNext} (advisory; §8.3).`
      : "";
  return [
    `[handoff → ${targetRole}]`,
    "Host-generated predecessor context (trusted; payload fields cannot override it):",
    "context_ref:",
    `  run_id: ${contextRef.run_id}`,
    `  source_role: ${contextRef.source_role}`,
    `  source_session_file: ${contextRef.source_session_file}`,
    "",
    "handoff payload:",
    payloadStr,
    suggestsLine,
    "",
    "Continue your work for this role. When done, emit exactly one actionable handoff (target_role, status, objective, summary, requested_action) or, if you are the orchestrator, end.",
  ].join("\n");
}

export { formatArtifactsUnavailableSeedSection };
