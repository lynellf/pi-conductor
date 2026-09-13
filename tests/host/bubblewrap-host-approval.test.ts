import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadSandboxHostApproval,
  sandboxHostApprovalSchema,
} from "../../src/host/execution/sandbox/host-approval.js";
import { SANDBOX_CAPABILITY_PROBE_PATH } from "../../src/persistence/sandbox-probe.js";

const dirs: string[] = [];
const digest = (char: string) => char.repeat(64);
const identity = {
  device: 1,
  inode: 2,
  mode: 0o755,
  uid: 0,
  gid: 0,
  size: 1,
  mtimeMs: 1,
  ctimeMs: 1,
};

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pi-conductor-approval-"));
  dirs.push(directory);
  const probePath = SANDBOX_CAPABILITY_PROBE_PATH.slice(1);
  const value = {
    schemaVersion: 1,
    binaryPath: "/opt/pi-conductor-test/bubblewrap-0.12.0/bin/bwrap",
    approvedBuilds: [
      {
        kind: "upstream-release" as const,
        release: "0.12.0",
        binaryIdentity: identity,
        sha256: digest("a"),
        approvalId: "bwrap-0.12.0",
      },
    ],
    bootstrapApproval: {
      approvalId: "runtime-v1",
      files: [
        { path: "bin/bash", sha256: digest("b") },
        { path: probePath, sha256: digest("c") },
      ],
    },
    probeApproval: { approvalId: "probe-v1", sha256: digest("c") },
  };
  const path = join(directory, "approval.json");
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return { directory, path, value };
}

describe("host Bubblewrap approval loader", () => {
  it("loads and deeply freezes a strict approval document", async () => {
    const value = await fixture();
    const approval = await loadSandboxHostApproval(value.path);
    expect(approval).toEqual(value.value);
    expect(Object.isFrozen(approval)).toBe(true);
    expect(Object.isFrozen(approval.bootstrapApproval.files)).toBe(true);
    expect(Value.Check(sandboxHostApprovalSchema, approval)).toBe(true);
  });

  it.each([
    ["unknown field", (value: Record<string, unknown>) => (value.extra = true)],
    [
      "invalid digest",
      (value: Record<string, unknown>) => {
        const builds = value.approvedBuilds as Array<Record<string, unknown>>;
        const first = builds[0];
        if (first !== undefined) first.sha256 = "bad";
      },
    ],
    [
      "runtime traversal",
      (value: Record<string, unknown>) => {
        const bootstrap = value.bootstrapApproval as Record<string, unknown>;
        bootstrap.files = [{ path: "../bin/bash", sha256: digest("b") }];
      },
    ],
    [
      "probe mismatch",
      (value: Record<string, unknown>) => {
        const probe = value.probeApproval as Record<string, unknown>;
        probe.sha256 = digest("d");
      },
    ],
    [
      "duplicate inventory path",
      (value: Record<string, unknown>) => {
        const bootstrap = value.bootstrapApproval as Record<string, unknown>;
        bootstrap.files = [
          { path: "bin/bash", sha256: digest("b") },
          { path: "bin/bash", sha256: digest("b") },
        ];
      },
    ],
    ["relative binary path", (value: Record<string, unknown>) => (value.binaryPath = "bin/bwrap")],
    ["root binary path", (value: Record<string, unknown>) => (value.binaryPath = "/")],
  ])("rejects %s", async (_label, mutate) => {
    const value = await fixture();
    const changed = structuredClone(value.value) as unknown as Record<string, unknown>;
    mutate(changed);
    await writeFile(value.path, JSON.stringify(changed));
    await expect(loadSandboxHostApproval(value.path)).rejects.toThrow();
  });

  it("rejects unsafe approval permissions and symlink files", async () => {
    const value = await fixture();
    await chmod(value.path, 0o644);
    await expect(loadSandboxHostApproval(value.path)).rejects.toThrow("mode 600");
    const link = join(value.directory, "approval-link.json");
    await symlink(value.path, link);
    await expect(loadSandboxHostApproval(link)).rejects.toThrow();
  });

  it("rejects an oversized document", async () => {
    const value = await fixture();
    await writeFile(value.path, `${JSON.stringify(value.value)}${"x".repeat(8 * 1024 * 1024)}`);
    await expect(loadSandboxHostApproval(value.path)).rejects.toThrow(/too large|byte bound/);
  });
});
