import { spawn } from "node:child_process";
import { hrtime } from "node:process";
import { waitForAdmissionSettlement } from "./supervised-process-admission.js";
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
  cleanupObservationFailure,
  DEFAULT_OUTPUT_LIMIT_BYTES,
  elapsedMs,
  leaderIdentityUnobserved,
  observeProcessClose,
  ownedObservationFailure,
  validateSupervisedProcessOptions,
} from "./supervised-process-lifecycle.js";
import { appendOutput, createOutputCapture, finishOutput } from "./supervised-process-output.js";

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
/** Spawn/identity/admission/close share one settlement boundary; helpers are split out. */
/** Run an executable with a deadline and owned Linux process-group cleanup. */
export async function runSupervisedProcess(
  options: SupervisedProcessOptions,
): Promise<SupervisedProcessResult> {
  if (!isSupervisedProcessSupported()) {
    throw new SupervisedProcessError(
      "supervised-process-unsupported",
      "supervised process cleanup requires Linux",
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
  if (Date.now() >= processDeadline) {
    throw new SupervisedProcessTimeoutError("not-started", null, 0);
  }
  if (options.signal?.aborted) {
    throw new SupervisedProcessAbortError("not-started", null, 0);
  }
  const stdout = createOutputCapture();
  const stderr = createOutputCapture();
  const total = { bytes: 0 };
  const child = options.file
    ? spawn(options.file, options.args ?? [], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env, PI_CONDUCTOR_EXECUTION_ID: options.executionId },
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      })
    : spawn(options.command ?? "", {
        cwd: options.cwd,
        env: { ...process.env, ...options.env, PI_CONDUCTOR_EXECUTION_ID: options.executionId },
        shell: true,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
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
  if (options.stdin !== undefined) child.stdin?.end(options.stdin);
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
      cleanupObservationFailure,
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
        escaped = await findProcessesByOwnerToken(options.executionId, minimumOwnerStartTime);
      } catch (error) {
        throw new SupervisedProcessError(
          "supervised-process-spawn-failed",
          error instanceof Error ? error.message : "could not observe process ownership",
          "unconfirmed",
          null,
          elapsedMs(startedAt),
          cleanupObservationFailure,
        );
      }
      assertUnobservedAdmissionActive(options.signal, processDeadline, startedAt);
      if (groupLive || escaped.length > 0) {
        let observedMembers: readonly ProcessIdentity[];
        try {
          observedMembers = groupLive ? await readProcessGroupMembers(child.pid ?? -1) : [];
        } catch {
          throw new SupervisedProcessError(
            "supervised-process-spawn-failed",
            "process ownership evidence could not be observed",
            "unconfirmed",
            null,
            elapsedMs(startedAt),
            {
              cleanup_cause: "cleanup_observation_failed",
              leader_observed: false,
              observed_members: [],
            },
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
      return {
        outcome: "exited",
        exitCode: closed.exitCode,
        signal: closed.signal,
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
    admissionCleanup ??= safeTerminateOwnedGroupDetailed(identity, graceMs);
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
    const cleanupResult = await safeTerminateOwnedGroupDetailed(identity, graceMs);
    throw new SupervisedProcessTimeoutError(
      cleanupResult.cleanup,
      identity,
      Number(hrtime.bigint() - startedAt) / 1_000_000,
      cleanupResult.diagnostic,
    );
  }
  if (options.signal?.aborted) {
    const cleanupResult = await safeTerminateOwnedGroupDetailed(identity, graceMs);
    throw new SupervisedProcessAbortError(
      cleanupResult.cleanup,
      identity,
      Number(hrtime.bigint() - startedAt) / 1_000_000,
      cleanupResult.diagnostic,
    );
  }
  return await new Promise<SupervisedProcessResult>((resolve, reject) => {
    let settled = false;
    let cleanupPromise: Promise<SupervisedCleanupResult> | undefined;
    const cleanupOwned = (): Promise<SupervisedCleanupResult> =>
      (cleanupPromise ??= safeTerminateOwnedGroupDetailed(identity, graceMs));
    const finishFailure = async (
      code: "supervised-process-timeout" | "supervised-process-aborted",
    ) => {
      if (settled) return;
      settled = true;
      const cleanupResult = await cleanupOwned();
      const cleanup = cleanupResult.cleanup;
      options.signal?.removeEventListener("abort", onAbort);
      const elapsedMs = Number(hrtime.bigint() - startedAt) / 1_000_000;
      const error =
        code === "supervised-process-timeout"
          ? new SupervisedProcessTimeoutError(
              cleanup,
              identity,
              elapsedMs,
              cleanupResult.diagnostic,
            )
          : new SupervisedProcessAbortError(cleanup, identity, elapsedMs, cleanupResult.diagnostic);
      clearTimeout(timer);
      reject(error);
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
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(
        new SupervisedProcessError(
          "supervised-process-spawn-failed",
          error.message,
          "not-started",
          identity,
        ),
      );
    });
    observeProcessClose(child, startedAt, stdout, stderr, closed, async (result) => {
      if (settled) return;
      try {
        if (await processGroupHasLiveMembers(identity.processGroupId)) {
          const cleanupResult = await cleanupOwned();
          if (cleanupResult.cleanup !== "confirmed") {
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
        }
        const escaped = await findProcessesByOwnerToken(options.executionId, identity.startTime);
        if (escaped.length > 0) {
          const cleanupResult = await cleanupOwned();
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
        if (settled) {
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
            ownedObservationFailure,
          ),
        );
        return;
      }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    });
  });
}
