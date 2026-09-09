import type { ChildProcess } from "node:child_process";
import { hrtime } from "node:process";
import {
  SupervisedProcessAbortError,
  type SupervisedProcessDiagnostic,
  type SupervisedProcessOptions,
  type SupervisedProcessResult,
  SupervisedProcessTimeoutError,
} from "./supervised-process-contract.js";
import { finishOutput, type OutputCapture } from "./supervised-process-output.js";

/** Default maximum captured output for a supervised process. */
export const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;

/** Calculate elapsed monotonic milliseconds from a process start timestamp. */
export function elapsedMs(startedAt: bigint): number {
  return Number(hrtime.bigint() - startedAt) / 1_000_000;
}

/** Reject an unobserved child when its admission deadline or abort wins. */
export function assertUnobservedAdmissionActive(
  signal: AbortSignal | undefined,
  deadlineMs: number,
  startedAt: bigint,
): void {
  if (signal?.aborted)
    throw new SupervisedProcessAbortError(
      "unconfirmed",
      null,
      elapsedMs(startedAt),
      leaderIdentityUnobserved,
    );
  if (Date.now() >= deadlineMs) {
    throw new SupervisedProcessTimeoutError(
      "unconfirmed",
      null,
      elapsedMs(startedAt),
      leaderIdentityUnobserved,
    );
  }
}

/** Diagnostic for an ownership observation that failed before leader identity was proven. */
export const cleanupObservationFailure: SupervisedProcessDiagnostic = {
  cleanup_cause: "cleanup_observation_failed",
  leader_observed: false,
  observed_members: [],
};
/** Diagnostic for a child whose leader identity was unavailable. */
export const leaderIdentityUnobserved: SupervisedProcessDiagnostic = {
  cleanup_cause: "leader_identity_unobserved",
  leader_observed: false,
  observed_members: [],
};
/** Diagnostic for an observation failure after leader identity was proven. */
export const ownedObservationFailure: SupervisedProcessDiagnostic = {
  cleanup_cause: "cleanup_observation_failed",
  leader_observed: true,
  observed_members: [],
};

/** Keep only bounded errno evidence from a process-namespace observation. */
export function observationFailure(
  error: unknown,
  operation: "read_stat" | "read_environ" | "read_status" | "list_processes",
  identity: {
    readonly pid: number;
    readonly startTime: string;
    readonly processGroupId: number;
  } | null,
): SupervisedProcessDiagnostic {
  const observed = error as {
    readonly operation?: string;
    readonly code?: string;
    readonly pid?: number;
    readonly startTime?: string;
    readonly processGroupId?: number;
  };
  const safeCode =
    typeof observed.code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(observed.code)
      ? observed.code
      : "UNKNOWN";
  const actualOperation =
    observed.operation === "read_stat" ||
    observed.operation === "read_environ" ||
    observed.operation === "read_status" ||
    observed.operation === "list_processes"
      ? observed.operation
      : operation;
  const targetPid =
    typeof observed.pid === "number" && Number.isInteger(observed.pid) && observed.pid > 0
      ? observed.pid
      : undefined;
  const startTime = typeof observed.startTime === "string" ? observed.startTime : undefined;
  const processGroupId =
    typeof observed.processGroupId === "number" &&
    Number.isInteger(observed.processGroupId) &&
    observed.processGroupId > 0
      ? observed.processGroupId
      : undefined;
  const fallbackPid = identity?.pid;
  const fallbackStartTime = identity?.startTime;
  const fallbackGroupId = identity?.processGroupId;
  const mayUseLeaderIdentity = targetPid !== undefined && targetPid === fallbackPid;
  const effectiveStartTime = startTime ?? (mayUseLeaderIdentity ? fallbackStartTime : undefined);
  const effectiveGroupId = processGroupId ?? (mayUseLeaderIdentity ? fallbackGroupId : undefined);
  const observationIdentity =
    targetPid === undefined
      ? {}
      : {
          pid: targetPid,
          ...(effectiveStartTime === undefined ? {} : { start_time: effectiveStartTime }),
          ...(effectiveGroupId === undefined ? {} : { process_group_id: effectiveGroupId }),
        };
  return {
    cleanup_cause: "cleanup_observation_failed",
    leader_observed: identity !== null,
    observed_members: [],
    observation_error: {
      operation: actualOperation,
      code: safeCode,
      ...observationIdentity,
    },
  };
}

/** Validate the bounded process controls before spawning. */
export function validateSupervisedProcessOptions(options: SupervisedProcessOptions): void {
  if ((options.command === undefined) === (options.file === undefined)) {
    throw new RangeError("exactly one of command or file must be provided");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    throw new RangeError("timeoutMs must be positive");
  if (options.graceMs !== undefined && (!Number.isFinite(options.graceMs) || options.graceMs < 0)) {
    throw new RangeError("graceMs must be non-negative");
  }
  if (
    options.outputLimitBytes !== undefined &&
    (!Number.isFinite(options.outputLimitBytes) || options.outputLimitBytes < 0)
  ) {
    throw new RangeError("outputLimitBytes must be non-negative");
  }
}

/** Resolve process-close output after ownership cleanup has settled. */
export function observeProcessClose(
  child: ChildProcess,
  startedAt: bigint,
  stdout: OutputCapture,
  stderr: OutputCapture,
  closed: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined,
  resolve: (result: SupervisedProcessResult) => void | Promise<void>,
): void {
  const onClose = (exitCode: number | null, signal: NodeJS.Signals | null) => {
    void resolve({
      outcome: "exited",
      exitCode,
      signal,
      stdout: finishOutput(stdout),
      stderr: finishOutput(stderr),
      truncated: stdout.truncated || stderr.truncated,
      elapsedMs: Number(hrtime.bigint() - startedAt) / 1_000_000,
      pid: child.pid ?? -1,
    });
  };
  if (closed) onClose(closed.exitCode, closed.signal);
  else child.once("close", onClose);
}
