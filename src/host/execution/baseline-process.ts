/** Portable foreground execution; explicitly no descendant-cleanup proof (§5). */
import { type ChildProcess, spawn } from "node:child_process";
import { BaselineProcessError } from "./baseline-process-error.js";
import { armDeadline } from "./deadline-timer.js";
import type {
  SupervisedProcessOptions,
  SupervisedProcessResult,
} from "./supervised-process-contract.js";

import {
  DEFAULT_OUTPUT_LIMIT_BYTES,
  validateSupervisedProcessOptions,
} from "./supervised-process-lifecycle.js";
import { appendOutput, createOutputCapture, finishOutput } from "./supervised-process-output.js";

/** Host-owned per-child tracking, never a model-controlled cleanup witness. */
export interface BaselineProcessOptions extends SupervisedProcessOptions {
  readonly trackForeground?: () => (status: "closed" | "not-started") => void;
}

async function boundedClose(close: Promise<void>, milliseconds: number): Promise<void> {
  let cancel = () => {};
  try {
    await Promise.race([
      close,
      new Promise<void>((resolve) => {
        cancel = armDeadline(Date.now() + milliseconds, resolve);
      }),
    ]);
  } finally {
    cancel();
  }
}

function signalLiveChild(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
  // Never recover/signal a persisted PID. Even a live handle gives only best effort.
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* Still no cleanup proof. */
    }
  }
}

/** Run with a fixed deadline and finite best-effort cancellation, never confirmed cleanup. */
export async function runBaselineProcess(
  options: BaselineProcessOptions,
): Promise<SupervisedProcessResult> {
  validateSupervisedProcessOptions(options);
  if (!options.executionId) throw new RangeError("executionId must be non-empty");
  if (options.onSpawn !== undefined || options.deferStdinUntilSpawn === true)
    throw new Error("baseline execution cannot provide an owned process identity");
  const failure = (
    code: "timeout" | "aborted" | "transport",
    status: "closed" | "not-started" | "unobserved",
    elapsed: number,
    observeForeground?: () => "closed" | "unobserved",
  ) =>
    new BaselineProcessError(
      code === "timeout"
        ? "supervised-process-timeout"
        : code === "aborted"
          ? "supervised-process-aborted"
          : "supervised-process-spawn-failed",
      `baseline process ${code}`,
      status,
      elapsed,
      observeForeground,
    );
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  let cancelAdmission = () => {};
  const abortAdmission = new AbortController();
  const onAdmissionAbort = () => abortAdmission.abort();
  options.signal?.addEventListener("abort", onAdmissionAbort, { once: true });
  try {
    if (options.signal?.aborted) throw failure("aborted", "not-started", 0);
    const admission = Promise.resolve().then(() =>
      options.onStart({
        executionId: options.executionId,
        effectiveDeadlineMs: deadline,
      }),
    );
    await Promise.race([
      admission,
      new Promise<never>((_, reject) => {
        cancelAdmission = armDeadline(deadline, () =>
          reject(failure("timeout", "not-started", Date.now() - startedAt)),
        );
        abortAdmission.signal.addEventListener(
          "abort",
          () => reject(failure("aborted", "not-started", Date.now() - startedAt)),
          { once: true },
        );
        if (options.signal?.aborted) abortAdmission.abort();
      }),
    ]);
  } finally {
    cancelAdmission();
    options.signal?.removeEventListener("abort", onAdmissionAbort);
  }
  if (options.signal?.aborted) throw failure("aborted", "not-started", Date.now() - startedAt);
  if (Date.now() >= deadline) throw failure("timeout", "not-started", Date.now() - startedAt);
  const settleForeground = options.trackForeground?.();
  let child: ChildProcess;
  try {
    child =
      options.file !== undefined
        ? spawn(options.file, options.args ?? [], {
            cwd: options.cwd,
            env: { ...(options.inheritEnv === false ? {} : process.env), ...options.env },
            shell: false,
            detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
          })
        : spawn(options.command ?? "", {
            cwd: options.cwd,
            env: { ...(options.inheritEnv === false ? {} : process.env), ...options.env },
            shell: true,
            detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
          });
  } catch {
    settleForeground?.("not-started");
    throw failure("transport", "not-started", Date.now() - startedAt);
  }
  const stdout = createOutputCapture();
  const stderr = createOutputCapture();
  const total = { bytes: 0 };
  let resolveClose!: () => void;
  const close = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  let claimed = false;
  let foregroundClosed = false;
  return new Promise<SupervisedProcessResult>((resolve, reject) => {
    let cancelTimer = () => {};
    const dispose = () => {
      cancelTimer();
      options.signal?.removeEventListener("abort", onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      child.unref();
    };
    const terminate = async (code: "timeout" | "aborted" | "transport") => {
      if (claimed) return;
      claimed = true;
      cancelTimer();
      options.signal?.removeEventListener("abort", onAbort);
      signalLiveChild(child, "SIGTERM");
      await boundedClose(close, options.graceMs ?? 2000);
      signalLiveChild(child, "SIGKILL");
      await boundedClose(close, 250);
      dispose();
      reject(
        failure(code, foregroundClosed ? "closed" : "unobserved", Date.now() - startedAt, () =>
          foregroundClosed ? "closed" : "unobserved",
        ),
      );
    };
    const onAbort = () => {
      void terminate("aborted");
    };
    child.once("close", (exitCode, signal) => {
      foregroundClosed = true;
      settleForeground?.("closed");
      resolveClose();
      if (claimed) return;
      if (options.signal?.aborted) {
        void terminate("aborted");
        return;
      }
      if (Date.now() >= deadline) {
        void terminate("timeout");
        return;
      }
      if (signal === null && exitCode === null) {
        void terminate("transport");
        return;
      }
      claimed = true;
      dispose();
      resolve({
        outcome: "exited",
        exitCode,
        signal,
        stdout: finishOutput(stdout),
        stderr: finishOutput(stderr),
        truncated: stdout.truncated || stderr.truncated,
        elapsedMs: Date.now() - startedAt,
        pid: child.pid ?? -1,
      });
    });
    child.on("error", () => {
      if (claimed) return;
      if (child.pid !== undefined) {
        void terminate("transport");
        return;
      }
      claimed = true;
      dispose();
      settleForeground?.("not-started");
      reject(failure("transport", "not-started", Date.now() - startedAt));
    });
    for (const stream of ["stdout", "stderr"] as const)
      child[stream]?.on("data", (chunk: Buffer) => {
        if (claimed) return;
        appendOutput(
          stream === "stdout" ? stdout : stderr,
          total,
          chunk,
          options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
        );
        try {
          options.onOutput?.(stream, chunk);
        } catch {
          void terminate("transport");
        }
      });
    child.stdin?.on("error", () => undefined);
    cancelTimer = armDeadline(deadline, () => {
      void terminate(options.signal?.aborted ? "aborted" : "timeout");
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    child.stdin?.end(options.stdin);
  });
}
