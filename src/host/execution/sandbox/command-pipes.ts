/** Production command pipe ownership and Bubblewrap lifecycle correlation (#106 §6–7). */
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

const MAX_STATUS_BYTES = 64 * 1024;
const MAX_READY_BYTES = Buffer.byteLength(BUBBLEWRAP_READY_FRAME) + 1;

/** Host-private output destinations owned by one sandbox command. */
export interface SandboxCommandPipeDestinations {
  readonly stdout: Writable;
  readonly stderr: Writable;
}

/** Early namespace-init identity captured from the startup status frame. */
export interface SandboxCommandStartup {
  readonly observation: SandboxProcessObservation;
  readonly pidNamespace: number;
}

/** Launcher close event retained separately from validated command status. */
export interface SandboxCommandClose {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** Immediately attached handles for one owned sandbox command lifecycle. */
export interface SandboxCommandPipes {
  readonly startup: Promise<SandboxCommandStartup>;
  readonly ready: Promise<void>;
  readonly fault: Promise<never>;
  readonly closed: Promise<SandboxCommandClose>;
  /** Physical pipe/child termination, independent of protocol validity. */
  readonly drained: Promise<void>;
  /** Validated raw Bubblewrap command status after every owned channel settles. */
  readonly settlement: Promise<number>;
  readonly release: () => Promise<void>;
  readonly deny: () => void;
}

/** Attach every production command listener synchronously after spawn (#106 §6–7). */
export function captureSandboxCommandPipes(
  child: ChildProcess,
  destinations: SandboxCommandPipeDestinations,
): SandboxCommandPipes {
  // Node types expose a five-slot tuple even though spawn accepts additional descriptors.
  const stdio: readonly (Readable | Writable | null | undefined)[] = child.stdio;
  const releaseStream = stdio[3];
  const readyStream = stdio[4];
  const statusStream = stdio[5];
  if (
    !(releaseStream instanceof Writable) ||
    !(readyStream instanceof Readable) ||
    !(statusStream instanceof Readable) ||
    child.stdout === null ||
    child.stderr === null ||
    !(destinations.stdout instanceof Writable) ||
    !(destinations.stderr instanceof Writable)
  ) {
    throw new Error(
      "sandbox command requires exactly six stdio/control descriptors and two output destinations",
    );
  }

  const fault = deferred<never>();
  const startup = deferred<SandboxCommandStartup>();
  const ready = deferred<void>();
  const closed = deferred<SandboxCommandClose>();
  const launcherClosed = deferred<void>();
  let didFault = false;
  let firstFault: Error | undefined;
  const fail = (cause: unknown): void => {
    if (didFault) return;
    didFault = true;
    const error =
      cause instanceof Error ? cause : new Error("sandbox command pipe failed", { cause });
    firstFault = error;
    fault.reject(error);
    startup.reject(error);
    ready.reject(error);
  };

  const readyDone = terminalReadable(readyStream, "READY control pipe", fail);
  const statusDone = deferred<void>();
  const stdoutDone = pipeOutput(child.stdout, destinations.stdout, "stdout", fail);
  const stderrDone = pipeOutput(child.stderr, destinations.stderr, "stderr", fail);

  child.once("error", (cause) => {
    fail(cause);
    closed.reject(cause);
  });
  child.once("close", (code, signal) => {
    closed.resolve({ code, signal });
    launcherClosed.resolve();
  });
  releaseStream.once("error", fail);

  let readyBytes = Buffer.alloc(0);
  readyStream.on("data", (value: Buffer | string) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    readyBytes = Buffer.concat(
      [readyBytes, chunk],
      Math.min(MAX_READY_BYTES, readyBytes.length + chunk.length),
    );
    const text = readyBytes.toString("utf8");
    if (text === BUBBLEWRAP_READY_FRAME) ready.resolve();
    else if (!BUBBLEWRAP_READY_FRAME.startsWith(text) || readyBytes.length >= MAX_READY_BYTES)
      fail(new Error("invalid sandbox bootstrap READY frame"));
  });
  readyStream.once("end", () => {
    if (!readyBytes.equals(Buffer.from(BUBBLEWRAP_READY_FRAME)))
      fail(new Error("sandbox bootstrap closed before exact READY"));
  });

