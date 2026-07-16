/**
 * `rollup` — pure usage/cost roll-up over persisted records (spec §11.6 / issue-17-delegation-lite §7).
 *
 * Aggregates the `usage` blocks captured on terminal lifecycle events
 * (`session_ended` AND `session_failed` — both terminals cost, §11.4)
 * into:
 *
 *  - `perRun`               — the headline total for the run (one row).
 *  - `perRole`              — totals per role, across all visits including
 *                             failed/retried sessions. Contains EVERY
 *                             role that ran, workers AND orchestrator.
 *  - `perModel`             — totals per model. Reveals load split when a
 *                             role has fallbacks (§8.2).
 *  - `orchestratorOverhead` — orchestrator cost labeled separately for
 *                             emphasis (§11.6: "isolated from worker
 *                             cost"). Same numbers as `perRole[orchestrator]`
 *                             — the isolation is a *consumer* concern,
 *                             not a separate accounting. Without separation
 *                             a cheap run looks expensive because the
 *                             orchestrator ran many times.
 *  - `perSubagent`          — totals per subagent profile (delegation lite §7).
 *                             Child usage contributes here; never enters
 *                             `perRole` or parent lifecycle usage.
 *
 * Records that do not carry `usage` (transition_accepted /
 * transition_rejected / session_started) do not contribute to the cost
 * roll-up. The rollup does NOT inspect payload content — it reads
 * `usage` only (§11.4 normalized shape).
 *
 * **Cache caveat (§11.6):** the rollup exposes raw `cache_read` /
 * `cache_write` token sums per dimension. It does NOT synthesize a
 * "per-run cache hit rate" — that's a per-session ratio, not a clean
 * per-run number (cache reuse is provider-dependent across sessions).
 *
 * **System-default model:** `SessionLifecycleEvent.model` may be `null`
 * (no `models:` field on the role, §8.1). The rollup keys null into
 * perModel under the stable sentinel `SYSTEM_DEFAULT_MODEL_KEY` so a
 * real model id never collides.
 *
 * Pure. No I/O, no pi imports.
 */

import type { Role, UsageRecord } from "../core/types.js";
import type { PersistedRecord, SubagentUsage } from "../persistence/log.js";

/**
 * Stable sentinel key for sessions that ran on the system default model
 * (no `models:` field on the role, §8.1). Real model ids are
 * `provider:id` form and cannot contain angle brackets; this sentinel
 * is collision-free in practice.
 */
export const SYSTEM_DEFAULT_MODEL_KEY = "<system-default>";

/**
 * Sums across a set of sessions. `sessions` counts the number of
 * terminal lifecycle events (each terminal represents a session
 * invocation — retries each get their own terminal). `tokens` is the
 * normalized total token count (`input + output + cache_read +
 * cache_write`, matching the `UsageRecord` invariant).
 */
export interface UsageAggregate {
  readonly input: number;
  readonly output: number;
  readonly cache_read: number;
  readonly cache_write: number;
  readonly tokens: number;
  readonly cost: number;
  readonly sessions: number;
}

const ZERO_AGGREGATE: UsageAggregate = Object.freeze({
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  tokens: 0,
  cost: 0,
  sessions: 0,
}) as UsageAggregate;

/** §11.6 / delegation lite §7: the rollup result. All dimensions share the same aggregate shape. */
export interface RunRollup {
  readonly perRun: UsageAggregate;
  readonly perRole: Readonly<Record<Role, UsageAggregate>>;
  readonly perModel: Readonly<Record<string, UsageAggregate>>;
  readonly orchestratorOverhead: UsageAggregate;
  /** Delegation lite §7: totals per subagent profile. */
  readonly perSubagent: Readonly<Record<string, UsageAggregate>>;
}

/**
 * Compute the §11.6 / delegation lite §7 usage roll-up for one run.
 *
 * @param records — the full append-only log; filtered to `runId` here
 *                  so a single call over a multi-run log returns a
 *                  single-run roll-up.
 * @param runId   — only records with this `run_id` contribute.
 * @param orchestratorRole — the orchestrator's role name (the manifest's
 *                  `is_orchestrator: true` entry). Used to populate
 *                  `orchestratorOverhead`. The rollup does not parse the
 *                  manifest; the host passes this in.
 *
 * Records without `usage` are skipped (zero contribution across all
 * dimensions). Records from other `run_id`s are skipped.
 */
