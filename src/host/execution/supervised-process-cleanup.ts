/** Cleanup is proven only within this Linux host and the inspectable process namespace. */

import {
  findProcessesByOwnerToken,
  ownsProcessGroup,
  ownsProcessIdentity,
  type ProcessIdentity,
  processGroupHasLiveMembers,
  readProcessGroupMembers,
  readProcessIdentity,
} from "./supervised-process-identity.js";

async function waitForGroupGone(identity: ProcessIdentity, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() <= deadline) {
    if (!(await processGroupHasLiveMembers(identity.processGroupId))) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !(await processGroupHasLiveMembers(identity.processGroupId));
}

async function escapedProcessExists(identity: ProcessIdentity): Promise<boolean> {
  return (
    identity.ownerToken !== undefined &&
    (await findProcessesByOwnerToken(identity.ownerToken, identity.startTime)).length > 0
  );
}

async function terminateOwnedGroup(
  identity: ProcessIdentity,
  graceMs: number,
): Promise<"confirmed" | "unconfirmed"> {
  if (!(await processGroupHasLiveMembers(identity.processGroupId))) {
    return (await escapedProcessExists(identity)) ? "unconfirmed" : "confirmed";
  }
  const members = await readProcessGroupMembers(identity.processGroupId);
  if (!ownsProcessGroup(await readProcessIdentity(identity.pid, identity.ownerToken), identity)) {
    return "unconfirmed";
  }
  try {
    process.kill(-identity.processGroupId, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") return "unconfirmed";
  }
  if (await waitForGroupGone(identity, graceMs)) {
    return (await escapedProcessExists(identity)) ? "unconfirmed" : "confirmed";
  }
  if (ownsProcessGroup(await readProcessIdentity(identity.pid, identity.ownerToken), identity)) {
    try {
      process.kill(-identity.processGroupId, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return "unconfirmed";
    }
  } else {
    for (const member of members) {
      if (member.pid === identity.pid) continue;
      if (!ownsProcessIdentity(await readProcessIdentity(member.pid), member)) continue;
      try {
        process.kill(member.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return "unconfirmed";
      }
    }
  }
  if (!(await waitForGroupGone(identity, graceMs))) return "unconfirmed";
  return (await escapedProcessExists(identity)) ? "unconfirmed" : "confirmed";
}

/** Terminate an owned process group and prove that marked descendants are gone. */
export async function safeTerminateOwnedGroup(
  identity: ProcessIdentity,
  graceMs: number,
): Promise<"confirmed" | "unconfirmed"> {
  try {
    return await terminateOwnedGroup(identity, graceMs);
  } catch {
    return "unconfirmed";
  }
}

/** Confirm or terminate a previously recorded process group without trusting a PID alone. */
export async function cleanupSupervisedProcess(
  identity: ProcessIdentity,
  graceMs = 2_000,
): Promise<"confirmed" | "unconfirmed"> {
  if (process.platform !== "linux" || identity.ownerToken === undefined) return "unconfirmed";
  return safeTerminateOwnedGroup(identity, graceMs);
}
