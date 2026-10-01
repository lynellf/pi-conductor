import { constants } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as observer from "../../src/host/execution/macos/observer.js";
import {
  type MacObservation,
  type MacProcessObservation,
  parseMacObservation,
} from "../../src/host/execution/macos/observer.js";
import { nativeObservationFailure } from "../../src/host/execution/macos/observer-protocol.js";
import {
  findProcessesByOwnerToken,
  readProcessGroupMembers,
  readProcessSessionMembers,
} from "../../src/host/execution/macos/process-identity.js";
import type { ProcessObservationScope } from "../../src/host/execution/process-identity-contract.js";

const old = {
  pid: 10,
  startTime: "10",
  startTimeKind: "mach" as const,
  processGroupId: 10,
  sessionId: 10,
};
const candidate: MacProcessObservation = {
  pid: 20,
  uid: 501,
  realUid: 501,
  startTime: "20",
  startKind: "mach",
  processGroupId: 20,
  sessionId: 20,
  marker: "unknown",
};
const reply = (processes: readonly MacProcessObservation[]): MacObservation => ({
  version: 1,
  bootId: "12345678-1234-1234-1234-123456789abc",
  uid: 501,
  processes,
});
const scope: ProcessObservationScope = { preexisting: new Map([[old.pid, old]]) };
afterEach(() => vi.restoreAllMocks());

describe("Darwin ownership exclusions", () => {
  it("does not exclude a positively marked process even with an older boundary", async () => {
    vi.spyOn(observer, "observeMacProcesses").mockResolvedValue(
      reply([{ ...candidate, marker: "present" }]),
    );
    await expect(
      findProcessesByOwnerToken("owner", "100", {
        preexisting: new Map(),
        preexistingBefore: "100",
      }),
    ).resolves.toEqual([
      {
        pid: 20,
        startTime: "20",
        startTimeKind: "mach",
        processGroupId: 20,
        sessionId: 20,
        ownerToken: "owner",
      },
    ]);
  });
  it("rejects a new restricted process instead of treating missing marker as unrelated", async () => {
    vi.spyOn(observer, "observeMacProcesses").mockResolvedValue(reply([candidate]));
    await expect(findProcessesByOwnerToken("owner", "10", scope)).rejects.toMatchObject({
      operation: "read_environ",
      code: "EACCES",
      pid: 20,
    });
  });
  it("does not exempt a same-real-UID setuid process or compare wallclock to Mach ticks", async () => {
    vi.spyOn(observer, "observeMacProcesses").mockResolvedValue(
      reply([{ ...candidate, uid: 0, startKind: "wallclock", startTime: "1" }]),
    );
    await expect(findProcessesByOwnerToken("owner", "100", scope)).rejects.toMatchObject({
      operation: "read_environ",
      pid: 20,
      startTimeKind: "wallclock",
    });
  });
  it.each([
    { uid: 0, startKind: "wallclock" as const },
    { uid: 501, startKind: "mach" as const },
  ])("excludes unknown foreign-real-UID candidates regardless of effective UID ($uid)", async (credentials) => {
    vi.spyOn(observer, "observeMacProcesses").mockResolvedValue(
      reply([{ ...candidate, ...credentials, realUid: 0 }]),
    );
    await expect(findProcessesByOwnerToken("owner", "10", scope)).resolves.toEqual([]);
  });
  it("never excludes a positive marker because the real UID differs", async () => {
    vi.spyOn(observer, "observeMacProcesses").mockResolvedValue(
      reply([{ ...candidate, realUid: 0, marker: "present" }]),
    );
    expect(
      (await findProcessesByOwnerToken("owner", "100", scope)).map((value) => value.pid),
    ).toEqual([20]);
  });
  it("fully rescans transient denial and still detects a surviving marked child", async () => {
    const scan = vi
      .spyOn(observer, "observeMacProcesses")
      .mockResolvedValueOnce(reply([candidate]))
      .mockResolvedValueOnce(
        reply([{ ...candidate, pid: 21, processGroupId: 21, sessionId: 21, marker: "present" }]),
      );
    const result = await findProcessesByOwnerToken("owner", "10", scope);
    expect(result.map((value) => value.pid)).toEqual([21]);
    expect(scan).toHaveBeenCalledTimes(2);
  });
  it("freshly rechecks both original session leader and new candidate", async () => {
    const sameSession = { ...candidate, sessionId: 10 };
    const scan = vi
      .spyOn(observer, "observeMacProcesses")
      .mockImplementation(async (mode, _token, pid) => {
        if (mode === "scan") return reply([sameSession]);
        return reply(
          pid === 10
            ? [{ ...candidate, pid: 10, startTime: "10", processGroupId: 10, sessionId: 10 }]
            : [sameSession],
        );
      });
    await expect(findProcessesByOwnerToken("owner", "10", scope)).resolves.toEqual([]);
    expect(scan.mock.calls.map(([, , pid]) => pid)).toEqual([undefined, 10, 20]);
  });
  it("refuses original-session exclusion when the leader PID was reused", async () => {
    const scan = vi
      .spyOn(observer, "observeMacProcesses")
      .mockImplementation(async (mode) =>
        reply(
          mode === "scan"
            ? [{ ...candidate, sessionId: 10 }]
            : [{ ...candidate, pid: 10, startTime: "999", processGroupId: 10, sessionId: 10 }],
        ),
      );
    await expect(findProcessesByOwnerToken("owner", "10", scope)).rejects.toMatchObject({
      operation: "read_environ",
      pid: 20,
    });
    expect(scan).toHaveBeenCalledTimes(6);
  });
});

