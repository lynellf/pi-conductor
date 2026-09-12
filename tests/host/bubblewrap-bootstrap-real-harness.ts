/** Test-only real-process harness for Issue #106 §6 bootstrap proof. */
import { type ChildProcess, spawn } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";

import {
  type BubblewrapStatusFrame,
  BubblewrapStatusParser,
  requireBubblewrapStartupStatus,
} from "../../src/host/execution/sandbox/bootstrap.js";

export interface ProcessIdentity {
  readonly pid: number;
  readonly start: string;
}

export type OwnedProcessState = "alive" | "zombie" | "missing" | "reused";

export interface NamespaceObservation extends ProcessIdentity {
  readonly nspid: readonly string[];
  readonly namespaces: Readonly<Record<"mnt" | "user" | "net" | "ipc" | "uts" | "pid", string>>;
}

export interface LaunchedBootstrap {
  readonly child: ChildProcess;
  readonly launcher: ProcessIdentity;
  readonly release: Writable;
  readonly startup: Promise<Readonly<{ childPid: number; pidNamespace: number }>>;
  readonly ready: Promise<void>;
  readonly close: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  readonly settle: () => Promise<BootstrapSettlement>;
}

export interface BootstrapSettlement {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly statusFrames: readonly BubblewrapStatusFrame[];
}

const namespaceNames = ["mnt", "user", "net", "ipc", "uts", "pid"] as const;

/** Capture PID/start and namespace state while rejecting a PID-reuse race. */
export async function observeProcess(pid: number): Promise<NamespaceObservation> {
  const before = await processIdentity(pid);
  const namespaces = Object.fromEntries(
    await Promise.all(
      namespaceNames.map(
        async (name) => [name, await readlink(`/proc/${pid}/ns/${name}`)] as const,
      ),
    ),
  ) as NamespaceObservation["namespaces"];
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  const after = await processIdentity(pid);
  if (before.start !== after.start) throw new Error(`PID ${pid} changed identity while observed`);
  const nspid = status
    .match(/^NSpid:\s+(.+)$/m)?.[1]
    ?.trim()
    .split(/\s+/);
  if (!nspid || nspid.length === 0) throw new Error(`PID ${pid} has no NSpid status`);
  return Object.freeze({
    ...after,
    nspid: Object.freeze(nspid),
    namespaces: Object.freeze(namespaces),
  });
}

/** Return this host's namespace baseline for final sandbox isolation assertions. */
export function observeHostNamespaces(): Promise<NamespaceObservation> {
  return observeProcess(process.pid);
}

/** Capture an exact PID/start owner identity before a test can signal it. */
export function captureProcessIdentity(pid: number): Promise<ProcessIdentity> {
  return processIdentity(pid);
}

/** Classify an owned process from stat before inspecting optional procfs state. */
export async function classifyOwnedProcess(identity: ProcessIdentity): Promise<OwnedProcessState> {
  let stat: string;
  try {
    stat = await readFile(`/proc/${identity.pid}/stat`, "utf8");
  } catch (error) {
    if (isMissingProcess(error)) return "missing";
    throw error;
  }
  const fields = processFields(stat, identity.pid);
  if (fields.start !== identity.start) return "reused";
  return fields.state === "Z" || fields.state === "X" ? "zombie" : "alive";
}

/** List the live bootstrap descriptors before release. */
export function listProcessFds(pid: number): Promise<string[]> {
  return readdir(`/proc/${pid}/fd`);
}

/** List a pre-release bootstrap child's FDs through its verified namespace-init root. */
export function listSandboxProcessFds(initPid: number, sandboxPid: number): Promise<string[]> {
  return readdir(`/proc/${initPid}/root/proc/${sandboxPid}/fd`);
}

/** Terminate only a directly owned process whose captured PID/start identity still matches. */
export async function terminateOwned(identity: ProcessIdentity): Promise<void> {
  if ((await classifyOwnedProcess(identity)) !== "alive") return;
  process.kill(identity.pid, "SIGKILL");
}

