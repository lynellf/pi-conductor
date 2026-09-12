import { describe, expect, it } from "vitest";

import {
  assessBubblewrapStaticPrerequisites,
  BUBBLEWRAP_REQUIRED_OPTIONS,
  type BubblewrapStaticObservation,
  bubblewrapBinaryIdentityChanged,
  type CurrentBubblewrapBinary,
  type HostApprovedBubblewrapBuild,
} from "../../src/host/execution/sandbox/prerequisites.js";

const PATCHED_OPTIONS = BUBBLEWRAP_REQUIRED_OPTIONS;

function observation(
  overrides: Partial<BubblewrapStaticObservation> = {},
): BubblewrapStaticObservation {
  return {
    platform: "linux",
    observerUid: 1000,
    binary: {
      path: "/usr/bin/bwrap",
      identity: {
        device: 1,
        inode: 2,
        mode: 0o100755,
        uid: 0,
        gid: 0,
        size: 123,
        mtimeMs: 1,
        ctimeMs: 1,
      },
      sha256: "a".repeat(64),
      isRegularFile: true,
      fileCapabilities: [],
      upstreamVersionOutput: "bubblewrap 0.12.0\n",
      supportedOptions: PATCHED_OPTIONS,
    },
    ancestorDirectories: [
      { path: "/", isDirectory: true, uid: 0, mode: 0o40755 },
      { path: "/usr", isDirectory: true, uid: 0, mode: 0o40755 },
      { path: "/usr/bin", isDirectory: true, uid: 0, mode: 0o40755 },
    ],
    ...overrides,
  };
}

function approvedUpstream(release = "0.12.0"): HostApprovedBubblewrapBuild {
  return {
    kind: "upstream-release",
    release,
    binaryIdentity: observation().binary.identity,
    sha256: observation().binary.sha256,
    approvalId: "bubblewrap-release-approval",
  };
}

function verifiedBackport(version: string): HostApprovedBubblewrapBuild {
  return {
    kind: "distribution-backport",
    packageManager: "dpkg",
    packageName: "bubblewrap",
    packageVersion: version,
    advisory: "CVE-2026-87766",
    approvalId: "ubuntu-usn-0000-1",
    binaryIdentity: observation().binary.identity,
    sha256: observation().binary.sha256,
  };
}

function distributionPackage(
  version: string,
): NonNullable<BubblewrapStaticObservation["distributionPackage"]> {
  return {
    manager: "dpkg",
    name: "bubblewrap",
    version,
    installedBinaryIdentity: observation().binary.identity,
  };
}

function currentBinary(
  identity = observation().binary.identity,
  sha256 = observation().binary.sha256,
): CurrentBubblewrapBinary {
  return { identity, sha256 };
}

