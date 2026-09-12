import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { captureProbePipes } from "../../src/host/execution/sandbox/probe-pipes.js";

function fixture() {
  const child = new ChildProcess();
  const output = new PassThrough(),
    errors = new PassThrough(),
    release = new PassThrough(),
    ready = new PassThrough(),
    status = new PassThrough();
  child.stdout = output;
  child.stderr = errors;
  Object.defineProperty(child, "stdio", { value: [null, output, errors, release, ready, status] });
  return { child, output, errors, release, ready, status, pipes: captureProbePipes(child) };
}

describe("bounded trusted probe channels", () => {
  it("requires exact READY and writes the exact release frame", async () => {
    const f = fixture();
    f.ready.write("REA");
    f.ready.write("DY\n");
    await f.pipes.ready;
    await f.pipes.release();
    expect(f.release.read().toString()).toBe("PI_CONDUCTOR_BOOTSTRAP_RELEASE_V1");
  });
  it.each(["BAD\n", "READY\nextra", "READY\0"])("rejects malformed READY %s", async (frame) => {
    const f = fixture();
    f.ready.write(frame);
    await expect(f.pipes.fault).rejects.toThrow("READY");
  });
  it("does not lose a later framing fault after the initial READY resolves", async () => {
    const f = fixture();
    f.ready.write("READY\n");
    await f.pipes.ready;
    f.ready.write("extra");
    await expect(f.pipes.fault).rejects.toThrow("READY");
  });
  it("rejects status EOF without startup/exit instead of hanging", async () => {
    const f = fixture();
    f.status.end();
    await expect(f.pipes.fault).rejects.toThrow("correlated lifecycle");
  });
  it("reports overflow while continuing to drain the output pipe", async () => {
    const f = fixture();
    f.output.write(Buffer.alloc(128 * 1024 + 1));
    await expect(f.pipes.fault).rejects.toThrow("bound");
    expect(f.output.readableLength).toBe(0);
  });
  it("observes spawn failure even before setup is awaited", async () => {
    const f = fixture();
    f.child.emit("error", new Error("spawn failed"));
    await expect(f.pipes.fault).rejects.toThrow("spawn failed");
  });
});