describe("Darwin group and session settlement", () => {
  it("retains foreign-real-UID members in group and original-session checks", async () => {
    vi.spyOn(observer, "observeMacProcesses").mockResolvedValue(
      reply([{ ...candidate, uid: 0, realUid: 0, startKind: "wallclock" }]),
    );
    const group = await readProcessGroupMembers(20);
    const session = await readProcessSessionMembers(20, "100", scope);
    expect({
      group: group.map((value) => value.pid),
      session: session.map((value) => value.pid),
    }).toEqual({ group: [20], session: [20] });
  });
});

describe("sanitized native failures", () => {
  it("retains explicit PID-reuse race evidence without any raw stderr", () => {
    const failure = nativeObservationFailure(
      JSON.stringify({
        version: 1,
        error: {
          operation: "read_stat",
          errno: constants.errno.EAGAIN,
          pid: 20,
        },
      }),
    );
    expect(failure).toMatchObject({ code: "EAGAIN", nativePid: 20, nativeOperation: "read_stat" });
  });
  it("discards malformed stderr rather than attributing a private message to a PID", () => {
    const failure = nativeObservationFailure(
      JSON.stringify({
        version: 1,
        error: {
          operation: "read_stat",
          errno: constants.errno.EAGAIN,
          pid: 20,
          command: "PRIVATE",
        },
      }),
    );
    expect(failure).toMatchObject({ code: "EIO", nativePid: undefined });
    expect(failure.message).not.toContain("PRIVATE");
  });
});

describe("closed native observer protocol", () => {
  const valid = reply([candidate]);
  it.each([
    { uid: 0, realUid: 501, startKind: "wallclock" as const },
    { uid: 501, realUid: 0, startKind: "mach" as const },
  ])("retains independent real and effective UIDs ($uid/$realUid)", (credentials) => {
    const entry = { ...candidate, ...credentials };
    expect(parseMacObservation(reply([entry])).processes).toEqual([entry]);
  });
  it("rejects missing real UID rather than falling back to effective UID", () => {
    const { realUid: _omitted, ...legacy } = candidate;
    expect(() => parseMacObservation({ ...valid, processes: [legacy] })).toThrow(
      "invalid native observation protocol",
    );
  });
  it.each([
    { ...valid, complete: false },
    { ...valid, secret: "private" },
    { ...valid, processes: [{ ...candidate, realUid: undefined }] },
    { ...valid, processes: [{ ...candidate, realUid: -1 }] },
    { ...valid, processes: [{ ...candidate, realUid: 4294967296 }] },
    { ...valid, processes: [{ ...candidate, realUid: "501" }] },
    { ...valid, processes: [{ ...candidate, marker: "redacted-as-absent" }] },
    { ...valid, processes: [{ ...candidate, startKind: "wallclock" }] },
    { ...valid, processes: [{ ...candidate, startTime: "1.5" }] },
    { ...valid, processes: [{ ...candidate, startTime: "0" }] },
    { ...valid, processes: [{ ...candidate, uid: 0, startKind: "wallclock", marker: "absent" }] },
    { ...valid, processes: [{ ...candidate, ownerToken: "private" }] },
    { ...valid, processes: [candidate, candidate] },
    { ...valid, processes: [candidate, { ...candidate, startTime: "21" }] },
  ])("rejects incomplete or malformed identity metadata (%#)", (value) => {
    expect(() => parseMacObservation(value)).toThrow("invalid native observation protocol");
  });
});