/** Spawn and immediately attach all lifecycle listeners, including close and stdio drains. */
export async function launchBootstrap(
  binary: string,
  args: readonly string[],
): Promise<LaunchedBootstrap> {
  const child = spawn(binary, args, {
    env: {},
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  const close = waitForClose(child);
  if (child.pid === undefined) throw new Error("Bubblewrap spawn returned no PID");
  const launcher = await processIdentity(child.pid);
  const controls = child.stdio as unknown as readonly (Readable | Writable | null | undefined)[];
  const release = controls[3] as Writable | null | undefined;
  const readyStream = controls[4] as Readable | null | undefined;
  const statusStream = controls[5] as Readable | null | undefined;
  const stdout = controls[1] as Readable | null | undefined;
  const stderr = controls[2] as Readable | null | undefined;
  if (!release || !readyStream || !statusStream || !stdout || !stderr)
    throw new Error("missing Bubblewrap stdio/control pipe");

  const output = drain(stdout);
  const errors = drain(stderr);
  const parser = new BubblewrapStatusParser();
  const frames: BubblewrapStatusFrame[] = [];
  let resolveStartup!: (value: Readonly<{ childPid: number; pidNamespace: number }>) => void;
  let rejectStartup!: (error: Error) => void;
  const startup = new Promise<Readonly<{ childPid: number; pidNamespace: number }>>(
    (resolve, reject) => {
      resolveStartup = resolve;
      rejectStartup = reject;
    },
  );
  const statusDone = new Promise<void>((resolve, reject) => {
    statusStream.setEncoding("utf8");
    statusStream.on("data", (chunk: string) => {
      try {
        for (const frame of parser.push(chunk)) {
          frames.push(frame);
          if ("child-pid" in frame) resolveStartup(requireBubblewrapStartupStatus(frame));
        }
      } catch (error) {
        const reason =
          error instanceof Error ? error : new Error("invalid Bubblewrap status frame");
        rejectStartup(reason);
        reject(reason);
      }
    });
    statusStream.once("error", (error) => {
      rejectStartup(error);
      reject(error);
    });
    statusStream.once("end", () => {
      try {
        parser.finish();
        resolve();
      } catch (error) {
        const reason = error instanceof Error ? error : new Error("invalid Bubblewrap status EOF");
        rejectStartup(reason);
        reject(reason);
      }
    });
  });
  const ready = waitForReady(readyStream);

  return {
    child,
    launcher,
    release,
    startup,
    ready,
    close,
    settle: async () => {
      const [closed, settledOutput, settledErrors] = await Promise.all([
        close,
        output,
        errors,
        statusDone,
      ]);
      return Object.freeze({
        ...closed,
        stdout: settledOutput,
        stderr: settledErrors,
        statusFrames: frames,
      });
    },
  };
}

function processIdentity(pid: number): Promise<ProcessIdentity> {
  return readFile(`/proc/${pid}/stat`, "utf8").then((stat) => {
    const fields = processFields(stat, pid);
    return Object.freeze({ pid, start: fields.start });
  });
}

function processFields(stat: string, pid: number): Readonly<{ state: string; start: string }> {
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  const state = fields[0];
  const start = fields[19];
  if (state === undefined || start === undefined)
    throw new Error(`missing process state or start time for PID ${pid}`);
  return Object.freeze({ state, start });
}

function waitForClose(
  child: ChildProcess,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function drain(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    let content = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      content += chunk;
    });
    stream.once("error", reject);
    stream.once("end", () => resolve(content));
  });
}

function waitForReady(stream: Readable): Promise<void> {
  return new Promise((resolve, reject) => {
    let frame = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      frame += chunk;
      if (frame === "READY\n") resolve();
      else if (!"READY\n".startsWith(frame)) reject(new Error(`invalid READY frame ${frame}`));
    });
    stream.once("end", () => reject(new Error("bootstrap closed READY pipe before READY")));
    stream.once("error", reject);
  });
}

function isMissingProcess(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ESRCH" || error.code === "ENOENT")
  );
}
