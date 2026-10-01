import { constants } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const complete = JSON.stringify({
  version: 1,
  bootId: "12345678-1234-1234-1234-123456789abc",
  uid: 501,
  processes: [],
});

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.doUnmock("../../src/host/execution/macos/observer-runtime.js");
  vi.resetModules();
});

async function subject(code: "EAGAIN" | "EACCES", eventualSuccess: boolean) {
  vi.resetModules();
  let calls = 0;
  const execute = vi.fn(
    (
      _file: string,
      _args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (++calls > 1 && eventualSuccess) callback(null, complete, "");
      else
        callback(
          new Error("do not expose this"),
          "INVALID partial observations",
          JSON.stringify({
            version: 1,
            error: {
              operation: "read_stat",
              errno: constants.errno[code],
              pid: 20,
            },
          }),
        );
      return { stdin: { on: () => undefined, end: () => undefined } };
    },
  );
  vi.doMock("node:child_process", () => ({ execFile: execute }));
  vi.doMock("../../src/host/execution/macos/observer-runtime.js", () => ({
    prepareMacObserver: () => "fixture",
  }));
  const { observeMacProcesses } = await import("../../src/host/execution/macos/observer.js");
  return { observeMacProcesses, execute };
}

describe("bounded native observation retries", () => {
  it("discards a partial raced scan and uses only the complete second observation", async () => {
    const { observeMacProcesses, execute } = await subject("EAGAIN", true);
    await expect(observeMacProcesses("scan", "private")).resolves.toMatchObject({ processes: [] });
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("does not suppress persistent races or retry beyond one attempt", async () => {
    const { observeMacProcesses, execute } = await subject("EAGAIN", false);
    await expect(observeMacProcesses("scan", "private")).rejects.toMatchObject({
      code: "EAGAIN",
      nativePid: 20,
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("does not retry permission denial or reinterpret it as an empty process list", async () => {
    const { observeMacProcesses, execute } = await subject("EACCES", true);
    await expect(observeMacProcesses("scan", "private")).rejects.toMatchObject({
      code: "EACCES",
      nativePid: 20,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
