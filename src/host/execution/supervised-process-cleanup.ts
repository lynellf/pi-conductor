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
  } catch {
    return {
      cleanup: "unconfirmed",
      diagnostic: {
        cleanup_cause: "cleanup_observation_failed",
        leader_observed: true,
        observed_members: [],
      },
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
