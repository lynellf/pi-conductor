import type { PersistedRecord } from "../../persistence/log.js";
import { isToolExecutionRecord } from "../../persistence/tool-execution.js";

/** Reconstruct fresh executable invocation indexes independently of workspace visits. */
export function nextExecutionVisitIndexes(
  records: readonly PersistedRecord[],
  runId: string,
  lifecycleIndexes: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  const highest = new Map<string, number>();
  const knownRoles = new Set(Object.keys(lifecycleIndexes));
  for (const record of records) {
    if (!("run_id" in record) || record.run_id !== runId) continue;
    if (!isToolExecutionRecord(record)) continue;
    let identity: unknown;
    try {
      identity = JSON.parse(record.logical_session_id);
    } catch {
      continue;
    }
    if (
      Array.isArray(identity) &&
      identity.length === 3 &&
      identity[0] === runId &&
      typeof identity[1] === "string" &&
      knownRoles.has(identity[1]) &&
      typeof identity[2] === "number" &&
      Number.isSafeInteger(identity[2]) &&
      identity[2] > 0 &&
      identity[2] < Number.MAX_SAFE_INTEGER
    ) {
      highest.set(identity[1], Math.max(highest.get(identity[1]) ?? 0, identity[2]));
    }
  }
  for (const [role, nextVisit] of Object.entries(lifecycleIndexes)) {
    if (Number.isSafeInteger(nextVisit) && nextVisit > 0) {
      highest.set(role, Math.max(highest.get(role) ?? 0, nextVisit - 1));
    }
  }
  return Object.freeze(Object.fromEntries([...highest].map(([role, index]) => [role, index + 1])));
}
