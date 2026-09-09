/** Linux same-host ownership observations; the environment marker is an identity aid, not a sandbox. */

import { readdir, readFile } from "node:fs/promises";

/** PID identity plus the optional execution marker used to detect escaped descendants. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly startTime: string;
  readonly processGroupId: number;
  readonly ownerToken?: string;
}

function isGone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ESRCH";
}

function parseStat(stat: string): {
  readonly state: string;
  readonly processGroupId: number;
  readonly startTime: string;
} {
  const closing = stat.lastIndexOf(") ");
  if (closing < 0) throw new Error("invalid /proc stat");
  const fields = stat.slice(closing + 2).split(" ");
  const processGroupId = Number(fields[2]);
  const startTime = fields[19];
  const state = fields[0];
  if (!state || !Number.isInteger(processGroupId) || !startTime)
    throw new Error("invalid /proc stat fields");
  return { state, processGroupId, startTime };
}

/** Read PID/start-ticks/group identity, optionally proving the execution marker. */
export async function readProcessIdentity(
  pid: number,
  ownerToken?: string,
): Promise<ProcessIdentity | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const parsed = parseStat(stat);
    if (ownerToken !== undefined) {
      let environ: string;
      try {
        environ = await readFile(`/proc/${pid}/environ`, "utf8");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EACCES" && code !== "EPERM") throw error;
        try {
          const current = parseStat(await readFile(`/proc/${pid}/stat`, "utf8"));
          if (current.state !== "Z") throw error;
        } catch (recheckError) {
          if (isGone(recheckError)) return null;
          throw recheckError;
        }
        return null;
      }
      const marker = `PI_CONDUCTOR_EXECUTION_ID=${ownerToken}`;
      if (!environ.split("\0").includes(marker)) return null;
    }
    return ownerToken === undefined
      ? { pid, startTime: parsed.startTime, processGroupId: parsed.processGroupId }
      : { pid, startTime: parsed.startTime, processGroupId: parsed.processGroupId, ownerToken };
  } catch (error) {
    if (!isGone(error)) throw error;
    return null;
  }
}

/** Find processes carrying one execution marker, including descendants that called setsid. */
export async function findProcessesByOwnerToken(
  ownerToken: string,
  minimumStartTime?: string,
): Promise<readonly ProcessIdentity[]> {
  const entries = await readdir("/proc");
  const matches: ProcessIdentity[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = parseStat(await readFile(`/proc/${entry}/stat`, "utf8"));
      if (stat.state === "Z") continue;
      if (minimumStartTime !== undefined && BigInt(stat.startTime) < BigInt(minimumStartTime)) {
        continue;
      }
    } catch (error) {
      if (!isGone(error)) throw error;
      continue;
    }
    try {
      const identity = await readProcessIdentity(Number(entry), ownerToken);
      if (identity !== null) matches.push(identity);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") {
        let status: string;
        try {
          status = await readFile(`/proc/${entry}/status`, "utf8");
        } catch (statusError) {
          if (isGone(statusError)) continue;
          throw error;
        }
        // Exit can race both the identity recheck and this permission probe.
        if (/^State:\s+Z\b/m.test(status)) continue;
        const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
        const currentUid =
          typeof process.getuid === "function" ? String(process.getuid()) : undefined;
        if (uid !== undefined && currentUid !== undefined && uid !== currentUid) continue;
      }
      if (code !== "ENOENT" && code !== "ESRCH") {
        throw error;
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
  } catch {
    return true;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const parsed = parseStat(await readFile(`/proc/${entry}/stat`, "utf8"));
      if (parsed.processGroupId === processGroupId && parsed.state !== "Z") return true;
    } catch (error) {
      if (!isGone(error)) throw error;
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
  entries = await readdir("/proc");
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
      if (!isGone(error)) throw error;
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
