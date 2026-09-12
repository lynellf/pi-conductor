import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  assertSandboxCapabilityProbeReport,
  parseSandboxCapabilityProbeReport,
  type SandboxCapabilityProbeReport,
} from "../../src/persistence/sandbox-probe.js";

const execFile = promisify(execFileCallback);

const hostNamespaces = {
  ipc: "ipc:[100]",
  mnt: "mnt:[101]",
  net: "net:[102]",
  pid: "pid:[103]",
  user: "user:[104]",
  uts: "uts:[105]",
} as const;

function validReport(): SandboxCapabilityProbeReport {
  return {
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
    mountinfo: "42 1 0:42 / / ro - tmpfs tmpfs ro\n",
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
    schema_version: 1,
    sentinel_absent: true,
    sentinel_errno: 2,
  };
}

describe("sandbox capability probe report", () => {
  it("parses and validates the bounded version-one report", () => {
    const report = parseSandboxCapabilityProbeReport(JSON.stringify(validReport()), hostNamespaces);

    expect(report.namespace.pid).toBe("pid:[203]");
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.namespace)).toBe(true);
  });

  it.each([
    [
      "a capability bit remains",
      (report: SandboxCapabilityProbeReport) => ({
        ...report,
        cap_eff: "0000000000000001",
      }),
      /capabilities/i,
    ],
    [
      "a namespace is the host namespace",
      (report: SandboxCapabilityProbeReport) => ({
        ...report,
        namespace: { ...report.namespace, net: hostNamespaces.net },
      }),
      /net namespace/i,
    ],
    [
      "nested user namespaces succeeded",
      (report: SandboxCapabilityProbeReport) => ({
        ...report,
        nested_userns_denied: false,
        nested_userns_errno: 0,
        nested_userns_result: 0,
      }),
      /nested user namespace/i,
    ],
    [
      "network denial uses an unknown errno",
      (report: SandboxCapabilityProbeReport) => ({
        ...report,
        host_connection_errno: 13,
      }),
      /network denial errno/i,
    ],
    [
      "nested user namespace denial uses an unknown errno",
      (report: SandboxCapabilityProbeReport) => ({
        ...report,
        nested_userns_errno: 13,
      }),
      /nested user namespace/i,
    ],
    [
      "the sentinel was visible",
      (report: SandboxCapabilityProbeReport) => ({
        ...report,
        sentinel_absent: false,
        sentinel_errno: 0,
      }),
      /sentinel/i,
    ],
    [
      "mountinfo is omitted",
      (report: SandboxCapabilityProbeReport) => ({ ...report, mountinfo: "" }),
      /mountinfo/i,
    ],
  ])("rejects when %s", (_name, change, message) => {
    expect(() => assertSandboxCapabilityProbeReport(change(validReport()), hostNamespaces)).toThrow(
      message,
    );
  });

  it("rejects malformed, oversized, and non-strict JSON", () => {
    expect(() => parseSandboxCapabilityProbeReport("{", hostNamespaces)).toThrow(/valid JSON/i);
    expect(() =>
      parseSandboxCapabilityProbeReport(
        JSON.stringify({ ...validReport(), unexpected: true }),
        hostNamespaces,
      ),
    ).toThrow(/schema/i);
    expect(() => parseSandboxCapabilityProbeReport("x".repeat(131_073), hostNamespaces)).toThrow(
      /too large/i,
    );
    expect(() =>
      assertSandboxCapabilityProbeReport(
        {
          ...validReport(),
          namespace: { ...validReport().namespace, pid: "mnt:[203]" },
        },
        hostNamespaces,
      ),
    ).toThrow(/schema/i);
    expect(() =>
      assertSandboxCapabilityProbeReport(
        { ...validReport(), mountinfo: "é".repeat(40_000) },
        hostNamespaces,
      ),
    ).toThrow(/mountinfo/i);
  });

  it("compiles the operator-prepared probe source with a clean test environment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-conductor-probe-"));
    try {
      await expect(
        execFile(
          "/usr/bin/cc",
          [
            "-std=c11",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-O2",
            "resources/sandbox/capability-probe-v1.c",
            "-o",
            join(directory, "capability-probe-v1"),
          ],
          {
            env: { LANG: "C", PATH: "/usr/bin:/bin" },
          },
        ),
      ).resolves.toBeDefined();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
