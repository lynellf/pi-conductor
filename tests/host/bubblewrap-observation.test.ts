import { describe, expect, it } from "vitest";

import {
  type BubblewrapFileObserver,
  type BubblewrapObservationCommand,
  BubblewrapObservationError,
  collectBubblewrapStaticObservation,
  type ObservedTrustedFile,
} from "../../src/host/execution/sandbox/observation.js";
import {
  isPatchedRelease,
  sameIdentity,
  validIdentity,
} from "../../src/host/execution/sandbox/observation-support.js";
import type {
  BubblewrapBinaryIdentity,
  HostApprovedBubblewrapBuild,
} from "../../src/host/execution/sandbox/prerequisites.js";

const BWRAP = "/usr/bin/bwrap";
const GETCAP = "/usr/sbin/getcap";
const identity: BubblewrapBinaryIdentity = {
  device: 1,
  inode: 2,
  mode: 0o100755,
  uid: 0,
  gid: 0,
  size: 42,
  mtimeMs: 10,
  ctimeMs: 11,
};
const observed: ObservedTrustedFile = {
  identity,
  sha256: "a".repeat(64),
  ancestors: [{ path: "/usr", isDirectory: true, uid: 0, mode: 0o40755 }],
};

function approval(): Extract<HostApprovedBubblewrapBuild, { kind: "upstream-release" }> {
  return {
    kind: "upstream-release",
    release: "0.12.0",
    binaryIdentity: identity,
    sha256: observed.sha256,
    approvalId: "test-approval",
  };
}

function setup(overrides: {
  readonly binary?: ObservedTrustedFile;
  readonly getcap?: ObservedTrustedFile;
  readonly command?: BubblewrapObservationCommand;
  readonly canonicalizePath?: (path: string) => Promise<string>;
}) {
  const calls: string[] = [];
  const command: BubblewrapObservationCommand =
    overrides.command ??
    (async (file, args) => {
      calls.push(`${file} ${args.join(" ")}`);
      if (file === GETCAP) return { stdout: "", stderr: "" };
      return args[0] === "--version"
        ? { stdout: "bubblewrap 0.12.0\n", stderr: "" }
        : { stdout: "Usage: bwrap --unshare-net --ro-bind\n", stderr: "" };
    });
  const observeFile: BubblewrapFileObserver = async (path) => {
    calls.push(`observe ${path}`);
    return path === BWRAP ? (overrides.binary ?? observed) : (overrides.getcap ?? observed);
  };
  return {
    calls,
    options: {
      binaryPath: BWRAP,
      approvedBuilds: [approval()],
      getcapPath: GETCAP,
      runCommand: command,
      observeFile,
      canonicalizePath: overrides.canonicalizePath ?? (async (path) => path),
      platform: "linux",
      observerUid: 1000,
    },
  };
}

