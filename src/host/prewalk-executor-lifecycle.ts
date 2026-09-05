/** Executor-only caps and terminal phase accounting (Prewalk §R8, §R13). */

import type { UsageRecord } from "../core/types.js";
import type { PrewalkRecord } from "../persistence/prewalk-records.js";
import type { PrewalkPhaseSession } from "./prewalk-role-session.js";
import { PrewalkRoleSessionError } from "./prewalk-role-session-errors.js";
import { createPrewalkExecutorCaps } from "./prewalk-validation.js";

export type PrewalkExecutorCapCode =
  | "prewalk_executor_turn_cap_exceeded"
  | "prewalk_executor_wall_clock_exceeded";

/** Arm turn/wall-clock enforcement only for the executor's active prompt. */
export function startPrewalkExecutorCaps(options: {
  readonly executor: PrewalkPhaseSession;
  readonly limits: { readonly maxTurns: number; readonly maxWallClockMs: number };
  readonly onExceeded: (code: PrewalkExecutorCapCode, message: string) => void;
}): {
  readonly code: PrewalkExecutorCapCode | null;
  readonly turns: number;
  stop(): void;
} {
  let exceededCode: PrewalkExecutorCapCode | null = null;
  const cap = createPrewalkExecutorCaps({
    maxTurns: options.limits.maxTurns,
    maxWallClockMs: options.limits.maxWallClockMs,
    onExceeded: (code) => {
      exceededCode = code;
      const message =
        code === "prewalk_executor_turn_cap_exceeded"
          ? `executor reached its ${options.limits.maxTurns}-turn cap`
          : `executor reached its ${options.limits.maxWallClockMs}ms wall-clock cap`;
      try {
        options.onExceeded(code, message);
      } finally {
        void options.executor.abort();
      }
    },
  });
  const unsubscribe = options.executor.subscribe((event) => {
    if (event.type === "turn_end") cap.onTurnEnd();
  });
  cap.start();
  return {
    get code() {
      return exceededCode;
    },
    get turns() {
      return cap.turns;
    },
    stop() {
      unsubscribe();
      cap.stop();
    },
  };
}

/** Persist executor-only provider usage without double-counting native guide usage. */
export function persistPrewalkExecutorUsage(options: {
  readonly runId: string;
  readonly roleSessionId: string;
  readonly guideSessionId: string;
  readonly executor: PrewalkPhaseSession;
  readonly guideUsage: UsageRecord;
  readonly turns: number;
  readonly ts: number;
  readonly sessionUsage?: (sessionId: string) => UsageRecord;
  readonly persist: (record: PrewalkRecord) => void;
}): void {
  if (options.sessionUsage === undefined) return;
  const physicalUsage = options.sessionUsage(options.executor.sessionId);
  const usage =
    options.executor.sessionId === options.guideSessionId
      ? subtractUsage(physicalUsage, options.guideUsage)
      : physicalUsage;
  options.persist({
    type: "prewalk_phase_usage",
    schema_version: 1,
    run_id: options.runId,
    role_session_id: options.roleSessionId,
    phase: "executor",
    model: options.executor.snapshot().model,
    usage,
    turns: options.turns,
    ts: options.ts,
  });
}

function subtractUsage(total: UsageRecord, phase: UsageRecord): UsageRecord {
  const result = {
    input: total.input - phase.input,
    output: total.output - phase.output,
    cache_read: total.cache_read - phase.cache_read,
    cache_write: total.cache_write - phase.cache_write,
    tokens: total.tokens - phase.tokens,
    cost: total.cost - phase.cost,
  };
  if (Object.values(result).some((value) => value < 0)) {
    throw new PrewalkRoleSessionError(
      "prewalk_context_unknown",
      "executor cumulative usage was lower than persisted guide-phase usage",
    );
  }
  return result;
}
