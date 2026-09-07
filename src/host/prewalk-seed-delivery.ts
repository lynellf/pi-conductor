/** Recoverable executor seed outbox; intent is not proof of delivery (Prewalk §R12). */
import { createHash } from "node:crypto";
import type {
  PrewalkExecutorSeedIntentRecord,
  PrewalkRecord,
} from "../persistence/prewalk-records.js";
import type { PrewalkPhaseSession } from "./prewalk-role-session.js";
import { PrewalkRoleSessionError } from "./prewalk-role-session-errors.js";

type SeedSession = Pick<PrewalkPhaseSession, "conversationId" | "sessionFile" | "deliveryHistory">;

/** Durable active-branch entry, not the SDK's in-memory message buffer. */
export interface PrewalkDeliveryEntry {
  readonly id: string;
  readonly message?: unknown;
}

/** Persist a physical conversation locator before any executor request may be sent. */
export function preparePrewalkSeedDelivery(options: {
  readonly executor: SeedSession;
  readonly seed: string;
  readonly runId: string;
  readonly roleSessionId: string;
  readonly afterEntryId?: string | null;
  readonly persist: (record: PrewalkRecord) => void;
  readonly now?: () => number;
}): PrewalkExecutorSeedIntentRecord {
  const history = options.executor.deliveryHistory();
  const intent: PrewalkExecutorSeedIntentRecord = {
    type: "prewalk_executor_seed_intent",
    schema_version: 1,
    run_id: options.runId,
    role_session_id: options.roleSessionId,
    conversation: { id: options.executor.conversationId, file: options.executor.sessionFile },
    after_entry_id:
      options.afterEntryId !== undefined ? options.afterEntryId : (history.at(-1)?.id ?? null),
    continuation_seed_sha256: hashPrewalkSeed(options.seed),
    ts: (options.now ?? Date.now)(),
  };
  options.persist(intent);
  return intent;
}

/** Reconcile the exact user seed after its branch boundary, rejecting ambiguous history. */
export function hasDurablePrewalkSeed(
  executor: SeedSession,
  seed: string,
  intent: PrewalkExecutorSeedIntentRecord | null,
): boolean {
  const entries = executor.deliveryHistory();
  const boundary = intent?.after_entry_id ?? null;
  const index = boundary === null ? -1 : entries.findIndex((entry) => entry.id === boundary);
  if (boundary !== null && index < 0)
    throw invalid("seed delivery boundary is absent from the durable branch");
  const count = entries.slice(index + 1).filter((entry) => {
    const message = entry.message;
    if (
      typeof message !== "object" ||
      message === null ||
      !("role" in message) ||
      message.role !== "user" ||
      !("content" in message)
    )
      return false;
    const content = message.content;
    if (typeof content === "string") return hashPrewalkSeed(content) === hashPrewalkSeed(seed);
    return (
      Array.isArray(content) &&
      content.length === 1 &&
      content[0]?.type === "text" &&
      typeof content[0]?.text === "string" &&
      hashPrewalkSeed(content[0].text) === hashPrewalkSeed(seed)
    );
  }).length;
  if (count > 1) throw invalid("executor seed occurs more than once in the durable branch");
  return count === 1;
}

/** Append a delivery marker only after the exact user message is durable. */
export function recordPrewalkSeedDelivered(options: {
  readonly executor: SeedSession;
  readonly seed: string;
  readonly intent: PrewalkExecutorSeedIntentRecord;
  readonly persist: (record: PrewalkRecord) => void;
  readonly now?: () => number;
}): void {
  if (!hasDurablePrewalkSeed(options.executor, options.seed, options.intent)) {
    throw invalid("executor prompt returned without durably storing the continuation seed");
  }
  options.persist({
    type: "prewalk_executor_seed_delivered",
    schema_version: 1,
    run_id: options.intent.run_id,
    role_session_id: options.intent.role_session_id,
    conversation_id: options.executor.conversationId,
    continuation_seed_sha256: options.intent.continuation_seed_sha256,
    ts: (options.now ?? Date.now)(),
  });
}

/** Hash the exact submitted user content, not a normalized or summarized variant. */
export function hashPrewalkSeed(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function invalid(message: string): PrewalkRoleSessionError {
  return new PrewalkRoleSessionError("prewalk_resume_invalid", message);
}