describe("Bubblewrap static observation", () => {
  it("requires host approval before version/help execution", async () => {
    const fixture = setup({});
    fixture.options.approvedBuilds = [];
    await expect(collectBubblewrapStaticObservation(fixture.options)).rejects.toMatchObject({
      code: "bubblewrap-observation-unapproved-build",
    });
    expect(fixture.calls.some((call) => call.includes("--version"))).toBe(false);
  });

  it("reports a bwrap command failure only after approval", async () => {
    let versionAttempted = false;
    const fixture = setup({
      command: async (file) => {
        if (file === GETCAP) return { stdout: "", stderr: "" };
        versionAttempted = true;
        throw new Error("refused");
      },
    });
    await expect(collectBubblewrapStaticObservation(fixture.options)).rejects.toMatchObject({
      code: "bubblewrap-observation-command-failed",
    });
    expect(versionAttempted).toBe(true);
  });

  it("collects identity-bound evidence through deterministic seams", async () => {
    const result = await collectBubblewrapStaticObservation(setup({}).options);
    expect(result.binary.sha256).toBe(observed.sha256);
    expect(result.binary.fileCapabilities).toEqual([]);
    expect(result.binary.supportedOptions).toEqual(["--unshare-net", "--ro-bind"]);
  });

  it.each([
    [
      "non-linux",
      { platform: "darwin", observerUid: 1000 },
      "bubblewrap-observation-unsupported-platform",
    ],
    [
      "root observer",
      { platform: "linux", observerUid: 0 },
      "bubblewrap-observation-privileged-observer",
    ],
  ])("rejects %s before running commands", async (_name, context, code) => {
    const fixture = setup({});
    Object.assign(fixture.options, context);
    await expect(collectBubblewrapStaticObservation(fixture.options)).rejects.toMatchObject({
      code,
    });
    expect(fixture.calls).toEqual([]);
  });

  it.each([
    ["set-id", { ...identity, mode: 0o104755 }],
    ["non-executable", { ...identity, mode: 0o100644 }],
  ])("rejects unsafe binary mode (%s) before bwrap", async (_name, unsafeIdentity) => {
    const fixture = setup({ binary: { ...observed, identity: unsafeIdentity } });
    await expect(collectBubblewrapStaticObservation(fixture.options)).rejects.toMatchObject({
      code: "bubblewrap-observation-unsafe-file",
    });
    expect(fixture.calls.some((call) => call.includes("--version"))).toBe(false);
  });

  it("rejects capabilities and getcap diagnostics before bwrap", async () => {
    const capability = setup({
      command: async (file) =>
        file === GETCAP
          ? { stdout: `${BWRAP} cap_setuid\n`, stderr: "" }
          : { stdout: "bubblewrap 0.12.0\n", stderr: "" },
    });
    await expect(collectBubblewrapStaticObservation(capability.options)).rejects.toMatchObject({
      code: "bubblewrap-observation-unsafe-file",
    });
    const diagnostic = setup({
      command: async (file) =>
        file === GETCAP
          ? { stdout: "", stderr: "getcap: unreadable\n" }
          : { stdout: "", stderr: "" },
    });
    await expect(collectBubblewrapStaticObservation(diagnostic.options)).rejects.toMatchObject({
      code: "bubblewrap-observation-capability-check-failed",
    });
  });

  it.each([
    ["whitespace stdout", { stdout: " \n", stderr: "" }],
    ["whitespace stderr", { stdout: "", stderr: " \n" }],
    ["oversized stderr", { stdout: "", stderr: "x".repeat(64 * 1024 + 1) }],
  ])("rejects ambiguous getcap output: %s", async (_name, output) => {
    const fixture = setup({
      command: async (file) =>
        file === GETCAP ? output : { stdout: "bubblewrap 0.12.0\n", stderr: "" },
    });
    await expect(collectBubblewrapStaticObservation(fixture.options)).rejects.toMatchObject({
      code: "bubblewrap-observation-capability-check-failed",
    });
  });

  it.each([
    ["set-id", 0o104755],
    ["not executable by the observer", 0o100750],
  ])("rejects unsafe getcap mode: %s", async (_name, mode) => {
    const fixture = setup({
      getcap: { ...observed, identity: { ...identity, mode } },
    });
    await expect(collectBubblewrapStaticObservation(fixture.options)).rejects.toMatchObject({
      code: "bubblewrap-observation-unsafe-file",
    });
    expect(fixture.calls.some((call) => call.startsWith(`${GETCAP} `))).toBe(false);
  });

  it("rejects a canonicalization mismatch", async () => {
    const fixture = setup({ canonicalizePath: async () => "/usr/lib/bwrap" });
    await expect(collectBubblewrapStaticObservation(fixture.options)).rejects.toMatchObject({
      code: "bubblewrap-observation-invalid-path",
    });
    expect(fixture.calls).toEqual([]);
  });

  it("checks identity immediately before each bwrap command", async () => {
    let binaryReads = 0;
    const fixture = setup({});
    fixture.options.observeFile = async (path) => {
      if (path === BWRAP) {
        binaryReads += 1;
        return binaryReads >= 2 ? { ...observed, identity: { ...identity, inode: 99 } } : observed;
      }
      return observed;
    };
    await expect(collectBubblewrapStaticObservation(fixture.options)).rejects.toMatchObject({
      code: "bubblewrap-observation-mutated",
    });
    expect(fixture.calls.some((call) => call.includes("--version"))).toBe(false);
  });

  it("bounds stdout and stderr from version/help commands", async () => {
    const huge = "x".repeat(64 * 1024 + 1);
    const fixture = setup({
      command: async (file, args) =>
        file === GETCAP
          ? { stdout: "", stderr: "" }
          : args[0] === "--version"
            ? { stdout: huge, stderr: "" }
            : { stdout: "", stderr: huge },
    });
    await expect(collectBubblewrapStaticObservation(fixture.options)).rejects.toBeInstanceOf(
      BubblewrapObservationError,
    );
  });

  it("rejects nonempty stderr from a successful bwrap command", async () => {
    const fixture = setup({
      command: async (file, args) =>
        file === GETCAP
          ? { stdout: "", stderr: "" }
          : args[0] === "--version"
            ? { stdout: "bubblewrap 0.12.0\n", stderr: "warning\n" }
            : { stdout: "Usage: bwrap --unshare-net\n", stderr: "" },
    });
    await expect(collectBubblewrapStaticObservation(fixture.options)).rejects.toMatchObject({
      code: "bubblewrap-observation-command-failed",
    });
  });

  it("rejects approvals below the supported release before bwrap", async () => {
    const fixture = setup({});
    const below: Extract<HostApprovedBubblewrapBuild, { kind: "upstream-release" }> = {
      ...approval(),
      release: "0.11.0",
    };
    fixture.options.approvedBuilds = [below];
    await expect(collectBubblewrapStaticObservation(fixture.options)).rejects.toMatchObject({
      code: "bubblewrap-observation-unapproved-build",
    });
    expect(fixture.calls.some((call) => call.includes("--version"))).toBe(false);
  });
});

describe("Bubblewrap observation support", () => {
  it("accepts finite fractional stat timestamps with integer identity fields", () => {
    expect(validIdentity({ ...identity, mtimeMs: 10.25, ctimeMs: 11.75 })).toBe(true);
  });

  it.each([
    ["fractional inode", { ...identity, inode: 2.5 }],
    ["infinite timestamp", { ...identity, mtimeMs: Number.POSITIVE_INFINITY }],
    ["negative timestamp", { ...identity, ctimeMs: -1 }],
  ])("rejects invalid identity: %s", (_name, candidate) => {
    expect(validIdentity(candidate)).toBe(false);
  });

  it("compares every required identity field explicitly", () => {
    const { ctimeMs: _omitted, ...missing } = identity;
    expect(sameIdentity(identity, missing as BubblewrapBinaryIdentity)).toBe(false);
  });

  it("rejects release components outside the safe integer range", () => {
    expect(isPatchedRelease("999999999999999999999.12.0")).toBe(false);
  });
});
