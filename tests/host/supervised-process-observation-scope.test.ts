import { describe, expect, it, vi } from "vitest";
import type { ProcessObservationScope } from "../../src/host/execution/supervised-process-identity.js";

const denied = Object.assign(new Error("denied"), { code: "EACCES" });
const uid = process.getuid?.() ?? 1000;
const stat = (pid: number, sessionId: number, startTime: number, state = "S") =>
  `${pid} (worker) ${[state, 0, pid, sessionId, ...Array(15).fill(0), startTime].join(" ")}`;

async function withIdentityModule<T>(
  readFile: ReturnType<typeof vi.fn>,
  readdir: ReturnType<typeof vi.fn>,
  run: (
    module: typeof import("../../src/host/execution/supervised-process-identity.js"),
  ) => Promise<T>,
): Promise<T> {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.resetModules();
  vi.doMock("node:fs/promises", () => ({ ...actual, readFile, readdir }));
  try {
    return await run(await import("../../src/host/execution/supervised-process-identity.js"));
  } finally {
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  }
}

describe("process observation scope", () => {
  it("captures only non-zombie stat identities and never reads environment", async () => {
    const readFile = vi.fn(async (path: string) => {
      if (path.endsWith("/101/stat")) return stat(101, 101, 10);
      if (path.endsWith("/102/stat")) return stat(102, 102, 11, "Z");
      throw new Error(`unexpected read: ${path}`);
    });
    const readdir = vi.fn().mockResolvedValue(["101", "102", "noise"]);

    const scope = await withIdentityModule(
      readFile,
      readdir,
      async ({ snapshotProcessNamespace }) => snapshotProcessNamespace(),
    );

    expect([...scope.preexisting.values()]).toEqual([
      { pid: 101, startTime: "10", processGroupId: 101, sessionId: 101 },
    ]);
    expect(readFile.mock.calls).toEqual([
      ["/proc/101/stat", "utf8"],
      ["/proc/102/stat", "utf8"],
    ]);
  });

  it("reports a failed baseline read instead of creating a partial scope", async () => {
    const readFile = vi.fn();
    const readdir = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));

    await withIdentityModule(
      readFile,
      readdir,
      async ({ snapshotProcessNamespace }) =>
        await expect(snapshotProcessNamespace()).rejects.toMatchObject({
          operation: "list_processes",
          code: "EACCES",
        }),
    );
    expect(readFile).not.toHaveBeenCalled();
  });

  it("keeps marker-positive candidates even when their PID was in the baseline", async () => {
    const readFile = vi.fn(async (path: string) => {
      if (path.endsWith("/123/stat")) return stat(123, 123, 200);
      if (path.endsWith("/123/environ")) return "PI_CONDUCTOR_EXECUTION_ID=execution\0";
      throw new Error(`unexpected read: ${path}`);
    });
    const scope: ProcessObservationScope = {
      preexisting: new Map([
        [123, { pid: 123, startTime: "200", processGroupId: 123, sessionId: 123 }],
      ]),
    };

    await withIdentityModule(
      readFile,
      vi.fn().mockResolvedValue(["123"]),
      async ({ findProcessesByOwnerToken }) =>
        await expect(findProcessesByOwnerToken("execution", "100", scope)).resolves.toEqual([
          {
            pid: 123,
            startTime: "200",
            processGroupId: 123,
            sessionId: 123,
            ownerToken: "execution",
          },
        ]),
    );
  });

  it.each([
    { label: "below", startTime: 99, readsEnvironment: false },
    { label: "equal", startTime: 100, readsEnvironment: true },
  ])("applies the minimum start cutoff when the candidate is $label", async ({
    startTime,
    readsEnvironment,
  }) => {
    const readFile = vi.fn(async (path: string) => {
      if (path.endsWith("/123/stat")) return stat(123, 123, startTime);
      if (path.endsWith("/123/environ")) return "PI_CONDUCTOR_EXECUTION_ID=execution\0";
      throw new Error(`unexpected read: ${path}`);
    });

    const result = await withIdentityModule(
      readFile,
      vi.fn().mockResolvedValue(["123"]),
      async ({ findProcessesByOwnerToken }) => findProcessesByOwnerToken("execution", "100"),
    );

    expect(result).toHaveLength(readsEnvironment ? 1 : 0);
    expect(readFile.mock.calls.some(([path]) => path.endsWith("/environ"))).toBe(readsEnvironment);
  });

  it("does not exclude a reused PID whose start identity differs from the baseline", async () => {
    const readFile = vi.fn(async (path: string) => {
      if (path.endsWith("/123/stat")) return stat(123, 123, 201);
      if (path.endsWith("/123/environ")) throw denied;
      if (path.endsWith("/123/status")) return `State:\tS (sleeping)\nUid:\t${uid}\t${uid}\n`;
      throw new Error(`unexpected read: ${path}`);
    });
    const scope: ProcessObservationScope = {
      preexisting: new Map([
        [123, { pid: 123, startTime: "200", processGroupId: 123, sessionId: 123 }],
      ]),
    };

    await withIdentityModule(
      readFile,
      vi.fn().mockResolvedValue(["123"]),
      async ({ findProcessesByOwnerToken }) =>
        await expect(findProcessesByOwnerToken("execution", "100", scope)).rejects.toMatchObject({
          operation: "read_environ",
          code: "EACCES",
          pid: 123,
        }),
    );
  });

  it.each([
    { label: "missing", leader: "missing" },
    { label: "reused", leader: "reused" },
    { label: "zombie", leader: "zombie" },
    { label: "unreadable", leader: "unreadable" },
  ])("cannot exclude a candidate when its $label session leader cannot be proven", async ({
    leader,
  }) => {
    const readFile = vi.fn(async (path: string) => {
      if (path.endsWith("/123/stat")) return stat(123, 700, 200);
      if (path.endsWith("/123/environ")) throw denied;
      if (path.endsWith("/700/stat")) {
        if (leader === "unreadable")
          throw Object.assign(new Error("leader denied"), { code: "EPERM" });
        if (leader === "zombie") return stat(700, 700, 150, "Z");
        return stat(700, 700, leader === "reused" ? 151 : 150);
      }
      if (path.endsWith("/123/status")) return `State:\tS (sleeping)\nUid:\t${uid}\t${uid}\n`;
      throw new Error(`unexpected read: ${path}`);
    });
    const scope: ProcessObservationScope = {
      preexisting:
        leader === "missing"
          ? new Map()
          : new Map([[700, { pid: 700, startTime: "150", processGroupId: 700, sessionId: 700 }]]),
    };

    await withIdentityModule(
      readFile,
      vi.fn().mockResolvedValue(["123"]),
      async ({ findProcessesByOwnerToken }) =>
        await expect(findProcessesByOwnerToken("execution", "100", scope)).rejects.toMatchObject({
          operation: "read_environ",
          code: "EACCES",
          pid: 123,
        }),
    );
  });

  it("preserves the original permission failure when the session changes during retry", async () => {
    let candidateReads = 0;
    const readFile = vi.fn(async (path: string) => {
      if (path.endsWith("/123/stat")) {
        candidateReads += 1;
        return stat(123, candidateReads === 1 ? 700 : 701, 200);
      }
      if (path.endsWith("/123/environ")) throw denied;
      throw new Error(`unexpected read: ${path}`);
    });
    const scope: ProcessObservationScope = {
      preexisting: new Map([
        [700, { pid: 700, startTime: "150", processGroupId: 700, sessionId: 700 }],
      ]),
    };

    await withIdentityModule(
      readFile,
      vi.fn().mockResolvedValue(["123"]),
      async ({ findProcessesByOwnerToken }) =>
        await expect(findProcessesByOwnerToken("execution", "100", scope)).rejects.toMatchObject({
          operation: "read_environ",
          code: "EACCES",
          pid: 123,
        }),
    );
  });

  it.each([
    { label: "candidate start", candidate: stat(123, 700, 201) },
    { label: "candidate session", candidate: stat(123, 701, 200) },
  ])("preserves permission failure when $label changes while awaiting leader proof", async ({
    candidate,
  }) => {
    let leaderRead = false;
    const readFile = vi.fn(async (path: string) => {
      if (path.endsWith("/123/stat")) {
        return leaderRead ? candidate : stat(123, 700, 200);
      }
      if (path.endsWith("/123/environ")) throw denied;
      if (path.endsWith("/700/stat")) {
        leaderRead = true;
        return stat(700, 700, 150);
      }
      if (path.endsWith("/123/status")) return `State:\tS (sleeping)\nUid:\t${uid}\t${uid}\n`;
      throw new Error(`unexpected read: ${path}`);
    });
    const scope: ProcessObservationScope = {
      preexisting: new Map([
        [700, { pid: 700, startTime: "150", processGroupId: 700, sessionId: 700 }],
      ]),
    };

    await withIdentityModule(
      readFile,
      vi.fn().mockResolvedValue(["123"]),
      async ({ findProcessesByOwnerToken }) =>
        await expect(findProcessesByOwnerToken("execution", "100", scope)).rejects.toMatchObject({
          operation: "read_environ",
          code: "EACCES",
          pid: 123,
        }),
    );
    expect(leaderRead).toBe(true);
  });
});
