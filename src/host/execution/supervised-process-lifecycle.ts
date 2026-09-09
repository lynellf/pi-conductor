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
