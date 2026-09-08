/** Pure accounting for durable orchestrator compaction usage, Issue #87. */

import type { UsageRecord } from "../core/types.js";
import type { PersistedRecord } from "../persistence/log.js";
import { assertOrchestratorContextRecord } from "../persistence/orchestrator-context.js";

/** An unavailable compaction charge that must remain visible to callers. */
export interface UnknownCompactionUsage {
  readonly run_id: string;
  readonly role: string;
  readonly epoch: number;
  readonly role_session_id: string;
  readonly request_id: string;
  readonly diagnostic: string;
}

/** Result of adding unsettled compaction records to persisted accounting. */
export interface UnsettledCompactionUsage {
  readonly usageByRole: Readonly<Record<string, UsageRecord>>;
  readonly totalUsage: UsageRecord;
  readonly unknown: readonly UnknownCompactionUsage[];
}

/** Inputs controlling which live invocation's known charge is already metered. */
export interface UnsettledCompactionOptions {
  readonly runId: string;
  readonly excludedLiveInvocationIds?: ReadonlySet<string>;
}

/** Corrupt or conflicting duplicate compaction accounting. */
export class ContextCompactionAccountingError extends Error {
  readonly code = "invalid-context-compaction-accounting";

  constructor(message: string) {
    super(message);
    this.name = "ContextCompactionAccountingError";
  }
}

/**
 * Aggregate known compaction usage that is not covered by a terminal record.
 * Live invocation IDs are excluded only for known usage already held in memory;
 * unknown usage remains visible even when a terminal or live exclusion exists.
 */
export function aggregateUnsettledCompactionUsage(
  records: readonly PersistedRecord[],
  options: UnsettledCompactionOptions,
): UnsettledCompactionUsage {
  const terminalInvocationIds = new Set<string>();
  const seenRequests = new Set<string>();
  const usageByRole = new Map<string, UsageRecord>();
  const unknown: UnknownCompactionUsage[] = [];
  let totalUsage: UsageRecord = zeroUsage();

  for (const record of records) {
    if (!isTerminal(record) || record.run_id !== options.runId) continue;
    if (record.role_session_id !== undefined) {
      terminalInvocationIds.add(invocationKey(record.role, record.role_session_id));
    }
  }

  for (const record of records) {
    if (record.type !== "context_compaction" || record.run_id !== options.runId) continue;
    assertOrchestratorContextRecord(record);
    if (seenRequests.has(record.request_id)) {
      throw new ContextCompactionAccountingError(
        `duplicate context_compaction request '${record.request_id}' in run '${options.runId}'`,
      );
    }
    seenRequests.add(record.request_id);

    if (record.usage === null) {
      if (record.diagnostic === null) {
        throw new ContextCompactionAccountingError(
          `context compaction request '${record.request_id}' is missing its diagnostic`,
        );
      }
      unknown.push({
        run_id: record.run_id,
        role: record.role,
        epoch: record.epoch,
        role_session_id: record.role_session_id,
        request_id: record.request_id,
        diagnostic: record.diagnostic,
      });
      continue;
    }

    if (
      terminalInvocationIds.has(invocationKey(record.role, record.role_session_id)) ||
      options.excludedLiveInvocationIds?.has(record.role_session_id) === true
    ) {
      continue;
    }

    const roleUsage = usageByRole.get(record.role) ?? zeroUsage();
    usageByRole.set(record.role, addUsage(roleUsage, record.usage));
    totalUsage = addUsage(totalUsage, record.usage);
  }

  return {
    usageByRole: Object.freeze(Object.fromEntries(usageByRole)),
    totalUsage: Object.freeze(totalUsage),
    unknown: Object.freeze(unknown),
  };
}

/** Throw an actionable error when any compaction charge is unavailable. */
export function assertKnownCompactionUsage(
  records: readonly PersistedRecord[],
  runId: string,
): void {
  const result = aggregateUnsettledCompactionUsage(records, { runId });
  if (result.unknown.length === 0) return;
  const requests = result.unknown.map((entry) => entry.request_id).join(", ");
  throw new ContextCompactionAccountingError(
    `context compaction usage is unavailable for run '${runId}' (requests: ${requests})`,
  );
}

function invocationKey(role: string, roleSessionId: string): string {
  return JSON.stringify([role, roleSessionId]);
}

function isTerminal(
  record: PersistedRecord,
): record is Extract<PersistedRecord, { type: "session_ended" | "session_failed" }> {
  return record.type === "session_ended" || record.type === "session_failed";
}

function zeroUsage(): UsageRecord {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 };
}

function addUsage(a: UsageRecord, b: UsageRecord): UsageRecord {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cache_read: a.cache_read + b.cache_read,
    cache_write: a.cache_write + b.cache_write,
    tokens: a.tokens + b.tokens,
    cost: a.cost + b.cost,
  };
}
