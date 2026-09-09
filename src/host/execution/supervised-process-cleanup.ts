/** Cleanup is proven only within this Linux host and the inspectable process namespace. */

import type { SupervisedProcessDiagnostic } from "./supervised-process-contract.js";
import {
  findProcessesByOwnerToken,
  ownsProcessGroup,
  ownsProcessIdentity,
  type ProcessIdentity,
  processGroupHasLiveMembers,
  readProcessGroupMembers,
  readProcessIdentity,
} from "./supervised-process-identity.js";

export interface SupervisedCleanupResult {
  readonly cleanup: "confirmed" | "unconfirmed";
  readonly diagnostic?: SupervisedProcessDiagnostic;
}

function observationDiagnostic(
  error: unknown,
  operation: "read_stat" | "read_environ" | "read_status" | "list_processes",
  identity: ProcessIdentity,
  members: readonly ProcessIdentity[],
): SupervisedProcessDiagnostic {
  const observed = error as {
    readonly operation?: string;
    readonly code?: string;
    readonly pid?: number;
    readonly startTime?: string;
    readonly processGroupId?: number;
  };
  const code =
    typeof observed.code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(observed.code)
      ? observed.code
      : "UNKNOWN";
  const actualOperation =
    observed.operation === "read_stat" ||
    observed.operation === "read_environ" ||
    observed.operation === "read_status" ||
    observed.operation === "list_processes"
      ? observed.operation
      : operation;
  const targetPid =
    typeof observed.pid === "number" && Number.isInteger(observed.pid) && observed.pid > 0
      ? observed.pid
      : undefined;
  return {
    cleanup_cause: "cleanup_observation_failed",
    leader_observed: true,
    observed_members: members.slice(0, 32).map(({ pid, startTime, processGroupId }) => ({
      pid,
      start_time: startTime,
      process_group_id: processGroupId,
    })),
    observation_error: {
      operation: actualOperation,
      code,
      ...(targetPid === undefined ? {} : { pid: targetPid }),
      ...(typeof observed.startTime === "string"
        ? { start_time: observed.startTime }
        : targetPid === identity.pid
          ? { start_time: identity.startTime }
          : {}),
      ...(typeof observed.processGroupId === "number" &&
      Number.isInteger(observed.processGroupId) &&
      observed.processGroupId > 0
        ? { process_group_id: observed.processGroupId }
        : targetPid === identity.pid
          ? { process_group_id: identity.processGroupId }
          : {}),
    },
  };
}

async function waitForGroupGone(identity: ProcessIdentity, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() <= deadline) {
    if (!(await processGroupHasLiveMembers(identity.processGroupId))) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !(await processGroupHasLiveMembers(identity.processGroupId));
}

async function escapedProcesses(identity: ProcessIdentity): Promise<readonly ProcessIdentity[]> {
  return identity.ownerToken === undefined
    ? []
    : findProcessesByOwnerToken(identity.ownerToken, identity.startTime);
}

async function terminateOwnedGroup(
  identity: ProcessIdentity,
  graceMs: number,
): Promise<SupervisedCleanupResult> {
  if (!(await processGroupHasLiveMembers(identity.processGroupId))) {
    const escaped = await escapedProcesses(identity);
    return escaped.length === 0
      ? { cleanup: "confirmed" }
      : unconfirmed("escaped_owned_processes", escaped);
  }
  const members = await readProcessGroupMembers(identity.processGroupId);
  if (!ownsProcessGroup(await readProcessIdentity(identity.pid, identity.ownerToken), identity)) {
    return unconfirmed("leader_identity_unobserved", members);
  }
  try {
    process.kill(-identity.processGroupId, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH")
      return unconfirmed("cleanup_signal_failed", members);
  }
  if (await waitForGroupGone(identity, graceMs)) {
    const escaped = await escapedProcesses(identity);
    return escaped.length === 0
      ? { cleanup: "confirmed" }
      : unconfirmed("escaped_owned_processes", escaped);
  }
  if (ownsProcessGroup(await readProcessIdentity(identity.pid, identity.ownerToken), identity)) {
    try {
      process.kill(-identity.processGroupId, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        return unconfirmed("cleanup_signal_failed", members);
    }
  } else {
    for (const member of members) {
      if (member.pid === identity.pid) continue;
      if (!ownsProcessIdentity(await readProcessIdentity(member.pid), member)) continue;
      try {
        process.kill(member.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
          return unconfirmed("cleanup_signal_failed", members);
      }
    }
  }
  if (!(await waitForGroupGone(identity, graceMs)))
    return unconfirmed("group_remained_live", members);
  const escaped = await escapedProcesses(identity);
  return escaped.length === 0
    ? { cleanup: "confirmed" }
    : unconfirmed("escaped_owned_processes", escaped);
}

function unconfirmed(
  cause: SupervisedProcessDiagnostic["cleanup_cause"],
  members: readonly ProcessIdentity[],
): SupervisedCleanupResult {
  return {
    cleanup: "unconfirmed",
    diagnostic: {
      cleanup_cause: cause,
      leader_observed: true,
      observed_members: members.slice(0, 32).map(({ pid, startTime, processGroupId }) => ({
        pid,
        start_time: startTime,
        process_group_id: processGroupId,
      })),
    },
  };
}

/** Preserve a bounded cleanup cause for callers that need evidence beyond the legacy status. */
export async function safeTerminateOwnedGroupDetailed(
  identity: ProcessIdentity,
  graceMs: number,
): Promise<SupervisedCleanupResult> {
  try {
    return await terminateOwnedGroup(identity, graceMs);
  } catch (error) {
    return {
      cleanup: "unconfirmed",
      diagnostic: observationDiagnostic(error, "read_stat", identity, []),
    };
  }
}

/** Terminate an owned process group and prove that marked descendants are gone. */
export async function safeTerminateOwnedGroup(
  identity: ProcessIdentity,
  graceMs: number,
): Promise<"confirmed" | "unconfirmed"> {
  return (await safeTerminateOwnedGroupDetailed(identity, graceMs)).cleanup;
}

/** Confirm or terminate a previously recorded process group without trusting a PID alone. */
export async function cleanupSupervisedProcess(
  identity: ProcessIdentity,
  graceMs = 2_000,
): Promise<"confirmed" | "unconfirmed"> {
  if (process.platform !== "linux" || identity.ownerToken === undefined) return "unconfirmed";
  return safeTerminateOwnedGroup(identity, graceMs);
}
