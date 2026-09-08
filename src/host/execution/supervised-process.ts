/** Spawn/identity/admission/close share one settlement boundary; helpers are split out. */

import { type ChildProcess, spawn } from "node:child_process";
import { hrtime } from "node:process";
import { waitForAdmissionSettlement } from "./supervised-process-admission.js";
import { safeTerminateOwnedGroup } from "./supervised-process-cleanup.js";
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
  readProcessIdentity,
} from "./supervised-process-identity.js";
import {
  appendOutput,
  createOutputCapture,
  finishOutput,
  type OutputCapture,
} from "./supervised-process-output.js";

export {
  isSupervisedProcessSupported,
  SupervisedProcessAbortError,
  SupervisedProcessError,
  type SupervisedProcessFailureCode,
  type SupervisedProcessOptions,
  type SupervisedProcessResult,
  SupervisedProcessTimeoutError,
} from "./supervised-process-contract.js";

const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;

function elapsedMs(startedAt: bigint): number {
  return Number(hrtime.bigint() - startedAt) / 1_000_000;
}

function validateOptions(options: SupervisedProcessOptions): void {
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

function closeResult(
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
  validateOptions(options);
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
  const readSpawnError = (): Error | undefined => spawnError;
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
    );
  }
  if (!identity) {
    const observedSpawnError = readSpawnError();
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
        throw new SupervisedProcessAbortError("unconfirmed", null, elapsedMs(startedAt));
      if (admission === "deadline")
        throw new SupervisedProcessTimeoutError("unconfirmed", null, elapsedMs(startedAt));
    }
    const afterAdmissionSpawnError = readSpawnError();
    if (afterAdmissionSpawnError !== undefined) {
      throw new SupervisedProcessError(
        "supervised-process-spawn-failed",
        afterAdmissionSpawnError.message,
        "not-started",
        null,
      );
    }
    if (options.signal?.aborted)
      throw new SupervisedProcessAbortError("unconfirmed", null, elapsedMs(startedAt));
    if (Date.now() >= processDeadline)
      throw new SupervisedProcessTimeoutError("unconfirmed", null, elapsedMs(startedAt));
    if (closed !== undefined && readSpawnError() === undefined) {
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
        );
      }
      if (options.signal?.aborted)
        throw new SupervisedProcessAbortError("unconfirmed", null, elapsedMs(startedAt));
      if (Date.now() >= processDeadline)
        throw new SupervisedProcessTimeoutError("unconfirmed", null, elapsedMs(startedAt));
      if (groupLive || escaped.length > 0) {
        throw new SupervisedProcessError(
          "supervised-process-spawn-failed",
          "process exited but owned descendants remain",
          "unconfirmed",
          null,
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
  let admissionCleanup: Promise<"confirmed" | "unconfirmed"> | undefined;
  let admissionTimer: ReturnType<typeof setTimeout> | undefined;
  let abortAdmission: (() => void) | undefined;
  let admissionReason: "timeout" | "aborted" | undefined;
  const startCleanup = (): Promise<"confirmed" | "unconfirmed"> => {
    admissionCleanup ??= safeTerminateOwnedGroup(identity, graceMs);
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
    const cleanup = await startCleanup();
    if (admissionReason === "timeout") {
      throw new SupervisedProcessTimeoutError(
        cleanup,
        identity,
        Number(hrtime.bigint() - startedAt) / 1_000_000,
      );
    }
    if (admissionReason === "aborted") {
      throw new SupervisedProcessAbortError(
        cleanup,
        identity,
        Number(hrtime.bigint() - startedAt) / 1_000_000,
      );
    }
    throw new SupervisedProcessError(
      "supervised-process-spawn-failed",
      error instanceof Error ? error.message : "failed to persist process ownership",
      cleanup,
      identity,
    );
  }
  if (admissionTimer !== undefined) clearTimeout(admissionTimer);
  if (abortAdmission !== undefined) options.signal?.removeEventListener("abort", abortAdmission);
  if (admissionCleanup !== undefined) {
    const cleanup = await admissionCleanup;
    const elapsedMs = Number(hrtime.bigint() - startedAt) / 1_000_000;
    if (admissionReason === "aborted") {
      throw new SupervisedProcessAbortError(cleanup, identity, elapsedMs);
    }
    throw new SupervisedProcessTimeoutError(cleanup, identity, elapsedMs);
  }
  if (Date.now() >= processDeadline) {
    const cleanup = await safeTerminateOwnedGroup(identity, graceMs);
    throw new SupervisedProcessTimeoutError(
      cleanup,
      identity,
      Number(hrtime.bigint() - startedAt) / 1_000_000,
    );
  }
  if (options.signal?.aborted) {
    const cleanup = await safeTerminateOwnedGroup(identity, graceMs);
    throw new SupervisedProcessAbortError(
      cleanup,
      identity,
      Number(hrtime.bigint() - startedAt) / 1_000_000,
    );
  }
  return await new Promise<SupervisedProcessResult>((resolve, reject) => {
    let settled = false;
    let cleanupPromise: Promise<"confirmed" | "unconfirmed"> | undefined;
    const cleanupOwned = (): Promise<"confirmed" | "unconfirmed"> =>
      (cleanupPromise ??= safeTerminateOwnedGroup(identity, graceMs));
    const finishFailure = async (
      code: "supervised-process-timeout" | "supervised-process-aborted",
    ) => {
      if (settled) return;
      settled = true;
      const cleanup = await cleanupOwned();
      options.signal?.removeEventListener("abort", onAbort);
      const elapsedMs = Number(hrtime.bigint() - startedAt) / 1_000_000;
      const error =
        code === "supervised-process-timeout"
          ? new SupervisedProcessTimeoutError(cleanup, identity, elapsedMs)
          : new SupervisedProcessAbortError(cleanup, identity, elapsedMs);
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
    closeResult(child, startedAt, stdout, stderr, closed, async (result) => {
      if (settled) return;
      try {
        if (await processGroupHasLiveMembers(identity.processGroupId)) {
          const cleanup = await cleanupOwned();
          if (cleanup !== "confirmed") {
            settled = true;
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
            reject(
              new SupervisedProcessError(
                "supervised-process-spawn-failed",
                "process group remained active after child exit",
                cleanup,
                identity,
                result.elapsedMs,
              ),
            );
            return;
          }
        }
        if ((await findProcessesByOwnerToken(options.executionId, identity.startTime)).length > 0) {
          await cleanupOwned();
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
