/** Exact-identity process cleanup for the production sandbox runner (#106 §7). */
import type { ChildProcess } from "node:child_process";
import type { SandboxProcessObservation } from "../../../persistence/sandbox-process.js";
import { classifySandboxProcess, observeSandboxProcess } from "./process-observation.js";

type Identity = Pick<SandboxProcessObservation, "pid" | "startTime"> | SandboxProcessObservation;

export async function terminateSandboxProcesses(
  init: Identity | undefined,
  child: ChildProcess | undefined,
  childClosed: Promise<unknown> | undefined,
  graceMs: number,
): Promise<"confirmed" | "unconfirmed"> {
  if (init !== undefined) await signalIfMatched(init, "SIGTERM");
  signalOwnedLauncher(child, "SIGTERM");
  await pause(graceMs);
  if (init !== undefined) await signalIfMatched(init, "SIGKILL");
  signalOwnedLauncher(child, "SIGKILL");
  const launcherSettled = childClosed === undefined || (await bounded(childClosed, graceMs + 500));
  const initSettled = init === undefined || confirmedSettled(await classify(init));
  return launcherSettled && initSettled ? "confirmed" : "unconfirmed";
}

export async function exactProcessSettled(
  identity: Identity,
  classifyProcess: typeof classifySandboxProcess = classifySandboxProcess,
): Promise<boolean> {
  const classification = await classifyProcess(identity).catch(() => "unknown" as const);
  return confirmedSettled(classification);
}

async function signalIfMatched(identity: Identity, signal: NodeJS.Signals): Promise<void> {
  const observed = await observeSandboxProcess(identity.pid).catch(() => undefined);
  if (observed === undefined || !sameOrigin(identity, observed)) return;
  try {
    process.kill(identity.pid, signal);
  } catch {
    // The subsequent exact observation decides cleanup certainty.
  }
}

function sameOrigin(identity: Identity, observed: SandboxProcessObservation): boolean {
  if (identity.startTime !== observed.startTime) return false;
  if (!isFullObservation(identity)) return true;
  return (
    identity.nspid.length === observed.nspid.length &&
    identity.nspid.every((pid, index) => pid === observed.nspid[index]) &&
    (Object.keys(identity.namespaces) as (keyof typeof identity.namespaces)[]).every(
      (name) => identity.namespaces[name] === observed.namespaces[name],
    )
  );
}

function isFullObservation(identity: Identity): identity is SandboxProcessObservation {
  return "namespaces" in identity && "nspid" in identity;
}

function signalOwnedLauncher(child: ChildProcess | undefined, signal: NodeJS.Signals): void {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill(signal);
  } catch {
    // The retained close promise decides cleanup certainty.
  }
}

async function classify(identity: Identity) {
  return classifySandboxProcess(identity).catch(() => "unknown" as const);
}

function confirmedSettled(value: Awaited<ReturnType<typeof classify>>): boolean {
  return value === "settled" || value === "missing" || value === "reused";
}

async function bounded(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => false,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function pause(milliseconds: number): Promise<void> {
  if (milliseconds > 0) await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
