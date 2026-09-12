import { ChildProcess } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxProcessObservation } from "../../src/persistence/sandbox-process.js";

const { observation, observeSandboxProcess } = vi.hoisted(() => {
  const value = {
    pid: 42,
    startTime: "1",
    nspid: [42, 1],
    namespaces: {
      pid: "pid:[7]",
      mnt: "mnt:[8]",
      user: "user:[9]",
      net: "net:[10]",
      ipc: "ipc:[11]",
      uts: "uts:[12]",
    },
  } as const satisfies SandboxProcessObservation;
  return { observation: value, observeSandboxProcess: vi.fn(async () => value) };
});
vi.mock("../../src/host/execution/sandbox/process-observation.js", () => ({
  observeSandboxProcess,
}));

import { captureSandboxCommandPipes } from "../../src/host/execution/sandbox/command-pipes.js";

function fixture(destinations?: { stdout: Writable; stderr: Writable }) {
  const child = new ChildProcess();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const release = new PassThrough();
  const ready = new PassThrough();
  const status = new PassThrough();
  child.stdout = stdout;
  child.stderr = stderr;
  Object.defineProperty(child, "stdio", {
    value: [null, stdout, stderr, release, ready, status],
  });
  const output = destinations ?? { stdout: new PassThrough(), stderr: new PassThrough() };
  const pipes = captureSandboxCommandPipes(child, output);
  return { child, stdout, stderr, release, ready, status, output, pipes };
}

async function finish(f: ReturnType<typeof fixture>, code = 0): Promise<void> {
  f.ready.end("READY\n");
  f.status.end(`{"child-pid":42,"pid-namespace":7}\n{"exit-code":${String(code)}}\n`);
  f.stdout.end();
  f.stderr.end();
  f.child.emit("close", code, null);
  await f.pipes.drained;
}

