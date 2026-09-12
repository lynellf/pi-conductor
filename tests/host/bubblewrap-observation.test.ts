import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  type BubblewrapObservationCommand,
  BubblewrapObservationError,
  collectBubblewrapStaticObservation,
} from "../../src/host/execution/sandbox/observation.js";
import type { HostApprovedBubblewrapBuild } from "../../src/host/execution/sandbox/prerequisites.js";

const BWRAP = "/opt/pi-conductor-test/bubblewrap-0.12.0/bin/bwrap";

describe("Bubblewrap static observation", () => {
  it("requires host approval before version/help execution", async () => {
    const calls: string[] = [];
    const command: BubblewrapObservationCommand = async (file) => {
      calls.push(file);
      return { stdout: "", stderr: "" };
    };

    await expect(
      collectBubblewrapStaticObservation({
        binaryPath: BWRAP,
        approvedBuilds: [],
        runCommand: command,
      }),
    ).rejects.toMatchObject({ code: "bubblewrap-observation-unapproved-build" });
    expect(calls).toEqual(["/usr/sbin/getcap"]);
  });

  it("collects identity-bound digest, capabilities, ancestors, version, and options", async () => {
    const identity = await fileIdentity(BWRAP);
    const sha256 = await fileDigest(BWRAP);
    const approved: HostApprovedBubblewrapBuild = {
      kind: "upstream-release",
      release: "0.12.0",
      binaryIdentity: identity,
      sha256,
      approvalId: "test-approval",
    };
    const command: BubblewrapObservationCommand = async (file, args) => {
      if (file === "/usr/sbin/getcap") return { stdout: "", stderr: "" };
      if (args[0] === "--version") return { stdout: "bubblewrap 0.12.0\n", stderr: "" };
      return { stdout: "Usage: bwrap --unshare-net --die-with-parent --ro-bind\n", stderr: "" };
    };

    const observed = await collectBubblewrapStaticObservation({
      binaryPath: BWRAP,
      approvedBuilds: [approved],
      runCommand: command,
    });
    expect(observed.binary.sha256).toBe(sha256);
    expect(observed.binary.fileCapabilities).toEqual([]);
    expect(observed.binary.supportedOptions).toEqual([
      "--unshare-net",
      "--die-with-parent",
      "--ro-bind",
    ]);
    expect(observed.ancestorDirectories.at(-1)?.path).toBe(
      "/opt/pi-conductor-test/bubblewrap-0.12.0/bin",
    );
  });

  it("reports command failures as typed observation errors", async () => {
    const command: BubblewrapObservationCommand = async (file) => {
      if (file === "/usr/sbin/getcap") return { stdout: "", stderr: "" };
      throw new Error("refused");
    };
    const result = collectBubblewrapStaticObservation({
      binaryPath: BWRAP,
      approvedBuilds: [],
      runCommand: command,
    });
    await expect(result).rejects.toBeInstanceOf(BubblewrapObservationError);
  });
});

async function fileIdentity(path: string) {
  const info = await stat(await realpath(path));
  return {
    device: info.dev,
    inode: info.ino,
    mode: info.mode,
    uid: info.uid,
    gid: info.gid,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  };
}

async function fileDigest(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
