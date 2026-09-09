import { describe, expect, it, vi } from "vitest";
import type { ProcessObservationScope } from "../../src/host/execution/supervised-process-identity.js";

const stat = (pid: number, sessionId: number, startTime: number, state = "S") =>
  `${pid} (worker) ${state} 0 ${pid} ${sessionId} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${startTime}`;

async function findWithMock(
  readFileMock: ReturnType<typeof vi.fn>,
  scope: ProcessObservationScope,
  entries = ["123"],
) {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.resetModules();
  vi.doMock("node:fs/promises", () => ({
    ...actual,
    readFile: readFileMock,
    readdir: vi.fn().mockResolvedValue(entries),
  }));
  try {
    const { findProcessesByOwnerToken } = await import(
      "../../src/host/execution/supervised-process-identity.js"
    );
    return await findProcessesByOwnerToken("execution", "100", scope);
  } finally {
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  }
}

describe("readProcessIdentity permission races", () => {
  it("treats permission denied on a dying zombie as absent", async () => {
    const readFileMock = vi
      .fn()
      .mockResolvedValueOnce("1 (worker) R 0 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 100")
      .mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }))
      .mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }))
      .mockResolvedValueOnce("1 (worker) Z 0 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 100");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    // The suite shares module caches; load this subject with its own mock and
    // restore the module registry so later real-process tests retain real I/O.
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({ ...actual, readFile: readFileMock }));
    try {
      const { readProcessIdentity } = await import(
        "../../src/host/execution/supervised-process-identity.js"
      );
      await expect(readProcessIdentity(123, "execution")).resolves.toBeNull();
      expect(readFileMock.mock.calls).toEqual([
        ["/proc/123/stat", "utf8"],
        ["/proc/123/environ", "utf8"],
        ["/proc/123/environ", "utf8"],
        ["/proc/123/stat", "utf8"],
      ]);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });
});

describe("readProcessIdentity observation boundaries", () => {
  it("retries a transient environment permission failure before accepting the marker", async () => {
    const readFileMock = vi
      .fn()
      .mockResolvedValueOnce("1 (worker) R 0 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 100")
      .mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }))
      .mockResolvedValueOnce("PI_CONDUCTOR_EXECUTION_ID=execution\0")
      .mockResolvedValueOnce("1 (worker) R 0 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 100");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({ ...actual, readFile: readFileMock }));
    try {
      const { readProcessIdentity } = await import(
        "../../src/host/execution/supervised-process-identity.js"
      );
      await expect(readProcessIdentity(123, "execution")).resolves.toMatchObject({
        pid: 123,
        ownerToken: "execution",
      });
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("labels a non-permission environment failure at read_environ", async () => {
    const readFileMock = vi
      .fn()
      .mockResolvedValueOnce("1 (worker) R 0 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 100")
      .mockRejectedValueOnce(Object.assign(new Error("io"), { code: "EIO" }));
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({ ...actual, readFile: readFileMock }));
    try {
      const { readProcessIdentity } = await import(
        "../../src/host/execution/supervised-process-identity.js"
      );
      await expect(readProcessIdentity(123, "execution")).rejects.toMatchObject({
        operation: "read_environ",
        code: "EIO",
        pid: 123,
      });
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("keeps a verified process when its group changes during the retry", async () => {
    const stat = (group: number) =>
      `1 (worker) R 0 ${group} ${group} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 100`;
    const readFileMock = vi
      .fn()
      .mockResolvedValueOnce(stat(1))
      .mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }))
      .mockResolvedValueOnce("PI_CONDUCTOR_EXECUTION_ID=execution\0")
      .mockResolvedValueOnce(stat(2));
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({ ...actual, readFile: readFileMock }));
    try {
      const { readProcessIdentity } = await import(
        "../../src/host/execution/supervised-process-identity.js"
      );
      await expect(readProcessIdentity(1, "execution")).resolves.toMatchObject({
        pid: 1,
        processGroupId: 2,
      });
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("fails closed when the PID is replaced during the retry", async () => {
    const stat = (start: number) => `1 (worker) R 0 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${start}`;
    const readFileMock = vi
      .fn()
      .mockResolvedValueOnce(stat(100))
      .mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }))
      .mockResolvedValueOnce("PI_CONDUCTOR_EXECUTION_ID=execution\0")
      .mockResolvedValueOnce(stat(200));
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({ ...actual, readFile: readFileMock }));
    try {
      const { readProcessIdentity } = await import(
        "../../src/host/execution/supervised-process-identity.js"
      );
      await expect(readProcessIdentity(1, "execution")).rejects.toMatchObject({
        operation: "read_stat",
        code: "UNKNOWN",
        pid: 1,
        startTime: "200",
        processGroupId: 1,
      });
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });
});