export function rollup(
  records: readonly PersistedRecord[],
  runId: string,
  orchestratorRole: Role,
): RunRollup {
  let perRun: UsageAggregate = ZERO_AGGREGATE;
  const perRole = new Map<Role, UsageAggregate>();
  const perModel = new Map<string, UsageAggregate>();
  const perSubagent = new Map<string, UsageAggregate>();

  for (const record of records) {
    // run_id filter (§11.6: roll-up is keyed by run_id).
    // CheckpointSnapshot wraps the run_id in its checkpoint field.
    const recordRunId =
      record.type === "checkpoint_snapshot" ? record.checkpoint.run_id : record.run_id;
    if (recordRunId !== runId) {
      continue;
    }

    // Delegation lite §7: subagent terminal records contribute to
    // perRun, perModel, and perSubagent. They never enter perRole.
    if (record.type === "subagent_completed" || record.type === "subagent_failed") {
      if (record.usage) {
        perRun = addUsage(perRun, record.usage);
        const subagentAgg = perSubagent.get(record.subagent) ?? ZERO_AGGREGATE;
        perSubagent.set(record.subagent, addUsage(subagentAgg, record.usage));
        const modelAgg = perModel.get(record.model) ?? ZERO_AGGREGATE;
        perModel.set(record.model, addUsage(modelAgg, record.usage));
      }
      continue;
    }

    // Parent lifecycle events: only terminal sessions contribute.
    if (record.type !== "session_ended" && record.type !== "session_failed") {
      continue;
    }

    const usage: UsageRecord | undefined = record.usage;
    if (usage === undefined) {
      // Defensive: reduceLifecycle requires usage on terminals. If a
      // record was constructed without it, skip rather than throw — the
      // rollup is a read query, not a write.
      continue;
    }

    perRun = addUsage(perRun, usage);

    const roleAgg = perRole.get(record.role) ?? ZERO_AGGREGATE;
    perRole.set(record.role, addUsage(roleAgg, usage));

    const modelKey = record.model ?? SYSTEM_DEFAULT_MODEL_KEY;
    const modelAgg = perModel.get(modelKey) ?? ZERO_AGGREGATE;
    perModel.set(modelKey, addUsage(modelAgg, usage));
  }

  // §11.6 isolation: orchestrator overhead is the orchestrator's entry
  // labeled separately. Numbers equal perRole[orchestratorRole]; the
  // isolation is a *consumer* concern (routing cost should not be
  // conflated with worker cost). If the orchestrator never ran (rare,
  // but possible if the run ended before the first orchestrator
  // session terminated), this is ZERO_AGGREGATE.
  const orchestratorOverhead: UsageAggregate = perRole.get(orchestratorRole) ?? ZERO_AGGREGATE;

  return finalize(perRun, perRole, perModel, perSubagent, orchestratorOverhead);
}

function addUsage(a: UsageAggregate, u: SubagentUsage | UsageRecord): UsageAggregate {
  return {
    input: a.input + u.input,
    output: a.output + u.output,
    cache_read: a.cache_read + u.cache_read,
    cache_write: a.cache_write + u.cache_write,
    tokens: a.tokens + u.tokens,
    cost: a.cost + u.cost,
    sessions: a.sessions + 1,
  };
}

function finalize(
  perRun: UsageAggregate,
  perRole: Map<Role, UsageAggregate>,
  perModel: Map<string, UsageAggregate>,
  perSubagent: Map<string, UsageAggregate>,
  orchestratorOverhead: UsageAggregate,
): RunRollup {
  const perRoleOut: Record<Role, UsageAggregate> = {};
  for (const [role, agg] of perRole.entries()) {
    perRoleOut[role] = Object.freeze({ ...agg }) as UsageAggregate;
  }
  const perModelOut: Record<string, UsageAggregate> = {};
  for (const [model, agg] of perModel.entries()) {
    perModelOut[model] = Object.freeze({ ...agg }) as UsageAggregate;
  }
  const perSubagentOut: Record<string, UsageAggregate> = {};
  for (const [subagent, agg] of perSubagent.entries()) {
    perSubagentOut[subagent] = Object.freeze({ ...agg }) as UsageAggregate;
  }
  return {
    perRun: Object.freeze({ ...perRun }) as UsageAggregate,
    perRole: Object.freeze(perRoleOut),
    perModel: Object.freeze(perModelOut),
    orchestratorOverhead: Object.freeze({ ...orchestratorOverhead }) as UsageAggregate,
    perSubagent: Object.freeze(perSubagentOut),
  };
}