describe("Bubblewrap static prerequisites", () => {
  it("returns static evidence without claiming that the capability probe ran", () => {
    const result = assessBubblewrapStaticPrerequisites(observation(), [approvedUpstream()]);

    expect(result).toMatchObject({
      status: "accepted",
      evidence: {
        capabilityProbe: "not-run",
        version: "0.12.0",
        provenance: { kind: "upstream-release" },
      },
    });
  });

  it("rejects the current unverified Ubuntu Bubblewrap build", () => {
    const result = assessBubblewrapStaticPrerequisites(
      observation({
        binary: { ...observation().binary, upstreamVersionOutput: "bubblewrap 0.9.0" },
        distributionPackage: distributionPackage("0.9.0-1ubuntu0.1"),
      }),
    );

    expect(result).toEqual({
      status: "rejected",
      reason: "bubblewrap-unverified-build",
    });
  });

  it("accepts an exact host-approved distribution backport", () => {
    const result = assessBubblewrapStaticPrerequisites(
      observation({
        binary: { ...observation().binary, upstreamVersionOutput: "bubblewrap 0.9.0" },
        distributionPackage: distributionPackage("0.9.0-1ubuntu0.2"),
      }),
      [verifiedBackport("0.9.0-1ubuntu0.2")],
    );

    expect(result).toMatchObject({
      status: "accepted",
      evidence: {
        provenance: { kind: "distribution-backport", packageVersion: "0.9.0-1ubuntu0.2" },
      },
    });
  });

  it("rejects an upstream release without identity-bound host approval", () => {
    expect(assessBubblewrapStaticPrerequisites(observation())).toMatchObject({
      reason: "bubblewrap-unverified-build",
    });
  });

  it("rejects an upstream approval bound to a different binary", () => {
    const result = assessBubblewrapStaticPrerequisites(observation(), [
      { ...approvedUpstream(), binaryIdentity: { ...observation().binary.identity, inode: 7 } },
    ]);

    expect(result).toMatchObject({ reason: "bubblewrap-unverified-build" });
  });

  it("rejects an approval whose digest does not match the observed binary bytes", () => {
    const result = assessBubblewrapStaticPrerequisites(observation(), [
      { ...approvedUpstream(), sha256: "b".repeat(64) },
    ]);

    expect(result).toMatchObject({ reason: "bubblewrap-unverified-build" });
  });

  it.each([
    ["setuid binary", { mode: 0o104755 }],
    ["setgid binary", { mode: 0o102755 }],
    ["group-writable binary", { mode: 0o100775 }],
    ["other-writable binary", { mode: 0o100777 }],
    ["non-root binary", { uid: 1000 }],
    ["non-executable binary", { mode: 0o100750 }],
  ])("rejects an unsafe %s", (_name, identity) => {
    const result = assessBubblewrapStaticPrerequisites(
      observation({
        binary: {
          ...observation().binary,
          identity: { ...observation().binary.identity, ...identity },
        },
      }),
    );

    expect(result).toMatchObject({ status: "rejected" });
  });

  it.each([0o100775, 0o100777])("rejects a writable binary mode %#o", (mode) => {
    const result = assessBubblewrapStaticPrerequisites(
      observation({
        binary: {
          ...observation().binary,
          identity: { ...observation().binary.identity, mode },
        },
      }),
    );

    expect(result).toMatchObject({ reason: "bubblewrap-writable-mode" });
  });

  it.each([
    ["non-Linux", observation({ platform: "darwin" }), "bubblewrap-unsupported-platform"],
    ["root observer", observation({ observerUid: 0 }), "bubblewrap-privileged-observer"],
    [
      "relative path",
      observation({ binary: { ...observation().binary, path: "bwrap" } }),
      "bubblewrap-path-not-absolute",
    ],
    [
      "duplicate separator path",
      observation({ binary: { ...observation().binary, path: "/usr//bin/bwrap" } }),
      "bubblewrap-path-not-canonical",
    ],
    [
      "traversal path",
      observation({ binary: { ...observation().binary, path: "/usr/bin/../bin/bwrap" } }),
      "bubblewrap-path-not-canonical",
    ],
  ])("rejects %s", (_name, input, reason) => {
    expect(assessBubblewrapStaticPrerequisites(input)).toMatchObject({
      status: "rejected",
      reason,
    });
  });

  it("rejects non-regular binaries, file capabilities, and user-writable ancestors", () => {
    const nonRegular = assessBubblewrapStaticPrerequisites(
      observation({ binary: { ...observation().binary, isRegularFile: false } }),
    );
    const capabilities = assessBubblewrapStaticPrerequisites(
      observation({ binary: { ...observation().binary, fileCapabilities: ["cap_sys_admin=ep"] } }),
    );
    const writableAncestor = assessBubblewrapStaticPrerequisites(
      observation({
        ancestorDirectories: [
          { path: "/", isDirectory: true, uid: 0, mode: 0o40755 },
          { path: "/usr", isDirectory: true, uid: 0, mode: 0o40775 },
          { path: "/usr/bin", isDirectory: true, uid: 0, mode: 0o40755 },
        ],
      }),
    );

    expect(nonRegular).toMatchObject({ reason: "bubblewrap-not-regular-file" });
    expect(capabilities).toMatchObject({ reason: "bubblewrap-file-capabilities" });
    expect(writableAncestor).toMatchObject({ reason: "bubblewrap-unsafe-ancestor" });
  });

  it("rejects a missing or malformed ancestor chain", () => {
    const missing = assessBubblewrapStaticPrerequisites(
      observation({ ancestorDirectories: observation().ancestorDirectories.slice(1) }),
    );
    const nonDirectory = assessBubblewrapStaticPrerequisites(
      observation({
        ancestorDirectories: [
          { path: "/", isDirectory: true, uid: 0, mode: 0o40755 },
          { path: "/usr", isDirectory: false, uid: 0, mode: 0o40755 },
          { path: "/usr/bin", isDirectory: true, uid: 0, mode: 0o40755 },
        ],
      }),
    );

    expect(missing).toMatchObject({ reason: "bubblewrap-ancestor-mismatch" });
    expect(nonDirectory).toMatchObject({ reason: "bubblewrap-unsafe-ancestor" });
  });

  it("rejects missing required namespace and bootstrap options", () => {
    const result = assessBubblewrapStaticPrerequisites(
      observation({
        binary: {
          ...observation().binary,
          supportedOptions: PATCHED_OPTIONS.filter((option) => option !== "--unshare-net"),
        },
      }),
      [approvedUpstream()],
    );

    expect(result).toEqual({
      status: "rejected",
      reason: "bubblewrap-required-option-missing",
      option: "--unshare-net",
    });
  });

  it("requires the planned filesystem construction options", () => {
    expect(BUBBLEWRAP_REQUIRED_OPTIONS).toEqual(
      expect.arrayContaining([
        "--ro-bind",
        "--bind",
        "--dir",
        "--proc",
        "--dev",
        "--tmpfs",
        "--chdir",
        "--setenv",
      ]),
    );
  });

  it.each([
    ["pre-release", "bubblewrap 0.12.0-rc1"],
    ["suffix", "bubblewrap 0.12.0 Ubuntu"],
    ["malformed output", "bwrap 0.12.0"],
    ["multiple lines", "bubblewrap 0.12.0\nextra"],
    ["bare carriage return", "bubblewrap 0.12.0\r"],
  ])("rejects %s version output as upstream patch evidence", (_name, upstreamVersionOutput) => {
    expect(
      assessBubblewrapStaticPrerequisites(
        observation({ binary: { ...observation().binary, upstreamVersionOutput } }),
        [approvedUpstream()],
      ),
    ).toMatchObject({ reason: "bubblewrap-unverified-build" });
  });

  it("accepts a later exact upstream release", () => {
    expect(
      assessBubblewrapStaticPrerequisites(
        observation({
          binary: { ...observation().binary, upstreamVersionOutput: "bubblewrap 0.12.1" },
        }),
        [approvedUpstream("0.12.1")],
      ),
    ).toMatchObject({ status: "accepted", evidence: { version: "0.12.1" } });
  });

  it.each([
    ["manager", { manager: "rpm" }],
    ["name", { name: "bubblewrap-alt" }],
    ["version", { version: "0.9.0-1ubuntu0.3" }],
    [
      "installed binary identity",
      { installedBinaryIdentity: { ...observation().binary.identity, inode: 7 } },
    ],
  ])("rejects a backport with mismatched package %s", (_name, changedPackage) => {
    const result = assessBubblewrapStaticPrerequisites(
      observation({
        binary: { ...observation().binary, upstreamVersionOutput: "bubblewrap 0.9.0" },
        distributionPackage: { ...distributionPackage("0.9.0-1ubuntu0.2"), ...changedPackage },
      }),
      [verifiedBackport("0.9.0-1ubuntu0.2")],
    );

    expect(result).toMatchObject({ reason: "bubblewrap-unverified-build" });
  });

  it.each([
    ["device", { device: 2 }],
    ["inode", { inode: 99 }],
    ["mode", { mode: 0o100700 }],
    ["uid", { uid: 1 }],
    ["gid", { gid: 1 }],
    ["size", { size: 124 }],
    ["mtime", { mtimeMs: 2 }],
    ["ctime", { ctimeMs: 2 }],
  ])("detects a changed binary %s before spawn", (_name, changedIdentity) => {
    const accepted = assessBubblewrapStaticPrerequisites(observation(), [approvedUpstream()]);
    if (accepted.status !== "accepted") throw new Error("fixture must pass static prerequisites");

    expect(
      bubblewrapBinaryIdentityChanged(accepted.evidence, {
        identity: { ...observation().binary.identity, ...changedIdentity },
        sha256: observation().binary.sha256,
      }),
    ).toBe(true);
  });

  it("keeps matching binary identity valid before spawn", () => {
    const accepted = assessBubblewrapStaticPrerequisites(observation(), [approvedUpstream()]);
    if (accepted.status !== "accepted") throw new Error("fixture must pass static prerequisites");

    expect(bubblewrapBinaryIdentityChanged(accepted.evidence, currentBinary())).toBe(false);
  });

  it("detects a digest change even when stat identity remains the same", () => {
    const accepted = assessBubblewrapStaticPrerequisites(observation(), [approvedUpstream()]);
    if (accepted.status !== "accepted") throw new Error("fixture must pass static prerequisites");

    expect(
      bubblewrapBinaryIdentityChanged(accepted.evidence, currentBinary(undefined, "b".repeat(64))),
    ).toBe(true);
  });
});
