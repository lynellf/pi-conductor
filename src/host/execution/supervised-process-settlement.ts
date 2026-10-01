/** One terminal/cleanup owner after spawn admission; shared by Linux and Darwin (#76/#165). */
import type { ChildProcess } from "node:child_process";
import { hrtime } from "node:process";
import type { MacWorkloadOutcome } from "./macos/command-transport.js";
import {
  type SupervisedCleanupResult,
  safeTerminateOwnedGroupDetailed,
} from "./supervised-process-cleanup.js";
import {
  SupervisedProcessAbortError,
  SupervisedProcessError,
  type SupervisedProcessOptions,
  type SupervisedProcessResult,
  SupervisedProcessTimeoutError,
} from "./supervised-process-contract.js";
import {
  findProcessesByOwnerToken,
  type ProcessIdentity,
  type ProcessObservationScope,
  processGroupHasLiveMembers,
} from "./supervised-process-identity.js";
import { observationFailure, observeProcessClose } from "./supervised-process-lifecycle.js";
import type { OutputCapture } from "./supervised-process-output.js";

/** Settle output and ownership together; timers never resolve before owned cleanup. */
export function settleSupervisedProcess(input: {
  readonly options: SupervisedProcessOptions;
  readonly child: ChildProcess;
  readonly identity: ProcessIdentity;
  readonly startedAt: bigint;
  readonly processDeadline: number;
  readonly graceMs: number;
  readonly observationScope: ProcessObservationScope;
  readonly stdout: OutputCapture;
  readonly stderr: OutputCapture;
  readonly closed: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined;
  readonly workloadOutcome?: () => MacWorkloadOutcome | null;
}): Promise<SupervisedProcessResult> {
  const {
    options,
    child,
    identity,
    startedAt,
    processDeadline,
    graceMs,
    observationScope,
    stdout,
    stderr,
    closed,
  } = input;
  return new Promise<SupervisedProcessResult>((resolve, reject) => {
    let settled = false;
    let cleanupPromise: Promise<SupervisedCleanupResult> | undefined;
    const cleanupOwned = (): Promise<SupervisedCleanupResult> =>
      (cleanupPromise ??= safeTerminateOwnedGroupDetailed(identity, graceMs, observationScope));
    const finishFailure = async (
      code:
        | "supervised-process-timeout"
        | "supervised-process-aborted"
        | "supervised-process-spawn-failed",
    ) => {
      if (settled) return;
      settled = true;
      const cleanupResult = await cleanupOwned();
      const cleanup = cleanupResult.cleanup;
      options.signal?.removeEventListener("abort", onAbort);
      const elapsedMs = Number(hrtime.bigint() - startedAt) / 1_000_000;
      let error: SupervisedProcessError;
      if (code === "supervised-process-timeout")
        error = new SupervisedProcessTimeoutError(
          cleanup,
          identity,
          elapsedMs,
          cleanupResult.diagnostic,
        );
      else if (code === "supervised-process-aborted")
        error = new SupervisedProcessAbortError(
          cleanup,
          identity,
          elapsedMs,
          cleanupResult.diagnostic,
        );
      else
        error = new SupervisedProcessError(
          code,
          "owned process transport failed",
          cleanup,
          identity,
          elapsedMs,
          cleanupResult.diagnostic,
        );
      clearTimeout(timer);
      reject(error);
    };
    const cancellationWon = (): boolean => {
      if (settled) return true;
      if (options.signal?.aborted || Date.now() >= processDeadline) {
        void finishFailure(
          options.signal?.aborted ? "supervised-process-aborted" : "supervised-process-timeout",
        );
        return true;
      }
      return false;
    };
    const onAbort = () => void finishFailure("supervised-process-aborted");
    const timer = setTimeout(
      () =>
        void finishFailure(
          options.signal?.aborted ? "supervised-process-aborted" : "supervised-process-timeout",
        ),
      Math.max(0, processDeadline - Date.now()),
    );
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) void finishFailure("supervised-process-aborted");
    // Identity is already admitted here. Node error also covers kill/transport
    // failures after spawn; it cannot justify not-started or bypass owned cleanup.
    child.once("error", () => {
      if (!cancellationWon()) void finishFailure("supervised-process-spawn-failed");
    });
    observeProcessClose(child, startedAt, stdout, stderr, closed, async (result) => {
      if (cancellationWon()) return;
      try {
        if (await processGroupHasLiveMembers(identity.processGroupId)) {
          const cleanupResult = await cleanupOwned();
          if (cancellationWon()) return;
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          reject(
            new SupervisedProcessError(
              "supervised-process-spawn-failed",
              "process group remained active after child exit",
              cleanupResult.cleanup,
              identity,
              result.elapsedMs,
              cleanupResult.diagnostic,
            ),
          );
          return;
        }
        const escaped = await findProcessesByOwnerToken(
          options.executionId,
          identity.startTime,
          observationScope,
        );
        if (escaped.length > 0) {
          const cleanupResult = await cleanupOwned();
          if (cancellationWon()) return;
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          reject(
            new SupervisedProcessError(
              "supervised-process-spawn-failed",
              "owned descendant remained after child exit",
              "unconfirmed",
              identity,
              result.elapsedMs,
              cleanupResult.diagnostic ?? {
                cleanup_cause: "escaped_owned_processes",
                leader_observed: true,
                observed_members: escaped
                  .slice(0, 32)
                  .map(({ pid, startTime, processGroupId }) => ({
                    pid,
                    start_time: startTime,
                    process_group_id: processGroupId,
                  })),
              },
            ),
          );
          return;
        }
      } catch (error) {
        if (cancellationWon()) {
          await cleanupOwned();
          return;
        }
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        reject(
          new SupervisedProcessError(
            "supervised-process-spawn-failed",
            error instanceof Error ? error.message : "could not observe owned descendants",
            "unconfirmed",
            identity,
            result.elapsedMs,
            observationFailure(error, "list_processes", identity),
          ),
        );
        return;
      }
      if (cancellationWon()) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const nativeOutcome = input.workloadOutcome?.();
      if (input.workloadOutcome !== undefined && nativeOutcome?.kind !== "exited") {
        reject(
          new SupervisedProcessError(
            "supervised-process-spawn-failed",
            nativeOutcome?.kind === "spawn_failed"
              ? "workload executable could not be spawned"
              : "workload terminal status unavailable",
            "confirmed",
            identity,
            result.elapsedMs,
          ),
        );
      } else if (nativeOutcome?.kind === "exited") {
        resolve({ ...result, exitCode: nativeOutcome.exitCode, signal: nativeOutcome.signal });
      } else resolve(result);
    });
  });
}
