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

  it("identifies unexpected inherited descriptors without exposing report contents", async () => {
    const f = await failedProbe(JSON.stringify({ ...probeReport(), extra_fds: 2 }));
    await expect(f.pipes.settle()).rejects.toThrow(
      "unexpected inherited descriptors (count=2); inspect the host launch environment",
    );
    await expect(f.pipes.settle()).rejects.not.toThrow("private-mount-data");
  });

  it.each([
    ["malformed JSON", "private-mount-data"],
    ["incomplete report", JSON.stringify({ schema_version: 1, extra_fds: 2 })],
    ["invalid count", JSON.stringify({ ...probeReport(), extra_fds: "private-mount-data" })],
    ["another failure", JSON.stringify(probeReport())],
  ])("keeps a generic failure for %s", async (_name, output) => {
    const f = await failedProbe(output);
    await expect(f.pipes.settle()).rejects.toThrow(
      /^probe failed: exit=1 signal=null stderr_bytes=0$/,
    );
  });
});

async function failedProbe(output: string) {
  const f = fixture();
  f.status.write(`${JSON.stringify({ "child-pid": process.pid, "pid-namespace": 1 })}\n`);
  await f.pipes.startup;
  f.status.end('{"exit-code":1}\n');
  f.output.end(output);
  f.errors.end();
  f.child.emit("close", 1, null);
  return f;
}

function probeReport() {
  return {
    schema_version: 1,
    capabilities_zero: true,
    cap_amb: "0000000000000000",
    cap_bnd: "0000000000000000",
    cap_eff: "0000000000000000",
    cap_inh: "0000000000000000",
    cap_prm: "0000000000000000",
    devices_match: true,
    external_interfaces: 0,
    extra_fds: 0,
    host_connection_denied: true,
    host_connection_errno: 101,
    mountinfo: "private-mount-data",
    namespace: {
      ipc: "ipc:[200]",
      mnt: "mnt:[201]",
      net: "net:[202]",
      pid: "pid:[203]",
      user: "user:[204]",
      uts: "uts:[205]",
    },
    nested_userns_denied: true,
    nested_userns_errno: 1,
    nested_userns_result: -1,
    no_new_privs: 1,
    sentinel_absent: true,
    sentinel_errno: 2,
  };
}
