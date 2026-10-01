/** A marker-visible Darwin leader holds workload release until native admission (#165). */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { constants } from "node:os";
import type { Writable } from "node:stream";
import type { SupervisedProcessOptions } from "../supervised-process-contract.js";

const BOOTSTRAP = `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const chunks = [];
const report = value => fs.writeSync(4, JSON.stringify({ version: 1, ...value }));
const fail = code => { try { report({ kind: 'spawn_failed' }); } finally { process.exit(code); } };
let bytes = 0;
const control = fs.createReadStream(null, { fd: 3 });
control.on('data', chunk => {
  bytes += chunk.length;
  if (bytes > 1024 * 1024) fail(125);
  chunks.push(chunk);
});
control.on('error', () => fail(125));
control.on('end', () => {
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const file = input.file ?? '/bin/sh';
    const args = input.file === undefined ? ['-c', input.command] : input.args;
    const child = spawn(file, args, { stdio: [0, 1, 2], detached: false,
      env: { ...input.env, PI_CONDUCTOR_EXECUTION_ID: process.env.PI_CONDUCTOR_EXECUTION_ID } });
    child.once('error', () => fail(127));
    child.once('close', (code, signal) => {
      report({ kind: 'exited', exitCode: code, signal });
      // Never re-raise signals in Node: SIGPIPE is ignored and SIGUSR1 starts its inspector.
      process.exit(signal === null ? (code ?? 127) : 128 + require('node:os').constants.signals[signal]);
    });
  } catch { fail(125); }
});
`;

function workloadEnv(options: SupervisedProcessOptions): NodeJS.ProcessEnv {
  return {
    ...(options.inheritEnv === false ? {} : process.env),
    ...options.env,
    PI_CONDUCTOR_EXECUTION_ID: options.executionId,
  };
}

/** Spawn only trusted release-waiting code, without preload hooks; commands never enter argv. */
export function spawnMacLeader(options: SupervisedProcessOptions): ChildProcessWithoutNullStreams {
  // Available since Node 22.14, below our 22.19 minimum; no inherited preload/inspector flags.
  // https://nodejs.org/download/release/v22.19.0/docs/api/cli.html#--disable-sigusr1
  return spawn(process.execPath, ["--disable-sigusr1", "-e", BOOTSTRAP], {
    cwd: options.cwd,
    // Startup flags (debugging, coverage, preloads and loader configuration) belong
    // to the workload only. NODE_DEBUG can otherwise dump private argv/env to stderr.
    // https://nodejs.org/download/release/v22.19.0/docs/api/cli.html#node_debugmodule
    env: { PATH: "/usr/bin:/bin", LANG: "C", PI_CONDUCTOR_EXECUTION_ID: options.executionId },
    detached: true,
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
}

/** Private keeper metadata, not workload stdout or a replacement cleanup owner. */
export type MacWorkloadOutcome =
  | { readonly kind: "spawn_failed" }
  | {
      readonly kind: "exited";
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
    };

/** Accept only one closed, bounded terminal frame; malformed status cannot establish success. */
export function parseMacWorkloadOutcome(value: unknown): MacWorkloadOutcome | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  if (frame.version !== 1) return null;
  const keys = Object.keys(frame).sort().join("|");
  if (frame.kind === "spawn_failed" && keys === "kind|version") return { kind: "spawn_failed" };
  if (frame.kind !== "exited" || keys !== "exitCode|kind|signal|version") return null;
  if (
    frame.signal === null &&
    typeof frame.exitCode === "number" &&
    Number.isInteger(frame.exitCode) &&
    frame.exitCode >= 0 &&
    frame.exitCode <= 255
  )
    return { kind: "exited", exitCode: frame.exitCode, signal: null };
  if (
    frame.exitCode === null &&
    typeof frame.signal === "string" &&
    Object.hasOwn(constants.signals, frame.signal)
  )
    return { kind: "exited", exitCode: null, signal: frame.signal as NodeJS.Signals };
  return null;
}

/** Decode the private FD before child close; no missing frame or keeper exit implies workload success. */
export function observeMacWorkloadOutcome(
  child: ChildProcessWithoutNullStreams,
): () => MacWorkloadOutcome | null {
  let outcome: MacWorkloadOutcome | null = null;
  let bytes = 0;
  let failed = false;
  const chunks: Buffer[] = [];
  child.stdio[4]?.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 1024) {
      failed = true;
      chunks.length = 0;
    }
    if (!failed) chunks.push(chunk);
  });
  child.stdio[4]?.once("error", () => {
    failed = true;
    outcome = null;
  });
  child.stdio[4]?.once("end", () => {
    if (failed) return;
    try {
      const payload = Buffer.concat(chunks).toString("utf8");
      const parsed = parseMacWorkloadOutcome(JSON.parse(payload));
      // The trusted emitter has one canonical form. Preserve duplicate-key evidence
      // lost by JSON.parse rather than accepting a last-member-wins success frame.
      if (parsed !== null && payload === JSON.stringify({ version: 1, ...parsed }))
        outcome = parsed;
    } catch {
      outcome = null;
    }
  });
  // Node's close follows closure of every stdio stream, including this private FD.
  // https://nodejs.org/download/release/v22.19.0/docs/api/child_process.html#event-close
  return () => outcome;
}

/** Release workload effects only after onSpawn and deadline/abort checks have settled. */
export function releaseMacLeader(
  child: ChildProcessWithoutNullStreams,
  options: SupervisedProcessOptions,
): void {
  const control = child.stdio[3] as Writable | null;
  if (control === null) throw new Error("native leader release pipe unavailable");
  control.on("error", () => undefined);
  const envelope = JSON.stringify(
    options.file === undefined
      ? { command: options.command, env: workloadEnv(options) }
      : { file: options.file, args: options.args ?? [], env: workloadEnv(options) },
  );
  if (Buffer.byteLength(envelope) > 1024 * 1024)
    throw new RangeError("native command release exceeds bound");
  control.end(envelope);
}
