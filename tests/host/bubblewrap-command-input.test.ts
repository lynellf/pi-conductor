import type { ChildProcess } from "node:child_process";
import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";
import { beginSandboxInput } from "../../src/host/execution/sandbox/command-runner-input.js";

describe("sandbox command FD 0 delivery", () => {
  it("surfaces a late EPIPE through both input settlement and lifecycle fault", async () => {
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        setImmediate(() => callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));
      },
    });

    const input = beginSandboxInput({ stdin } as ChildProcess, Buffer.alloc(128 * 1024));

    await expect(input.settled).rejects.toMatchObject({ code: "EPIPE" });
    await expect(input.fault).rejects.toMatchObject({ code: "EPIPE" });
  });

  it("requires no FD 0 pipe when the shared child runner has no input", async () => {
    const input = beginSandboxInput({ stdin: null } as ChildProcess, undefined);

    await expect(input.settled).resolves.toBeUndefined();
  });
});
