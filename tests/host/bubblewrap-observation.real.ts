/** Real static-observation gate for the approved Issue #106 test runtime. */
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { collectBubblewrapStaticObservation } from "../../src/host/execution/sandbox/observation.js";
import {
  assessBubblewrapStaticPrerequisites,
  type BubblewrapBinaryIdentity,
  type HostApprovedBubblewrapBuild,
} from "../../src/host/execution/sandbox/prerequisites.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Real observation gate requires ${name}`);
  return value;
}

function identityOf(stat: {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}): BubblewrapBinaryIdentity {
  return {
    device: stat.dev,
    inode: stat.ino,
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

describe("approved Bubblewrap static observation", () => {
  it("observes the protected binary with real getcap and passes static prerequisites", async () => {
    const binaryPath = required("PI_CONDUCTOR_BWRAP");
    const expectedSha256 = required("PI_CONDUCTOR_BWRAP_SHA256");
    required("PI_CONDUCTOR_BWRAP_RUNTIME");
    const bytes = await readFile(binaryPath);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(expectedSha256);
    const identity = identityOf(await lstat(binaryPath));
    const approval: HostApprovedBubblewrapBuild = {
      kind: "upstream-release",
      release: "0.12.0",
      binaryIdentity: identity,
      sha256: expectedSha256,
      approvalId: "approved-issue-106-local-test-runtime",
    };

    const observation = await collectBubblewrapStaticObservation({
      binaryPath,
      approvedBuilds: [approval],
    });

    expect(observation.binary.identity).toEqual(identity);
    expect(observation.binary.fileCapabilities).toEqual([]);
    expect(assessBubblewrapStaticPrerequisites(observation, [approval])).toMatchObject({
      status: "accepted",
      evidence: {
        capabilityProbe: "not-run",
        binaryPath,
        sha256: expectedSha256,
        version: "0.12.0",
      },
    });
  });
});
