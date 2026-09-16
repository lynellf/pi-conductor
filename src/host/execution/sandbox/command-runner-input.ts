/** Nonblocking FD 0 delivery for the verified Bubblewrap lifecycle (#115 §3). */

import type { ChildProcess } from "node:child_process";

/** Observable completion and one-way failure signal for an owned FD 0 write. */
export interface SandboxCommandInput {
  readonly settled: Promise<void>;
  readonly fault: Promise<never>;
}

/** Start input delivery without waiting for a pre-release sandbox process to read it. */
export function beginSandboxInput(
  child: ChildProcess,
  bytes: Buffer | undefined,
): SandboxCommandInput {
  if (bytes === undefined) return { settled: Promise.resolve(), fault: never() };
  const stream = child.stdin;
  if (stream === null) throw new Error("sandbox command stdin pipe is missing");
  let resolveSettled!: () => void;
  let rejectSettled!: (cause: unknown) => void;
  let rejectFault!: (cause: unknown) => void;
  const settled = new Promise<void>((resolve, reject) => {
    resolveSettled = resolve;
    rejectSettled = reject;
  });
  const fault = new Promise<never>((_resolve, reject) => {
    rejectFault = reject;
  });
  let failed = false;
  const fail = (cause: unknown) => {
    if (failed) return;
    failed = true;
    const error =
      cause instanceof Error ? cause : new Error("sandbox command stdin failed", { cause });
    rejectSettled(error);
    rejectFault(error);
  };
  stream.once("error", fail);
  // Awaiting this before bootstrap release deadlocks once bytes exceed pipe capacity.
  stream.end(bytes, (cause?: Error | null) => {
    if (cause == null) resolveSettled();
    else fail(cause);
  });
  void settled.catch(() => undefined);
  void fault.catch(() => undefined);
  return { settled, fault };
}

function never(): Promise<never> {
  return new Promise<never>(() => undefined);
}
