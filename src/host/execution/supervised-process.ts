import { hrtime } from "node:process";
import { observeMacWorkloadOutcome, releaseMacLeader } from "./macos/command-transport.js";
import {
  snapshotAdmissionScope,
  waitForAdmissionSettlement,
} from "./supervised-process-admission.js";
import {
  type SupervisedCleanupResult,
  safeTerminateOwnedGroupDetailed,
} from "./supervised-process-cleanup.js";
import {
  isSupervisedProcessSupported,
  SupervisedProcessAbortError,
  SupervisedProcessError,
  type SupervisedProcessOptions,
  type SupervisedProcessResult,
  SupervisedProcessTimeoutError,
} from "./supervised-process-contract.js";
import {
  findProcessesByOwnerToken,
  type ProcessIdentity,
  processGroupHasLiveMembers,
  readProcessGroupMembers,
  readProcessIdentity,
} from "./supervised-process-identity.js";
import {
  assertUnobservedAdmissionActive,
  DEFAULT_OUTPUT_LIMIT_BYTES,
  elapsedMs,
  leaderIdentityUnobserved,
  observationFailure,
  validateSupervisedProcessOptions,
} from "./supervised-process-lifecycle.js";
import { appendOutput, createOutputCapture, finishOutput } from "./supervised-process-output.js";
import { settleSupervisedProcess } from "./supervised-process-settlement.js";
import { spawnSupervisedChild } from "./supervised-process-transport.js";