describe("findProcessesByOwnerToken permission races", () => {
  const running = "123 (worker) R 0 123 123 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 100";
  const uid = process.getuid?.() ?? 1000;

  it.each([
    { code: "EACCES", status: "gone", expected: "absent" },
    { code: "EPERM", status: "gone", expected: "absent" },
    { code: "EACCES", status: "zombie", expected: "absent" },
    { code: "EPERM", status: "zombie", expected: "absent" },
    { code: "EACCES", status: "same-user", expected: "denied" },
    { code: "EPERM", status: "same-user", expected: "denied" },
    { code: "EACCES", status: "other-user", expected: "absent" },
    { code: "EACCES", status: "unreadable", expected: "denied" },
  ])("$code followed by $status leaves the process $expected", async ({
    code,
    status,
    expected,
  }) => {
    const denied = Object.assign(new Error("environment denied"), { code });
    const readFileMock = vi.fn(async (path: string) => {
      if (path.endsWith("/stat")) return running;
      if (path.endsWith("/environ")) throw denied;
      if (path.endsWith("/status")) {
        if (status === "gone") throw Object.assign(new Error("gone"), { code: "ENOENT" });
        if (status === "unreadable") throw Object.assign(new Error("denied"), { code: "EPERM" });
        const state = status === "zombie" ? "Z (zombie)" : "S (sleeping)";
        const processUid = status === "other-user" ? uid + 1 : uid;
        return `State:\t${state}\nUid:\t${processUid}\t${processUid}\t${processUid}\t${processUid}\n`;
      }
      throw new Error(`unexpected read: ${path}`);
    });
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({
      ...actual,
      readFile: readFileMock,
      readdir: vi.fn().mockResolvedValue(["123"]),
    }));
    try {
      const { findProcessesByOwnerToken } = await import(
        "../../src/host/execution/supervised-process-identity.js"
      );
      const result = findProcessesByOwnerToken("execution", "100");
      if (expected === "absent") await expect(result).resolves.toEqual([]);
      else
        await expect(result).rejects.toMatchObject({
          code: status === "unreadable" ? "EPERM" : code,
          operation: status === "unreadable" ? "read_status" : "read_environ",
          pid: 123,
        });
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });
});

describe("findProcessesByOwnerToken scoped permission exclusions", () => {
  it("skips an inaccessible PID proven present before the invocation", async () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const readFileMock = vi.fn(async (path: string) => {
      if (path.endsWith("/stat")) return stat(123, 123, 200);
      if (path.endsWith("/environ")) throw denied;
      throw new Error(`unexpected read: ${path}`);
    });
    const scope: ProcessObservationScope = {
      preexisting: new Map([
        [123, { pid: 123, startTime: "200", processGroupId: 123, sessionId: 123 }],
      ]),
    };
    await expect(findWithMock(readFileMock, scope)).resolves.toEqual([]);
  });

  it("skips an inaccessible process in a verified pre-existing session", async () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const readFileMock = vi.fn(async (path: string) => {
      if (path.endsWith("/123/stat")) return stat(123, 700, 200);
      if (path.endsWith("/700/stat")) return stat(700, 700, 150);
      if (path.endsWith("/environ")) throw denied;
      throw new Error(`unexpected read: ${path}`);
    });
    const scope: ProcessObservationScope = {
      preexisting: new Map([
        [700, { pid: 700, startTime: "150", processGroupId: 700, sessionId: 700 }],
      ]),
    };
    await expect(findWithMock(readFileMock, scope)).resolves.toEqual([]);
  });

  it("fails closed for an inaccessible process in a new session", async () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const readFileMock = vi.fn(async (path: string) => {
      if (path.endsWith("/stat")) return stat(123, 700, 200);
      if (path.endsWith("/environ")) throw denied;
      if (path.endsWith("/status")) {
        const uid = process.getuid?.() ?? 1000;
        return `State:\tS (sleeping)\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
      }
      throw new Error(`unexpected read: ${path}`);
    });
    const scope: ProcessObservationScope = { preexisting: new Map() };
    await expect(findWithMock(readFileMock, scope)).rejects.toMatchObject({
      operation: "read_environ",
      code: "EACCES",
      pid: 123,
    });
  });

  it("fails closed when the PID changes identity during permission recovery", async () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    let statReads = 0;
    const readFileMock = vi.fn(async (path: string) => {
      if (path.endsWith("/stat")) {
        statReads += 1;
        return stat(123, 123, statReads === 1 ? 200 : 201);
      }
      if (path.endsWith("/environ")) throw denied;
      throw new Error(`unexpected read: ${path}`);
    });
    const scope: ProcessObservationScope = {
      preexisting: new Map([
        [123, { pid: 123, startTime: "200", processGroupId: 123, sessionId: 123 }],
      ]),
    };
    await expect(findWithMock(readFileMock, scope)).rejects.toMatchObject({
      operation: "read_environ",
      code: "EACCES",
      pid: 123,
    });
  });
});
