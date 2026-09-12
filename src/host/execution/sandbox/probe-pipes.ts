/** Bounded control/output channels for the fixed pre-admission probe (#106 §5–6). */
import type { ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type { SandboxProcessObservation } from "../../../persistence/sandbox-process.js";
import {
  BUBBLEWRAP_READY_FRAME,
  BUBBLEWRAP_RELEASE_FRAME,
  BubblewrapStatusParser,
  requireBubblewrapStartupStatus,
} from "./bootstrap.js";
import { observeSandboxProcess } from "./process-observation.js";

/** Own all probe listeners immediately after spawn, before any await. */
export function captureProbePipes(child: ChildProcess) {
  // Node's type declaration lists five tuple slots, though spawn supports more.
  const stdio: readonly (Readable | Writable | null | undefined)[] = child.stdio;
  const release = stdio[3],
    readyStream = stdio[4],
    statusStream = stdio[5];
  if (
    !(release instanceof Writable) ||
    !(readyStream instanceof Readable) ||
    !(statusStream instanceof Readable) ||
    child.stdout === null ||
    child.stderr === null
  )
    throw new Error("probe requires exactly six stdio/control descriptors");
  const fault = deferred<never>();
  const startup = deferred<{
    readonly observation: SandboxProcessObservation;
    readonly pidNamespace: number;
  }>();
  const ready = deferred<void>();
  const closed = deferred<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>();
  child.once("error", (cause) => {
    fault.reject(cause);
    closed.reject(cause);
  });
  child.once("close", (code, signal) => closed.resolve({ code, signal }));
  release.on("error", (cause) => fault.reject(cause));

  let readyBytes = "";
  readyStream.on("data", (chunk: Buffer) => {
    readyBytes = (
      readyBytes + chunk.subarray(0, BUBBLEWRAP_READY_FRAME.length + 1).toString("utf8")
    ).slice(0, BUBBLEWRAP_READY_FRAME.length + 1);
    if (readyBytes === BUBBLEWRAP_READY_FRAME) ready.resolve();
    else if (!BUBBLEWRAP_READY_FRAME.startsWith(readyBytes))
      fault.reject(new Error("invalid probe bootstrap READY frame"));
  });
  readyStream.once("error", (cause) => fault.reject(cause));
  readyStream.once("end", () => {
    if (readyBytes !== BUBBLEWRAP_READY_FRAME)
      fault.reject(new Error("probe bootstrap closed before READY"));
  });

  const parser = new BubblewrapStatusParser();
  let startupCount = 0,
    exitCode: number | undefined,
    statusBytes = 0;
  const statusDone = deferred<void>();
  statusStream.setEncoding("utf8");
  statusStream.on("data", (chunk: string) => {
    try {
      statusBytes += Buffer.byteLength(chunk);
      if (statusBytes > 65536) throw new Error("probe status exceeds 64 KiB");
      for (const frame of parser.push(chunk)) {
        if ("child-pid" in frame) {
          if (++startupCount !== 1 || exitCode !== undefined)
            throw new Error("duplicate/out-of-order probe startup frame");
          const status = requireBubblewrapStartupStatus(frame);
          // Begin identity capture in the status handler. READY alone cannot release anything.
          void observeSandboxProcess(status.childPid).then(
            (observation) => startup.resolve({ observation, pidNamespace: status.pidNamespace }),
            (cause) => fault.reject(cause),
          );
        } else if ("exit-code" in frame) {
          if (
            startupCount !== 1 ||
            exitCode !== undefined ||
            Object.keys(frame).length !== 1 ||
            !Number.isInteger(frame["exit-code"]) ||
            Number(frame["exit-code"]) < 0 ||
            Number(frame["exit-code"]) > 255
          )
            throw new Error("invalid probe exit frame");
          exitCode = Number(frame["exit-code"]);
        } else throw new Error("unknown probe status frame");
      }
    } catch (cause) {
      fault.reject(cause);
    }
  });
  statusStream.once("error", (cause) => fault.reject(cause));
  statusStream.once("end", () => {
    try {
      parser.finish();
      if (startupCount !== 1 || exitCode === undefined)
        throw new Error("probe status ended without correlated lifecycle");
      statusDone.resolve();
    } catch (cause) {
      fault.reject(cause);
    }
  });
  const stdout = collect(child.stdout, 128 * 1024, fault.reject);
  const stderr = collect(child.stderr, 64 * 1024, fault.reject);
  return {
    fault: fault.promise,
    startup: startup.promise,
    ready: ready.promise,
    closed: closed.promise,
    diagnostics: () => ({
      stdout: stdout.snapshot(),
      stderr: stderr.snapshot(),
      ready: readyBytes,
      statusBytes,
      exitCode,
    }),
    release: () =>
      new Promise<void>((resolve, reject) => {
        release.end(BUBBLEWRAP_RELEASE_FRAME, (cause?: Error | null) =>
          cause == null ? resolve() : reject(cause),
        );
      }),
    deny: () => {
      if (!release.writableEnded && !release.destroyed) release.end();
    },
    settle: async () => {
      const [result, output, errors] = await Promise.race([
        Promise.all([closed.promise, stdout.done, stderr.done, statusDone.promise]),
        fault.promise,
      ]);
      if (
        result.signal !== null ||
        result.code !== exitCode ||
        exitCode !== 0 ||
        errors.length !== 0
      )
        throw new Error(
          `probe failed: exit=${result.code} signal=${result.signal} stderr_bytes=${Buffer.byteLength(errors)}`,
        );
      return { stdout: output, code: exitCode };
    },
  };
}

function collect(stream: Readable, limit: number, fail: (cause: unknown) => void) {
  const done = deferred<string>();
  const chunks: Buffer[] = [];
  let bytes = 0;
  stream.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= limit) chunks.push(Buffer.from(chunk));
    else fail(new Error("probe output exceeds its bound"));
  });
  stream.once("error", (cause) => {
    fail(cause);
    done.reject(cause);
  });
  stream.once("end", () => done.resolve(Buffer.concat(chunks).toString("utf8")));
  return { done: done.promise, snapshot: () => Buffer.concat(chunks).toString("utf8") };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Consumers race setup phases; every early rejection remains observed until that race settles.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