describe("production Bubblewrap command pipes", () => {
  beforeEach(() => observeSandboxProcess.mockClear());

  it("starts identity observation inside the startup JSON handler", async () => {
    const f = fixture();
    f.status.write('{"child-pid":42,"pid-namespace":7}\n');
    expect(observeSandboxProcess).toHaveBeenCalledWith(42);
    await expect(f.pipes.startup).resolves.toEqual({ observation, pidNamespace: 7 });
    f.status.end('{"exit-code":0}\n');
    f.ready.end("READY\n");
    f.stdout.end();
    f.stderr.end();
    f.child.emit("close", 0, null);
    await f.pipes.drained;
  });

  it("returns a nonzero raw status and accepts stderr output", async () => {
    const f = fixture();
    const errors: Buffer[] = [];
    f.output.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    f.stderr.write("compiler failed\n");
    await finish(f, 17);
    await expect(f.pipes.settlement).resolves.toBe(17);
    expect(Buffer.concat(errors).toString()).toBe("compiler failed\n");
  });

  it("parses fragmented READY and status frames", async () => {
    const f = fixture();
    f.ready.write("RE");
    f.ready.end("ADY\n");
    f.status.write('{"child-pid":42,"pid-');
    f.status.write('namespace":7}\n{"exit-code"');
    f.status.end(":0}\n");
    f.stdout.end();
    f.stderr.end();
    f.child.emit("close", 0, null);
    await expect(f.pipes.ready).resolves.toBeUndefined();
    await expect(f.pipes.settlement).resolves.toBe(0);
  });

  it.each([
    ["extra READY bytes", "READY\nextra", '{"child-pid":42,"pid-namespace":7}\n{"exit-code":0}\n'],
    ["malformed status", "READY\n", "not-json\n"],
    [
      "duplicate startup",
      "READY\n",
      '{"child-pid":42,"pid-namespace":7}\n{"child-pid":42,"pid-namespace":7}\n',
    ],
    [
      "duplicate exit",
      "READY\n",
      '{"child-pid":42,"pid-namespace":7}\n{"exit-code":0}\n{"exit-code":0}\n',
    ],
    ["missing exit", "READY\n", '{"child-pid":42,"pid-namespace":7}\n'],
  ])("rejects %s without preventing drain", async (_name, ready, status) => {
    const f = fixture();
    f.ready.end(ready);
    f.status.end(status);
    f.stdout.end();
    f.stderr.end();
    f.child.emit("close", 0, null);
    await expect(f.pipes.fault).rejects.toBeInstanceOf(Error);
    await expect(f.pipes.drained).resolves.toBeUndefined();
    await expect(f.pipes.settlement).rejects.toBeInstanceOf(Error);
  });

  it("bounds the status channel", async () => {
    const f = fixture();
    f.status.write("x".repeat(64 * 1024 + 1));
    await expect(f.pipes.fault).rejects.toThrow("64 KiB");
    f.status.end();
    f.ready.end();
    f.stdout.end();
    f.stderr.end();
    f.child.emit("close", 1, null);
    await f.pipes.drained;
  });

  it("writes one exact release frame and rejects release after deny", async () => {
    const released = fixture();
    await released.pipes.release();
    expect(released.release.read()?.toString()).toBe("PI_CONDUCTOR_BOOTSTRAP_RELEASE_V1");
    await expect(released.pipes.release()).rejects.toThrow("released");

    const denied = fixture();
    denied.pipes.deny();
    expect(denied.release.read()).toBeNull();
    await expect(denied.pipes.release()).rejects.toThrow("denied");
  });

  it("never releases after a protocol fault", async () => {
    const f = fixture();
    f.ready.write("READY\n");
    await f.pipes.ready;
    f.ready.write("extra");
    await expect(f.pipes.fault).rejects.toThrow("READY");
    await expect(f.pipes.release()).rejects.toThrow("faulted");
    expect(f.release.read()).toBeNull();
  });

  it("honors destination backpressure before settling", async () => {
    let writeDone: (() => void) | undefined;
    const slow = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        writeDone = callback;
      },
    });
    const f = fixture({ stdout: slow, stderr: new PassThrough() });
    f.stdout.end("blocked");
    f.stderr.end();
    f.ready.end("READY\n");
    f.status.end('{"child-pid":42,"pid-namespace":7}\n{"exit-code":0}\n');
    f.child.emit("close", 0, null);
    let settled = false;
    void f.pipes.settlement.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    writeDone?.();
    await expect(f.pipes.settlement).resolves.toBe(0);
  });

  it("drains after a destination error", async () => {
    const broken = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("disk full"));
      },
    });
    const f = fixture({ stdout: broken, stderr: new PassThrough() });
    f.stdout.end("data");
    await expect(f.pipes.fault).rejects.toThrow("disk full");
    f.stderr.end();
    f.ready.end();
    f.status.end();
    f.child.emit("close", 1, null);
    await expect(f.pipes.drained).resolves.toBeUndefined();
  });

  it("resumes source drain when a destination closes before finish", async () => {
    const destination = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, _callback) {
        this.destroy();
      },
    });
    const f = fixture({ stdout: destination, stderr: new PassThrough() });
    f.stdout.end(Buffer.alloc(1024));
    await expect(f.pipes.fault).rejects.toThrow("destination closed before finish");
    f.stderr.end();
    f.ready.end();
    f.status.end();
    f.child.emit("close", 1, null);
    await expect(f.pipes.drained).resolves.toBeUndefined();
  });

  it("reports close-before-end and spawn errors without unhandled rejections", async () => {
    const reasons: unknown[] = [];
    const onUnhandled = (reason: unknown) => reasons.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const closed = fixture();
      closed.ready.destroy();
      await expect(closed.pipes.fault).rejects.toThrow("closed before end");
      closed.status.destroy();
      closed.stdout.destroy();
      closed.stderr.destroy();
      closed.child.emit("error", new Error("spawn failed"));
      await expect(closed.pipes.closed).rejects.toThrow("spawn failed");
      closed.child.emit("close", null, null);
      await closed.pipes.drained;
      await new Promise((resolve) => setImmediate(resolve));
      expect(reasons).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
