/** Linux same-host ownership observations; the environment marker is an identity aid, not a sandbox. */

import { readdir, readFile } from "node:fs/promises";

/** Names the sanitized `/proc` operation that produced observation evidence. */
export type ProcessObservationOperation =
  | "read_stat"
  | "read_environ"
  | "read_status"
  | "list_processes";

/** Sanitized evidence for one process-namespace read. */
export class ProcessObservationError extends Error {
  readonly operation: ProcessObservationOperation;
  readonly code: string;
  readonly pid: number | undefined;
  readonly startTime: string | undefined;
  readonly processGroupId: number | undefined;

  constructor(
    operation: ProcessObservationOperation,
    error: unknown,
    pid?: number,
    identity?: { readonly startTime: string; readonly processGroupId: number },
  ) {
    super("process observation failed");
    this.name = "ProcessObservationError";
    this.operation = operation;
    const candidate = (error as NodeJS.ErrnoException).code;
    this.code =
      typeof candidate === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(candidate)
        ? candidate
        : "UNKNOWN";
    this.pid = pid;
    this.startTime = identity?.startTime;
    this.processGroupId = identity?.processGroupId;
  }
}

/** PID identity plus the optional execution marker used to detect escaped descendants. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly startTime: string;
  readonly processGroupId: number;
  readonly sessionId?: number;
  readonly ownerToken?: string;
}

/** Read-only process identities captured before one supervised invocation. */
export interface ProcessObservationScope {
  readonly preexisting: ReadonlyMap<number, ProcessIdentity>;
}

function isGone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ESRCH";
}

function observationError(
  operation: ProcessObservationOperation,
  error: unknown,
  pid?: number,
  identity?: { readonly startTime: string; readonly processGroupId: number },
): ProcessObservationError {
  return error instanceof ProcessObservationError
    ? error
    : new ProcessObservationError(operation, error, pid, identity);
}

function parseStat(stat: string): {
  readonly state: string;
  readonly processGroupId: number;
  readonly sessionId: number;
  readonly startTime: string;
} {
  const closing = stat.lastIndexOf(") ");
  if (closing < 0) throw new Error("invalid /proc stat");
  const fields = stat.slice(closing + 2).split(" ");
  const processGroupId = Number(fields[2]);
  const sessionId = Number(fields[3]);
  const startTime = fields[19];
  const state = fields[0];
  if (!state || !Number.isInteger(processGroupId) || !Number.isInteger(sessionId) || !startTime)
    throw new Error("invalid /proc stat fields");
  return { state, processGroupId, sessionId, startTime };
}

/** Capture process identities before spawning; this scope is never shared between calls. */
export async function snapshotProcessNamespace(): Promise<ProcessObservationScope> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch (error) {
    throw observationError("list_processes", error);
  }
  const preexisting = new Map<number, ProcessIdentity>();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const parsed = parseStat(await readFile(`/proc/${entry}/stat`, "utf8"));
      if (parsed.state !== "Z") {
        preexisting.set(Number(entry), {
          pid: Number(entry),
          startTime: parsed.startTime,
          processGroupId: parsed.processGroupId,
          sessionId: parsed.sessionId,
        });
      }
    } catch (error) {
      if (!isGone(error)) throw observationError("read_stat", error, Number(entry));
    }
  }
  return { preexisting };
}

function sameIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid && left.startTime === right.startTime;
}

