import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

import type { Role } from "../core/types.js";
import type { PersistedRecord } from "../persistence/log.js";
import { OrchestratorContextFileError } from "./orchestrator-context-file-errors.js";

type ContextMessage = ReturnType<SessionManager["buildSessionContext"]>["messages"][number];

/** SDK-effective context and the audited retry failures omitted from it. */
export interface EffectiveRetryContext {
  readonly messages: readonly ContextMessage[];
  readonly omittedMessages: ReadonlySet<ContextMessage>;
}

function isSupersededSdkRetryFailure(
  message: ContextMessage,
  next: ContextMessage | undefined,
  executedToolCallIds: ReadonlySet<string>,
): boolean {
  // Pi SDK 0.80.6's AgentSession._prepareRetry removes a retryable failed
  // assistant response from active agent state while retaining it in the
  // session file. pi-agent-core's loop stops before tool execution for an
  // error response; recorded execution or admission remains contradictory.
  if (message.role !== "assistant" || message.stopReason !== "error" || next?.role !== "assistant")
    return false;
  return message.content.every(
    (block) => block.type !== "toolCall" || !executedToolCallIds.has(block.id),
  );
}

/** Remove only retry-superseded failed responses from provider-visible context. */
export function projectEffectiveRetryContext(
  messages: readonly ContextMessage[],
  executedToolCallIds: ReadonlySet<string>,
): EffectiveRetryContext {
  const omittedMessages = new Set<ContextMessage>();
  for (const [index, message] of messages.entries()) {
    if (isSupersededSdkRetryFailure(message, messages[index + 1], executedToolCallIds)) {
      omittedMessages.add(message);
    }
  }
  return {
    messages: messages.filter((message) => !omittedMessages.has(message)),
    omittedMessages,
  };
}

/** Gather durable execution or delegation-admission evidence for retry projection. */
export function executedToolCallIdsForRoleSession(
  records: readonly PersistedRecord[],
  role: Role,
  roleSessionId: string,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const record of records) {
    if (record.type === "tool_execution_started" && record.role_session_id === roleSessionId) {
      ids.add(record.tool_call_id);
    }
    // Delegation acceptance does not retain a role-session ID. Tool-call IDs
    // are SDK-minted, so an accepted ID for this role is contradictory
    // execution evidence and must retain fail-closed pairing.
    if (record.type === "delegation_submission_accepted" && record.parent_role === role) {
      ids.add(record.tool_call_id);
    }
  }
  return ids;
}

/** Remove only superseded entries and repair their compaction-visible projection. */
export function projectEffectiveRetryEntries(
  branch: readonly SessionEntry[],
  omittedMessages: ReadonlySet<ContextMessage>,
): readonly SessionEntry[] {
  const kept = branch.filter(
    (entry) => entry.type !== "message" || !omittedMessages.has(entry.message),
  );
  let parentId: string | null = null;
  return kept.map((entry) => {
    let reparented = { ...entry, parentId } as SessionEntry;
    if (
      entry.type === "compaction" &&
      !kept.some((candidate) => candidate.id === entry.firstKeptEntryId)
    ) {
      const originalIndex = branch.findIndex((candidate) => candidate.id === entry.id);
      const firstKeptIndex = branch.findIndex(
        (candidate) => candidate.id === entry.firstKeptEntryId,
      );
      const replacement = branch
        .slice(firstKeptIndex + 1, originalIndex)
        .find((candidate) => kept.some((keptEntry) => keptEntry.id === candidate.id));
      if (replacement === undefined) {
        throw new OrchestratorContextFileError(
          "sdk_restore_failed",
          "cannot safely project a retry failure referenced by compaction",
        );
      }
      reparented = { ...entry, parentId, firstKeptEntryId: replacement.id };
    }
    parentId = reparented.id;
    return reparented;
  });
}
