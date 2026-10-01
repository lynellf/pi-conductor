/** Darwin same-host ownership observations; unknown/redacted markers fail closed (#165). */
import {
  type ProcessIdentity,
  ProcessObservationError,
  type ProcessObservationScope,
} from "../process-identity-contract.js";
import { type MacProcessObservation, observeMacProcesses } from "./observer.js";

function identity(value: MacProcessObservation, token?: string): ProcessIdentity {
  return {
    pid: value.pid,
    startTime: value.startTime,
    startTimeKind: value.startKind,
    processGroupId: value.processGroupId,
    sessionId: value.sessionId,
    ...(token === undefined ? {} : { ownerToken: token }),
  };
}

async function observe(mode: "snapshot" | "scan" | "observe", token = "", pid?: number) {
  try {
    return await observeMacProcesses(mode, token, pid);
  } catch (error) {
    const failure = error as { readonly nativePid?: number; readonly nativeOperation?: string };
    throw new ProcessObservationError(
      failure.nativeOperation === "read_stat" || mode === "observe"
        ? "read_stat"
        : "list_processes",
      error,
      failure.nativePid ?? pid,
    );
  }
}

function same(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return (
    left.pid === right.pid &&
    left.startTime === right.startTime &&
    left.startTimeKind === right.startTimeKind
  );
}

/** Original pre-spawn native identities, not a current ancestry heuristic. */
export async function snapshotProcessNamespace(): Promise<ProcessObservationScope> {
  const observation = await observe("snapshot");
  return {
    preexisting: new Map(observation.processes.map((value) => [value.pid, identity(value)])),
  };
}

/** Read native identity and, when requested, positively establish marker ownership. */
export async function readProcessIdentity(
  pid: number,
  token?: string,
): Promise<ProcessIdentity | null> {
  const current = (await observe("observe", token ?? "", pid)).processes[0];
  if (current === undefined) return null;
  if (token !== undefined) {
    if (current.marker === "unknown")
      throw new ProcessObservationError("read_environ", { code: "EACCES" }, pid, identity(current));
    if (current.marker !== "present") return null;
  }
  return identity(current, token);
}

async function provenPreexisting(
  candidate: ProcessIdentity,
  scope: ProcessObservationScope,
): Promise<boolean> {
  const prior = scope.preexisting.get(candidate.pid);
  if (prior !== undefined && same(prior, candidate)) return true;
  if (
    candidate.startTimeKind === "mach" &&
    scope.preexistingBefore !== undefined &&
    BigInt(candidate.startTime) < BigInt(scope.preexistingBefore)
  )
    return true;
  if (candidate.sessionId === undefined) return false;
  const leader = scope.preexisting.get(candidate.sessionId);
  if (leader === undefined || leader.pid !== leader.sessionId) return false;
  // A child cannot join a different already-existing POSIX session. Revalidate
  // the original leader and candidate; a session escaper has no such proof.
  const currentLeader = await readProcessIdentity(leader.pid);
  const currentCandidate = await readProcessIdentity(candidate.pid);
  return (
    currentLeader !== null &&
    currentCandidate !== null &&
    same(leader, currentLeader) &&
    currentLeader.sessionId === leader.pid &&
    same(candidate, currentCandidate) &&
    currentCandidate.sessionId === leader.pid
  );
}

/** Detect escapers; one permission-only full rescan preserves the original proof context. */
export async function findProcessesByOwnerToken(
  token: string,
  minimumStartTime?: string,
  scope?: ProcessObservationScope,
): Promise<readonly ProcessIdentity[]> {
  try {
    return await findObservedProcesses(token, minimumStartTime, scope);
  } catch (error) {
    if (
      !(error instanceof ProcessObservationError) ||
      (error.code !== "EACCES" && error.code !== "EPERM")
    )
      throw error;
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Discard the whole failed scan. No new baseline and no vanished-PID shortcut.
    return findObservedProcesses(token, minimumStartTime, scope);
  }
}

async function findObservedProcesses(
  token: string,
  minimumStartTime?: string,
  scope?: ProcessObservationScope,
): Promise<readonly ProcessIdentity[]> {
  const observation = await observe("scan", token);
  const matches: ProcessIdentity[] = [];
  for (const value of observation.processes) {
    if (value.marker === "present") {
      matches.push(identity(value, token));
      continue;
    }
    if (value.marker === "absent") continue;
    // Match Linux's real-UID boundary only for unknown markers. Setuid programs
    // retaining our real UID remain unknown; positive ownership always wins.
    // Privileged out-of-session/service workloads are not contained by this model.
    if (value.realUid !== observation.uid) continue;
    if (
      value.startKind === "mach" &&
      minimumStartTime !== undefined &&
      BigInt(value.startTime) < BigInt(minimumStartTime)
    )
      continue;
    const candidate = identity(value);
    if (scope !== undefined && (await provenPreexisting(candidate, scope))) continue;
    throw new ProcessObservationError("read_environ", { code: "EACCES" }, value.pid, candidate);
  }
  return matches;
}

/** Observe every live group member, including members whose environment is restricted. */
export async function readProcessGroupMembers(group: number): Promise<readonly ProcessIdentity[]> {
  return (await observe("snapshot")).processes
    .filter((value) => value.processGroupId === group)
    .map((value) => identity(value));
}

/** Report whether the observed native group has live members. */
export async function processGroupHasLiveMembers(group: number): Promise<boolean> {
  return (await readProcessGroupMembers(group)).length > 0;
}

/** Observe members of an originally owned session for local-effect recovery. */
export async function readProcessSessionMembers(
  session: number,
  minimumStartTime: string,
  scope: ProcessObservationScope,
): Promise<readonly ProcessIdentity[]> {
  const members: ProcessIdentity[] = [];
  for (const value of (await observe("snapshot")).processes) {
    if (value.sessionId !== session) continue;
    const candidate = identity(value);
    if (
      value.startKind !== "mach" ||
      (BigInt(value.startTime) >= BigInt(minimumStartTime) &&
        !(await provenPreexisting(candidate, scope)))
    )
      members.push(candidate);
  }
  return members;
}