async function isProvenPreexisting(
  candidate: ProcessIdentity,
  scope: ProcessObservationScope,
): Promise<boolean> {
  const existing = scope.preexisting.get(candidate.pid);
  if (existing !== undefined && sameIdentity(existing, candidate)) return true;
  if (candidate.sessionId === undefined) return false;
  const leader = scope.preexisting.get(candidate.sessionId);
  if (leader === undefined || leader.sessionId !== leader.pid) return false;
  try {
    const current = parseStat(await readFile(`/proc/${candidate.sessionId}/stat`, "utf8"));
    if (
      current.state === "Z" ||
      current.startTime !== leader.startTime ||
      current.sessionId !== candidate.sessionId
    )
      return false;
    const candidateCurrent = parseStat(await readFile(`/proc/${candidate.pid}/stat`, "utf8"));
    if (
      candidateCurrent.state === "Z" ||
      candidateCurrent.startTime !== candidate.startTime ||
      candidateCurrent.sessionId !== candidate.sessionId
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Read PID/start-ticks/group identity, optionally proving the execution marker. */
export async function readProcessIdentity(
  pid: number,
  ownerToken?: string,
): Promise<ProcessIdentity | null> {
  try {
    let parsed: ReturnType<typeof parseStat>;
    try {
      parsed = parseStat(await readFile(`/proc/${pid}/stat`, "utf8"));
    } catch (error) {
      if (isGone(error)) return null;
      throw observationError("read_stat", error, pid);
    }
    if (ownerToken !== undefined) {
      let environ: string | undefined;
      let environError: unknown;
      let retriedEnvironment = false;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let current: ReturnType<typeof parseStat>;
        try {
          environ = await readFile(`/proc/${pid}/environ`, "utf8");
          break;
        } catch (error) {
          environError = error;
          const code = (error as NodeJS.ErrnoException).code;
          if (isGone(error)) return null;
          if (code !== "EACCES" && code !== "EPERM")
            throw observationError("read_environ", error, pid, parsed);
          if (attempt === 0) {
            retriedEnvironment = true;
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
            continue;
          }
          try {
            current = parseStat(await readFile(`/proc/${pid}/stat`, "utf8"));
          } catch (recheckError) {
            if (isGone(recheckError)) return null;
            throw observationError("read_stat", recheckError, pid);
          }
          if (current.state === "Z") return null;
          throw observationError("read_environ", environError, pid, parsed);
        }
      }
      if (environ === undefined) throw observationError("read_environ", environError, pid, parsed);
      const marker = `PI_CONDUCTOR_EXECUTION_ID=${ownerToken}`;
      if (!environ.split("\0").includes(marker)) return null;
      if (retriedEnvironment) {
        let current: ReturnType<typeof parseStat>;
        try {
          current = parseStat(await readFile(`/proc/${pid}/stat`, "utf8"));
        } catch (error) {
          if (isGone(error)) return null;
          throw observationError("read_stat", error, pid);
        }
        if (current.state === "Z") return null;
        if (current.startTime !== parsed.startTime) {
          throw observationError("read_stat", { code: "UNKNOWN" }, pid, current);
        }
        // Keep the latest verified group: a setsid transition during the retry is
        // valid ownership evidence and must not be mistaken for process absence.
        parsed = current;
      }
    }
    return ownerToken === undefined
      ? {
          pid,
          startTime: parsed.startTime,
          processGroupId: parsed.processGroupId,
          sessionId: parsed.sessionId,
        }
      : {
          pid,
          startTime: parsed.startTime,
          processGroupId: parsed.processGroupId,
          sessionId: parsed.sessionId,
          ownerToken,
        };
  } catch (error) {
    if (!isGone(error)) throw observationError("read_stat", error, pid);
    return null;
  }
}

/** Find processes carrying one execution marker, including descendants that called setsid. */
export async function findProcessesByOwnerToken(
  ownerToken: string,
  minimumStartTime?: string,
  scope?: ProcessObservationScope,
): Promise<readonly ProcessIdentity[]> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch (error) {
    throw observationError("list_processes", error);
  }
  const matches: ProcessIdentity[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let initial: ReturnType<typeof parseStat>;
    try {
      initial = parseStat(await readFile(`/proc/${entry}/stat`, "utf8"));
      if (initial.state === "Z") continue;
      if (minimumStartTime !== undefined && BigInt(initial.startTime) < BigInt(minimumStartTime)) {
        continue;
      }
    } catch (error) {
      if (!isGone(error)) throw observationError("read_stat", error, Number(entry));
      continue;
    }
    try {
      const identity = await readProcessIdentity(Number(entry), ownerToken);
      if (identity !== null) matches.push(identity);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") {
        let current: ReturnType<typeof parseStat>;
        try {
          current = parseStat(await readFile(`/proc/${entry}/stat`, "utf8"));
        } catch (currentError) {
          if (isGone(currentError)) continue;
          throw observationError("read_stat", currentError, Number(entry));
        }
        if (current.startTime !== initial.startTime || current.sessionId !== initial.sessionId) {
          throw error;
        }
        if (current.state === "Z") continue;
        if (
          scope !== undefined &&
          (await isProvenPreexisting(
            {
              pid: Number(entry),
              startTime: current.startTime,
              processGroupId: current.processGroupId,
              sessionId: current.sessionId,
            },
            scope,
          ))
        ) {
          continue;
        }
        let status: string;
        try {
          status = await readFile(`/proc/${entry}/status`, "utf8");
        } catch (statusError) {
          if (isGone(statusError)) continue;
          throw observationError("read_status", statusError, Number(entry));
        }
        // Exit can race both the identity recheck and this permission probe.
        if (/^State:\s+Z\b/m.test(status)) continue;
        const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
        const currentUid =
          typeof process.getuid === "function" ? String(process.getuid()) : undefined;
        if (uid !== undefined && currentUid !== undefined && uid !== currentUid) continue;
      }
      if (code !== "ENOENT" && code !== "ESRCH") {
        throw observationError("read_environ", error, Number(entry));
      }
    }
  }
  return matches;
}

/** Check whether a process group still contains a non-zombie member. */
export async function processGroupHasLiveMembers(processGroupId: number): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch (error) {
    throw observationError("list_processes", error);
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const parsed = parseStat(await readFile(`/proc/${entry}/stat`, "utf8"));
      if (parsed.processGroupId === processGroupId && parsed.state !== "Z") return true;
    } catch (error) {
      if (!isGone(error)) throw observationError("read_stat", error, Number(entry));
      // A process can disappear between directory enumeration and stat read.
    }
  }
  return false;
}

/** Snapshot non-zombie members of one process group with PID identities. */
export async function readProcessGroupMembers(
  processGroupId: number,
): Promise<readonly ProcessIdentity[]> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch (error) {
    throw observationError("list_processes", error);
  }
  const members: ProcessIdentity[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const parsed = parseStat(await readFile(`/proc/${entry}/stat`, "utf8"));
      if (parsed.processGroupId === processGroupId && parsed.state !== "Z") {
        members.push({ pid, startTime: parsed.startTime, processGroupId });
      }
    } catch (error) {
      if (!isGone(error)) throw observationError("read_stat", error, pid);
      // A process can disappear during enumeration.
    }
  }
  return members;
}

/** Verify a recorded group leader still owns its original PID and group. */
export function ownsProcessGroup(
  current: ProcessIdentity | null,
  expected: ProcessIdentity,
): boolean {
  return (
    current?.pid === expected.pid &&
    current.startTime === expected.startTime &&
    current.processGroupId === expected.processGroupId &&
    current.processGroupId === expected.pid
  );
}

/** Verify a recorded member without requiring it to be the group leader. */
export function ownsProcessIdentity(
  current: ProcessIdentity | null,
  expected: ProcessIdentity,
): boolean {
  return (
    current?.pid === expected.pid &&
    current.startTime === expected.startTime &&
    current.processGroupId === expected.processGroupId
  );
}
