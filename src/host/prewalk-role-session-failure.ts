/** Durable failure recording kept separate from the composite phase driver. */

import type { UsageRecord } from "../core/types.js";
import type { PrewalkFailureCode, PrewalkRecord } from "../persistence/prewalk-records.js";
import { PrewalkRoleSessionError } from "./prewalk-role-session-errors.js";

export interface PrewalkFailurePersistence {
  readonly runId: string;
  readonly roleSessionId: string;
  readonly persist: (record: PrewalkRecord) => void;
  readonly guideUsage: () => UsageRecord;
  readonly now?: () => number;
}

/** Persist one host-substate failure without deciding logical session termination. */
export function persistPrewalkFailure(
  options: PrewalkFailurePersistence,
  args: {
    readonly baseSha: string;
    readonly exemplarSha: string | null;
    readonly code: PrewalkFailureCode;
    readonly message: string;
    readonly guideUsage: UsageRecord;
  },
): void {
  options.persist({
    type: "prewalk_switch_failed",
    schema_version: 1,
    run_id: options.runId,
    role_session_id: options.roleSessionId,
    code: args.code,
    message: args.message,
    guide_usage: args.guideUsage,
    git_checkpoint: { base_sha: args.baseSha, exemplar_sha: args.exemplarSha },
    ts: (options.now ?? Date.now)(),
  });
}

/** Persist and throw the typed failure used by switch setup paths. */
export function failPrewalkRoleSession(
  options: PrewalkFailurePersistence,
  args: {
    readonly baseSha: string;
    readonly exemplarSha: string | null;
    readonly code: PrewalkFailureCode;
    readonly message: string;
    readonly cause?: unknown;
  },
): never {
  persistPrewalkFailure(options, { ...args, guideUsage: options.guideUsage() });
  throw new PrewalkRoleSessionError(
    args.code,
    args.message,
    args.cause === undefined ? undefined : { cause: args.cause },
  );
}
