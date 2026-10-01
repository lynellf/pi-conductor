/** Portable foreground execution; explicitly no descendant-cleanup proof (§5). */
import { type ChildProcess, spawn } from "node:child_process";
import { armDeadline } from "./deadline-timer.js";
import {
  SupervisedProcessAbortError,
  SupervisedProcessError,
  type SupervisedProcessOptions,
  type SupervisedProcessResult,
  SupervisedProcessTimeoutError,
} from "./supervised-process-contract.js";
import {
  DEFAULT_OUTPUT_LIMIT_BYTES,
  validateSupervisedProcessOptions,
} from "./supervised-process-lifecycle.js";
import { appendOutput, createOutputCapture, finishOutput } from "./supervised-process-output.js";

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
  options: SupervisedProcessOptions,
): Promise<SupervisedProcessResult> {
  validateSupervisedProcessOptions(options);
  if (!options.executionId) throw new RangeError("executionId must be non-empty");
  if (options.onSpawn !== undefined || options.deferStdinUntilSpawn === true)
    throw new Error("baseline execution cannot provide an owned process identity");
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  let cancelAdmission = () => {};
  const abortAdmission = new AbortController();
  const onAdmissionAbort = () => abortAdmission.abort();
  options.signal?.addEventListener("abort", onAdmissionAbort, { once: true });
  try {
    if (options.signal?.aborted) throw new SupervisedProcessAbortError("not-started", null, 0);
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
          reject(new SupervisedProcessTimeoutError("not-started", null, Date.now() - startedAt)),
        );
        abortAdmission.signal.addEventListener(
          "abort",
          () =>
            reject(new SupervisedProcessAbortError("not-started", null, Date.now() - startedAt)),
          { once: true },
        );
        if (options.signal?.aborted) abortAdmission.abort();
      }),
    ]);
  } finally {
    cancelAdmission();
    options.signal?.removeEventListener("abort", onAdmissionAbort);
  }
  if (options.signal?.aborted)
    throw new SupervisedProcessAbortError("not-started", null, Date.now() - startedAt);
  if (Date.now() >= deadline)
    throw new SupervisedProcessTimeoutError("not-started", null, Date.now() - startedAt);
  const child =
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
  const stdout = createOutputCapture();
  const stderr = createOutputCapture();
  const total = { bytes: 0 };
  let resolveClose!: () => void;
  const close = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  let claimed = false;
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
      const elapsed = Date.now() - startedAt;
      reject(
        code === "timeout"
          ? new SupervisedProcessTimeoutError("unconfirmed", null, elapsed)
          : code === "aborted"
            ? new SupervisedProcessAbortError("unconfirmed", null, elapsed)
            : new SupervisedProcessError(
                "supervised-process-spawn-failed",
                "baseline process transport failed",
                "unconfirmed",
                null,
                elapsed,
              ),
      );
    };
    const onAbort = () => {
      void terminate("aborted");
    };
    child.once("close", (exitCode, signal) => {
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
      if (signal !== null || exitCode === null) {
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
      reject(
        new SupervisedProcessError(
          "supervised-process-spawn-failed",
          "baseline executable could not be spawned",
          "not-started",
          null,
          Date.now() - startedAt,
        ),
      );
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
