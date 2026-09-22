import { afterEach, describe, expect, it, vi } from "vitest";
import { safeTerminateOwnedGroupDetailed } from "../../src/host/execution/supervised-process-cleanup.js";
import * as identity from "../../src/host/execution/supervised-process-identity.js";

const owner = {
  pid: 42,
  startTime: "100",
  processGroupId: 42,
  ownerToken: "execution",
} as const;
const member = { pid: 43, startTime: "101", processGroupId: 42 } as const;
const escapedMember = { pid: 44, startTime: "102", processGroupId: 44 } as const;

describe("safe supervised cleanup diagnostics", () => {
  afterEach(() => vi.restoreAllMocks());

  it("retains escaped owned identities when the group is already gone", async () => {
    vi.spyOn(identity, "processGroupHasLiveMembers").mockResolvedValue(false);
    vi.spyOn(identity, "findProcessesByOwnerToken").mockResolvedValue([escapedMember]);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    await expect(safeTerminateOwnedGroupDetailed(owner, 0)).resolves.toEqual({
      cleanup: "unconfirmed",
      diagnostic: {
        cleanup_cause: "escaped_owned_processes",
        leader_observed: true,
        observed_members: [{ pid: 44, start_time: "102", process_group_id: 44 }],
      },
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not signal a group after its leader identity is lost", async () => {
    vi.spyOn(identity, "processGroupHasLiveMembers").mockResolvedValue(true);
    vi.spyOn(identity, "readProcessGroupMembers").mockResolvedValue([member]);
    vi.spyOn(identity, "readProcessIdentity").mockResolvedValue(null);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    await expect(safeTerminateOwnedGroupDetailed(owner, 0)).resolves.toMatchObject({
      cleanup: "unconfirmed",
      diagnostic: {
        cleanup_cause: "leader_identity_unobserved",
        leader_observed: true,
      },
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it("confirms cleanup when a marked member exits after its leader", async () => {
    vi.spyOn(identity, "processGroupHasLiveMembers")
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    vi.spyOn(identity, "readProcessGroupMembers").mockResolvedValue([member]);
    vi.spyOn(identity, "readProcessIdentity").mockImplementation(async (pid, token) =>
      pid === member.pid && token === owner.ownerToken ? { ...member, ownerToken: token } : null,
    );
    vi.spyOn(identity, "findProcessesByOwnerToken").mockResolvedValue([]);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    await expect(safeTerminateOwnedGroupDetailed(owner, 0)).resolves.toEqual({
      cleanup: "confirmed",
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it("signals only a reverified marked member after its leader exits", async () => {
    vi.spyOn(identity, "processGroupHasLiveMembers")
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    vi.spyOn(identity, "readProcessGroupMembers").mockResolvedValue([member]);
    vi.spyOn(identity, "readProcessIdentity").mockImplementation(async (pid, token) =>
      pid === member.pid && token === owner.ownerToken ? { ...member, ownerToken: token } : null,
    );
    vi.spyOn(identity, "findProcessesByOwnerToken").mockResolvedValue([]);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    await expect(safeTerminateOwnedGroupDetailed(owner, 0)).resolves.toEqual({
      cleanup: "confirmed",
    });
    expect(kill).toHaveBeenCalledWith(member.pid, "SIGTERM");
    expect(kill.mock.calls.every(([pid]) => pid === member.pid)).toBe(true);
  });

  it.each([
    ["reused PID", { ...member, startTime: "999", ownerToken: owner.ownerToken }],
    ["changed group", { ...member, processGroupId: 99, ownerToken: owner.ownerToken }],
    ["missing marker", null],
  ])("does not signal a member with %s after leader exit", async (_case, current) => {
    vi.spyOn(identity, "processGroupHasLiveMembers").mockResolvedValue(true);
    vi.spyOn(identity, "readProcessGroupMembers").mockResolvedValue([member]);
    vi.spyOn(identity, "readProcessIdentity").mockImplementation(async (pid, token) =>
      pid === member.pid && token === owner.ownerToken ? current : null,
    );
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    await expect(safeTerminateOwnedGroupDetailed(owner, 0)).resolves.toMatchObject({
      cleanup: "unconfirmed",
      diagnostic: {
        cleanup_cause: "leader_identity_unobserved",
        observed_members: [{ pid: member.pid, start_time: member.startTime }],
      },
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it("distinguishes a missing member observation from a signal failure", async () => {
    vi.spyOn(identity, "processGroupHasLiveMembers").mockResolvedValue(true);
    vi.spyOn(identity, "readProcessGroupMembers").mockResolvedValue([member]);
    vi.spyOn(identity, "readProcessIdentity").mockImplementation(async (pid) => {
      if (pid === owner.pid) return null;
      throw Object.assign(new Error("private process"), {
        operation: "read_environ",
        code: "EPERM",
        pid,
      });
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    await expect(safeTerminateOwnedGroupDetailed(owner, 0)).resolves.toMatchObject({
      cleanup: "unconfirmed",
      diagnostic: {
        cleanup_cause: "cleanup_observation_failed",
        observation_error: { operation: "read_environ", code: "EPERM", pid: member.pid },
      },
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not expose an observation error message", async () => {
    vi.spyOn(identity, "processGroupHasLiveMembers").mockResolvedValue(true);
    vi.spyOn(identity, "readProcessGroupMembers").mockRejectedValue(
      Object.assign(new Error("/proc/private secret"), { code: "EACCES" }),
    );

    const result = await safeTerminateOwnedGroupDetailed(owner, 0);
    expect(result).toEqual({
      cleanup: "unconfirmed",
      diagnostic: {
        cleanup_cause: "cleanup_observation_failed",
        leader_observed: true,
        observed_members: [],
        observation_error: {
          operation: "read_stat",
          code: "EACCES",
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("reports signal failure without retrying an unowned process", async () => {
    vi.spyOn(identity, "processGroupHasLiveMembers").mockResolvedValue(true);
    vi.spyOn(identity, "readProcessGroupMembers").mockResolvedValue([member]);
    vi.spyOn(identity, "readProcessIdentity").mockResolvedValue(owner);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code: "EPERM" });
    });

    await expect(safeTerminateOwnedGroupDetailed(owner, 0)).resolves.toMatchObject({
      cleanup: "unconfirmed",
      diagnostic: { cleanup_cause: "cleanup_signal_failed" },
    });
  });

  it("reports a stubborn owned group after both signals fail to settle it", async () => {
    vi.spyOn(identity, "processGroupHasLiveMembers").mockResolvedValue(true);
    vi.spyOn(identity, "readProcessGroupMembers").mockResolvedValue([owner, member]);
    vi.spyOn(identity, "readProcessIdentity").mockResolvedValue(owner);
    vi.spyOn(process, "kill").mockImplementation(() => true);

    await expect(safeTerminateOwnedGroupDetailed(owner, 0)).resolves.toMatchObject({
      cleanup: "unconfirmed",
      diagnostic: {
        cleanup_cause: "group_remained_live",
        leader_observed: true,
      },
    });
  });
});
