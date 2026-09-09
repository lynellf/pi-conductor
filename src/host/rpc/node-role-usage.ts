import type { UsageRecord } from "../../core/types.js";
import { RpcStateError } from "./protocol.js";

/** Subtract imported history from cumulative child usage. */
export function subtractUsage(current: UsageRecord, baseline: UsageRecord): UsageRecord {
  const usage = {
    input: current.input - baseline.input,
    output: current.output - baseline.output,
    cache_read: current.cache_read - baseline.cache_read,
    cache_write: current.cache_write - baseline.cache_write,
    tokens: current.tokens - baseline.tokens,
    cost: current.cost - baseline.cost,
  };
  if (Object.values(usage).some((value) => value < 0 || !Number.isFinite(value))) {
    throw new RpcStateError("RPC context usage regressed below its imported baseline");
  }
  return usage;
}

/** Add a compaction delta to the role-session usage record. */
export function addUsageRecord(left: UsageRecord, right: UsageRecord): UsageRecord {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cache_read: left.cache_read + right.cache_read,
    cache_write: left.cache_write + right.cache_write,
    tokens: left.tokens + right.tokens,
    cost: left.cost + right.cost,
  };
}