  const parser = new BubblewrapStatusParser();
  let statusBytes = 0;
  let startupCount = 0;
  let exitCount = 0;
  let exitCode: number | undefined;
  let statusEnded = false;
  statusStream.setEncoding("utf8");
  statusStream.on("data", (chunk: string) => {
    try {
      statusBytes += Buffer.byteLength(chunk);
      if (statusBytes > MAX_STATUS_BYTES) throw new Error("sandbox status exceeds 64 KiB");
      for (const frame of parser.push(chunk)) {
        if ("child-pid" in frame) {
          if (++startupCount !== 1 || exitCount !== 0)
            throw new Error("duplicate or out-of-order sandbox startup frame");
          const status = requireBubblewrapStartupStatus(frame);
          // This must begin in the JSON handler so READY cannot race identity capture.
          void observeSandboxProcess(status.childPid).then(
            (observation) => startup.resolve({ observation, pidNamespace: status.pidNamespace }),
            fail,
          );
          continue;
        }
        if ("exit-code" in frame) {
          if (++exitCount !== 1 || startupCount !== 1 || Object.keys(frame).length !== 1)
            throw new Error("invalid sandbox exit frame ordering");
          const value = frame["exit-code"];
          if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 255)
            throw new Error("invalid sandbox exit status");
          exitCode = value;
          continue;
        }
        throw new Error("unknown sandbox status frame");
      }
    } catch (cause) {
      fail(cause);
    }
  });
  statusStream.once("error", (cause) => {
    fail(cause);
    statusDone.resolve();
  });
  statusStream.once("end", () => {
    statusEnded = true;
    try {
      parser.finish();
      if (startupCount !== 1 || exitCount !== 1 || exitCode === undefined)
        throw new Error("sandbox status ended without exact lifecycle frames");
      statusDone.resolve();
    } catch (cause) {
      fail(cause);
      statusDone.resolve();
    }
  });
  statusStream.once("close", () => {
    if (!statusEnded) fail(new Error("sandbox status pipe closed before end"));
    statusDone.resolve();
  });

  const drained = Promise.all([
    launcherClosed.promise,
    readyDone,
    statusDone.promise,
    stdoutDone,
    stderrDone,
  ]).then(() => undefined);
  observe(drained);

  const settlement = Promise.race([
    fault.promise,
    Promise.all([
      closed.promise,
      startup.promise,
      readyDone,
      statusDone.promise,
      stdoutDone,
      stderrDone,
    ]).then(([close]) => {
      if (didFault || startupCount !== 1 || exitCount !== 1 || exitCode === undefined)
        throw new Error("sandbox command lifecycle is incomplete");
      if (close.signal !== null || close.code !== exitCode)
        throw new Error("sandbox launcher close did not match command status");
      return exitCode;
    }),
  ]);
  observe(settlement);

  let gate: "open" | "released" | "denied" = "open";
  return {
    startup: startup.promise,
    ready: ready.promise,
    fault: fault.promise,
    closed: closed.promise,
    drained,
    settlement,
    release: () => {
      if (didFault)
        return Promise.reject(
          new Error("sandbox release gate faulted before release", { cause: firstFault }),
        );
      if (gate !== "open") return Promise.reject(new Error(`sandbox release gate already ${gate}`));
      gate = "released";
      return endWritable(releaseStream, BUBBLEWRAP_RELEASE_FRAME);
    },
    deny: () => {
      if (gate !== "open") return;
      gate = "denied";
      releaseStream.end();
    },
  };
}

function pipeOutput(
  source: Readable,
  destination: Writable,
  name: string,
  fail: (cause: unknown) => void,
) {
  const sourceDone = deferred<void>();
  const destinationDone = deferred<void>();
  let sourceEnded = false;
  source.once("end", () => {
    sourceEnded = true;
    sourceDone.resolve();
  });
  source.once("error", (cause) => {
    fail(cause);
    if (!destination.destroyed)
      destination.destroy(
        cause instanceof Error ? cause : new Error(`sandbox ${name} source failed`, { cause }),
      );
    sourceDone.resolve();
  });
  source.once("close", () => {
    if (!sourceEnded) {
      const cause = new Error(`sandbox ${name} closed before end`);
      fail(cause);
      if (!destination.destroyed) destination.destroy(cause);
    }
    sourceDone.resolve();
  });
  destination.once("finish", () => destinationDone.resolve());
  destination.once("error", (cause) => {
    fail(cause);
    source.unpipe(destination);
    source.resume();
    destinationDone.resolve();
  });
  destination.once("close", () => {
    if (!destination.writableFinished) {
      fail(new Error(`sandbox ${name} destination closed before finish`));
      source.unpipe(destination);
      source.resume();
    }
    destinationDone.resolve();
  });
  source.pipe(destination);
  return Promise.all([sourceDone.promise, destinationDone.promise]).then(() => undefined);
}

function terminalReadable(stream: Readable, name: string, fail: (cause: unknown) => void) {
  const done = deferred<void>();
  let ended = false;
  stream.once("end", () => {
    ended = true;
    done.resolve();
  });
  stream.once("error", (cause) => {
    fail(cause);
    done.resolve();
  });
  stream.once("close", () => {
    if (!ended) fail(new Error(`${name} closed before end`));
    done.resolve();
  });
  return done.promise;
}

function endWritable(stream: Writable, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.end(value, (cause?: Error | null) => (cause == null ? resolve() : reject(cause)));
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  observe(promise);
  return { promise, resolve, reject };
}

function observe(promise: Promise<unknown>): void {
  void promise.catch(() => undefined);
}