// One owner keeps spawn, admission, cleanup, and close settlement coherent;
// identity, cleanup, and output helpers remain split below the module-size cap.
export {
  isSupervisedProcessSupported,
  SupervisedProcessAbortError,
  type SupervisedProcessDiagnostic,
  SupervisedProcessError,
  type SupervisedProcessFailureCode,
  type SupervisedProcessOptions,
  type SupervisedProcessResult,
  SupervisedProcessTimeoutError,
} from "./supervised-process-contract.js";
/** Run an executable with a deadline and verified platform-owned process-group cleanup. */
export async function runSupervisedProcess(
  options: SupervisedProcessOptions,
): Promise<SupervisedProcessResult> {
  if (!isSupervisedProcessSupported()) {
    throw new SupervisedProcessError(
      "supervised-process-unsupported",
      "supervised process cleanup requires Linux or a prepared macOS observer",
      "not-started",
      null,
    );
  }
  validateSupervisedProcessOptions(options);
  if (!options.executionId) throw new RangeError("executionId must be non-empty");
  await options.onStart({
    executionId: options.executionId,
    effectiveDeadlineMs: Date.now() + options.timeoutMs,
  });
  if (options.signal?.aborted) {
    throw new SupervisedProcessError(
      "supervised-process-aborted",
      "supervised process was aborted",
      "not-started",
      null,
    );
  }
  const graceMs = options.graceMs ?? 2_000;
  const outputLimitBytes = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
  const startedAt = hrtime.bigint();
  const processDeadline = Date.now() + options.timeoutMs;
  const supervisorIdentity = await readProcessIdentity(process.pid);
  const minimumOwnerStartTime = supervisorIdentity?.startTime;
  const observationScope = await snapshotAdmissionScope();
  if (Date.now() >= processDeadline) {
    throw new SupervisedProcessTimeoutError("not-started", null, 0);
  }
  if (options.signal?.aborted) {
    throw new SupervisedProcessAbortError("not-started", null, 0);
  }
  const stdout = createOutputCapture();
  const stderr = createOutputCapture();
  const total = { bytes: 0 };
  const child = spawnSupervisedChild(options);
  const workloadOutcome =
    process.platform === "darwin" ? observeMacWorkloadOutcome(child) : undefined;
  let spawnError: Error | undefined;
  let closed: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined;
  let resolveClose!: () => void;
  const closeObserved = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  child.once("error", (error) => {
    spawnError = error;
  });
  child.once("close", (exitCode, signal) => {
    closed = { exitCode, signal };
    resolveClose();
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    options.onOutput?.("stdout", chunk);
    appendOutput(stdout, total, chunk, outputLimitBytes);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    options.onOutput?.("stderr", chunk);
    appendOutput(stderr, total, chunk, outputLimitBytes);
  });
  if (child.stdin !== undefined) child.stdin.on("error", () => undefined);
  if (options.stdin !== undefined && options.deferStdinUntilSpawn !== true)
    child.stdin?.end(options.stdin);
  let identity: ProcessIdentity | null;
  try {
    identity =
      child.pid === undefined ? null : await readProcessIdentity(child.pid, options.executionId);
  } catch (error) {
    throw new SupervisedProcessError(
      "supervised-process-spawn-failed",
      error instanceof Error ? error.message : "could not observe process ownership",
      "unconfirmed",
      null,
      0,
      observationFailure(error, "read_stat", null),
    );
  }
  if (!identity) {
    const observedSpawnError = spawnError;
    if (observedSpawnError !== undefined) {
      throw new SupervisedProcessError(
        "supervised-process-spawn-failed",
        observedSpawnError.message,
        "not-started",
        null,
      );
    }
    if (closed === undefined) {
      const admission = await waitForAdmissionSettlement({
        closeObserved,
        signal: options.signal,
        deadlineMs: processDeadline,
      });
      if (admission === "aborted")
        throw new SupervisedProcessAbortError(
          "unconfirmed",
          null,
          elapsedMs(startedAt),
          leaderIdentityUnobserved,
        );
      if (admission === "deadline")
        throw new SupervisedProcessTimeoutError(
          "unconfirmed",
          null,
          elapsedMs(startedAt),
          leaderIdentityUnobserved,
        );
    }
    const afterAdmissionSpawnError = spawnError;
    if (afterAdmissionSpawnError !== undefined) {
      throw new SupervisedProcessError(
        "supervised-process-spawn-failed",
        afterAdmissionSpawnError.message,
        "not-started",
        null,
      );
    }
    assertUnobservedAdmissionActive(options.signal, processDeadline, startedAt);
    if (closed !== undefined && spawnError === undefined) {
      let groupLive: boolean;
      let escaped: readonly ProcessIdentity[];
      try {
        groupLive = child.pid === undefined ? false : await processGroupHasLiveMembers(child.pid);
        escaped = await findProcessesByOwnerToken(
          options.executionId,
          minimumOwnerStartTime,
          observationScope,
        );
      } catch (error) {
        throw new SupervisedProcessError(
          "supervised-process-spawn-failed",
          error instanceof Error ? error.message : "could not observe process ownership",
          "unconfirmed",
          null,
          elapsedMs(startedAt),
          observationFailure(error, "list_processes", null),
        );
      }
      assertUnobservedAdmissionActive(options.signal, processDeadline, startedAt);
      if (groupLive || escaped.length > 0) {
        let observedMembers: readonly ProcessIdentity[];
        try {
          observedMembers = groupLive ? await readProcessGroupMembers(child.pid ?? -1) : [];
        } catch (error) {
          throw new SupervisedProcessError(
            "supervised-process-spawn-failed",
            "process ownership evidence could not be observed",
            "unconfirmed",
            null,
            elapsedMs(startedAt),
            observationFailure(error, "read_stat", null),
          );
        }
        throw new SupervisedProcessError(
          "supervised-process-spawn-failed",
          "process exited but owned descendants remain",
          "unconfirmed",
          null,
          elapsedMs(startedAt),
          {
            cleanup_cause: "leader_exited_with_owned_descendants",
            leader_observed: false,
            observed_members: [...observedMembers, ...escaped]
              .slice(0, 32)
              .map(({ pid, startTime, processGroupId }) => ({
                pid,
                start_time: startTime,
                process_group_id: processGroupId,
              })),
          },
        );
      }
      const nativeOutcome = workloadOutcome?.();
      if (workloadOutcome !== undefined && nativeOutcome?.kind !== "exited") {
        throw new SupervisedProcessError(
          "supervised-process-spawn-failed",
          "workload terminal status unavailable",
          "confirmed",
          null,
          elapsedMs(startedAt),
        );
      }
      return {
        outcome: "exited",
        exitCode: nativeOutcome?.kind === "exited" ? nativeOutcome.exitCode : closed.exitCode,
        signal: nativeOutcome?.kind === "exited" ? nativeOutcome.signal : closed.signal,
        stdout: finishOutput(stdout),
        stderr: finishOutput(stderr),
        truncated: stdout.truncated || stderr.truncated,
        elapsedMs: Number(hrtime.bigint() - startedAt) / 1_000_000,
        pid: child.pid ?? -1,
      };
    }
    throw new SupervisedProcessError(
      "supervised-process-spawn-failed",
      "could not establish process ownership",
      "unconfirmed",
      null,
    );
  }
  if (spawnError) {
    throw new SupervisedProcessError(
      "supervised-process-spawn-failed",
      spawnError.message,
      "not-started",
      identity,
    );
  }
  let admissionCleanup: Promise<SupervisedCleanupResult> | undefined;
  let admissionTimer: ReturnType<typeof setTimeout> | undefined;
  let abortAdmission: (() => void) | undefined;
  let admissionReason: "timeout" | "aborted" | undefined;
  const startCleanup = (): Promise<SupervisedCleanupResult> => {
    admissionCleanup ??= safeTerminateOwnedGroupDetailed(identity, graceMs, observationScope);
    return admissionCleanup;
  };
  const admissionControl = new Promise<never>((_, reject) => {
    admissionTimer = setTimeout(
      () => {
        admissionReason = "timeout";
        void startCleanup();
        reject(new Error("supervised process admission deadline exceeded"));
      },
      Math.max(0, processDeadline - Date.now()),
    );
    abortAdmission = () => {
      admissionReason = "aborted";
      void startCleanup();
      reject(new Error("supervised process admission aborted"));
    };
    options.signal?.addEventListener("abort", abortAdmission, { once: true });
    if (options.signal?.aborted) abortAdmission();
  });
  try {
    await Promise.race([
      Promise.resolve().then(() =>
        options.onSpawn?.({ executionId: options.executionId, ...identity }),
      ),
      admissionControl,
    ]);
  } catch (error) {
    if (admissionTimer !== undefined) clearTimeout(admissionTimer);
    if (abortAdmission !== undefined) options.signal?.removeEventListener("abort", abortAdmission);
    const cleanupResult = await startCleanup();
    const cleanup = cleanupResult.cleanup;
    if (admissionReason === "timeout") {
      throw new SupervisedProcessTimeoutError(
        cleanup,
        identity,
        Number(hrtime.bigint() - startedAt) / 1_000_000,
        cleanupResult.diagnostic,
      );
    }
    if (admissionReason === "aborted") {
      throw new SupervisedProcessAbortError(
        cleanup,
        identity,
        Number(hrtime.bigint() - startedAt) / 1_000_000,
        cleanupResult.diagnostic,
      );
    }
    throw new SupervisedProcessError(
      "supervised-process-spawn-failed",
      error instanceof Error ? error.message : "failed to persist process ownership",
      cleanup,
      identity,
      Number(hrtime.bigint() - startedAt) / 1_000_000,
      cleanupResult.diagnostic,
    );
  }
  if (admissionTimer !== undefined) clearTimeout(admissionTimer);
  if (abortAdmission !== undefined) options.signal?.removeEventListener("abort", abortAdmission);
  if (admissionCleanup !== undefined) {
    const cleanupResult = await admissionCleanup;
    const cleanup = cleanupResult.cleanup;
    const elapsedMs = Number(hrtime.bigint() - startedAt) / 1_000_000;
    if (admissionReason === "aborted") {
      throw new SupervisedProcessAbortError(cleanup, identity, elapsedMs, cleanupResult.diagnostic);
    }
    throw new SupervisedProcessTimeoutError(cleanup, identity, elapsedMs, cleanupResult.diagnostic);
  }
  if (Date.now() >= processDeadline) {
    const cleanupResult = await safeTerminateOwnedGroupDetailed(
      identity,
      graceMs,
      observationScope,
    );
    throw new SupervisedProcessTimeoutError(
      cleanupResult.cleanup,
      identity,
      Number(hrtime.bigint() - startedAt) / 1_000_000,
      cleanupResult.diagnostic,
    );
  }
  if (options.signal?.aborted) {
    const cleanupResult = await safeTerminateOwnedGroupDetailed(
      identity,
      graceMs,
      observationScope,
    );
    throw new SupervisedProcessAbortError(
      cleanupResult.cleanup,
      identity,
      Number(hrtime.bigint() - startedAt) / 1_000_000,
      cleanupResult.diagnostic,
    );
  }
  if (options.stdin !== undefined && options.deferStdinUntilSpawn === true)
    child.stdin?.end(options.stdin);
  if (process.platform === "darwin") {
    try {
      releaseMacLeader(child, options);
    } catch {
      const result = await safeTerminateOwnedGroupDetailed(identity, graceMs, observationScope);
      throw new SupervisedProcessError(
        "supervised-process-spawn-failed",
        "native workload release failed",
        result.cleanup,
        identity,
        elapsedMs(startedAt),
        result.diagnostic,
      );
    }
  }
  return await settleSupervisedProcess({
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
    ...(workloadOutcome === undefined ? {} : { workloadOutcome }),
  });
}
