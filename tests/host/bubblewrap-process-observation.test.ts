import { describe, expect, it } from "vitest";
import {
  classifySandboxProcess,
  observeSandboxProcess,
  verifyFinalSandboxNamespaces,
} from "../../src/host/execution/sandbox/process-observation.js";

const stat = (pid = 42, ticks = "123", state = "S") =>
  `${pid} (name ) with spaces) ${state} ${Array(18).fill("0").join(" ")} ${ticks} 0\n`;
const namespaces = {
  pid: "pid:[11]",
  mnt: "mnt:[12]",
  user: "user:[13]",
  net: "net:[14]",
  ipc: "ipc:[15]",
  uts: "uts:[16]",
};
const observed = { pid: 42, startTime: "123", nspid: [42, 1], namespaces };

describe("bounded exact sandbox process observation", () => {
  it("brackets namespace reads with exact stat identity", async () => {
    const result = await observeSandboxProcess(42, {
      readText: async (path) => (path.endsWith("/stat") ? stat() : "NSpid:\t42\t1\n"),
      readNamespace: async (path) => namespaces[path.split("/").at(-1) as keyof typeof namespaces],
    });
    expect(result).toEqual(observed);
  });

  it("rejects reused PID during observation", async () => {
    let reads = 0;
    await expect(
      observeSandboxProcess(42, {
        readText: async (path) =>
          path.endsWith("/stat") ? stat(42, ++reads === 1 ? "123" : "124") : "NSpid:\t42\t1\n",
        readNamespace: async (path) =>
          namespaces[path.split("/").at(-1) as keyof typeof namespaces],
      }),
    ).rejects.toThrow("identity");
  });

  it("does not treat missing namespace links as process death", async () => {
    await expect(
      observeSandboxProcess(42, {
        readText: async () => stat(),
        readNamespace: async () => {
          throw Object.assign(new Error("gone"), { code: "ENOENT" });
        },
      }),
    ).rejects.toMatchObject({ operation: "read_namespace", code: "ENOENT", pid: 42 });
  });

  it.each([
    ["S", "123", "alive"],
    ["Z", "123", "settled"],
    ["X", "123", "settled"],
    ["S", "124", "reused"],
  ])("classifies stat state %s/start %s as %s", async (state, ticks, expected) => {
    expect(
      await classifySandboxProcess({ pid: 42, startTime: "123" }, async () =>
        stat(42, ticks, state),
      ),
    ).toBe(expected);
  });

  it("only classifies missing stat as missing; denial remains unknown", async () => {
    await expect(
      classifySandboxProcess({ pid: 42, startTime: "123" }, async () => {
        throw Object.assign(new Error(), { code: "ENOENT" });
      }),
    ).resolves.toBe("missing");
    await expect(
      classifySandboxProcess({ pid: 42, startTime: "123" }, async () => {
        throw Object.assign(new Error(), { code: "EACCES" });
      }),
    ).rejects.toMatchObject({ operation: "read_stat", code: "EACCES" });
  });

  it("permits early user namespace change while requiring final isolated PID 1", () => {
    const host = {
      ...observed,
      pid: 7,
      nspid: [7],
      namespaces: {
        pid: "pid:[1]",
        mnt: "mnt:[2]",
        user: "user:[3]",
        net: "net:[4]",
        ipc: "ipc:[5]",
        uts: "uts:[6]",
      },
    };
    const early = { ...observed, namespaces: { ...namespaces, user: "user:[99]" } };
    expect(() => verifyFinalSandboxNamespaces(early, observed, host, 11)).not.toThrow();
    expect(() =>
      verifyFinalSandboxNamespaces(early, { ...observed, nspid: [99, 1] }, host, 11),
    ).toThrow();
    expect(() =>
      verifyFinalSandboxNamespaces(early, { ...observed, nspid: [42, 2] }, host, 11),
    ).toThrow();
    expect(() =>
      verifyFinalSandboxNamespaces(
        early,
        { ...observed, namespaces: { ...namespaces, net: host.namespaces.net } },
        host,
        11,
      ),
    ).toThrow();
  });
});
