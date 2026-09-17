import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { capturePreparedRuntime } from "../../src/host/execution/sandbox/runtime-capture.js";
import { inventoryRuntimeTree } from "../../src/host/execution/sandbox/runtime-files.js";
import type { HostApprovedBootstrapRuntime } from "../../src/host/execution/sandbox/runtime-types.js";
import { verifyPreparedRuntimeSnapshot } from "../../src/host/execution/sandbox/runtime-verify.js";

const roots: string[] = [];
const execute = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await makeDirectoriesWritable(root);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "conductor-runtime-test-"));
  roots.push(root);
  const source = join(root, "checkout/.pi/prepared-runtime");
  const snapshots = join(root, "state/runtime-snapshots");
  await mkdir(join(source, "bin"), { recursive: true });
  await mkdir(join(source, "lib"));
  await mkdir(snapshots, { recursive: true, mode: 0o700 });
  await chmod(join(root, "state"), 0o700);
  await chmod(snapshots, 0o700);
  await writeFile(join(source, "bin/bash"), "trusted bash\n", { mode: 0o751 });
  await writeFile(join(source, "lib/libc.so.6"), "trusted libc\n", { mode: 0o644 });
  const approval: HostApprovedBootstrapRuntime = {
    approvalId: "host-approved-bootstrap-v1",
    files: [
      { path: "bin/bash", sha256: await digest(join(source, "bin/bash")) },
      { path: "lib/libc.so.6", sha256: await digest(join(source, "lib/libc.so.6")) },
    ],
  };
  return { root, source, snapshots, approval };
}

function hostProtection(value: Awaited<ReturnType<typeof fixture>>) {
  return {
    primaryCheckout: join(value.root, "checkout"),
    stateRoots: [join(value.root, "state")],
    childWorkspaceRoots: [] as string[],
  };
}

describe("prepared runtime capture", () => {
  it("creates a private immutable snapshot with independent inodes and stable digests", async () => {
    const value = await fixture();
    await mkdir(join(value.root, "other-child"));
    const descriptor = await capturePreparedRuntime({
      sourcePath: value.source,
      snapshotParent: value.snapshots,
      hostProtection: {
        ...hostProtection(value),
        childWorkspaceRoots: [join(value.root, "other-child")],
      },
      bootstrapApproval: value.approval,
    });

    expect(descriptor).toMatchObject({
      schemaVersion: 1,
      canonicalSourcePath: value.source,
      bootstrapApprovalId: value.approval.approvalId,
      inventoryDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      approvedInventoryDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect((await lstat(join(descriptor.snapshotPath, "bin/bash"))).ino).not.toBe(
      (await lstat(join(value.source, "bin/bash"))).ino,
    );
    expect((await lstat(join(descriptor.snapshotPath, "bin/bash"))).mode & 0o777).toBe(0o511);
    expect((await lstat(join(descriptor.snapshotPath, "lib/libc.so.6"))).mode & 0o777).toBe(0o400);
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.inventory)).toBe(true);
  });

  it.each([
    "symlink",
    "hardlink",
  ])("rejects a %s without retaining a partial snapshot", async (kind) => {
    const value = await fixture();
    if (kind === "symlink") {
      await symlink("bash", join(value.source, "bin/alias"));
    } else {
      await link(join(value.source, "bin/bash"), join(value.source, "bin/alias"));
    }
    const before = await readdir(value.snapshots);
    await expect(
      capturePreparedRuntime({
        sourcePath: value.source,
        snapshotParent: value.snapshots,
        hostProtection: hostProtection(value),
        bootstrapApproval: value.approval,
      }),
    ).rejects.toMatchObject({ code: "runtime-unsafe-entry" });
    expect(await readdir(value.snapshots)).toEqual(before);
  });

  it("rejects a FIFO without blocking and removes the partial snapshot", async () => {
    const value = await fixture();
    await execute("/usr/bin/mkfifo", [join(value.source, "lib/control")]);
    await expect(
      capturePreparedRuntime({
        sourcePath: value.source,
        snapshotParent: value.snapshots,
        hostProtection: hostProtection(value),
        bootstrapApproval: value.approval,
      }),
    ).rejects.toMatchObject({ code: "runtime-unsafe-entry" });
    expect(await readdir(value.snapshots)).toEqual([]);
  });

  it("rejects a regular file in place of an allowed top-level directory", async () => {
    const value = await fixture();
    await writeFile(join(value.source, "etc"), "not a directory\n");
    await expect(
      capturePreparedRuntime({
        sourcePath: value.source,
        snapshotParent: value.snapshots,
        hostProtection: hostProtection(value),
        bootstrapApproval: value.approval,
      }),
    ).rejects.toMatchObject({ code: "runtime-unsafe-entry" });
  });

  it("rejects nested Git control data", async () => {
    const value = await fixture();
    await mkdir(join(value.source, "etc/.git"), { recursive: true });
    await writeFile(join(value.source, "etc/.git/config"), "unsafe\n");
    await expect(
      capturePreparedRuntime({
        sourcePath: value.source,
        snapshotParent: value.snapshots,
        hostProtection: hostProtection(value),
        bootstrapApproval: value.approval,
      }),
    ).rejects.toMatchObject({ code: "runtime-unsafe-entry" });
  });

  it.each([
    "etc/ld.so.preload",
    "lib/unapproved.so",
  ])("rejects unapproved runtime file %s", async (relativePath) => {
    const value = await fixture();
    await mkdir(dirname(join(value.source, relativePath)), { recursive: true });
    await writeFile(join(value.source, relativePath), "unapproved\n");
    await expect(
      capturePreparedRuntime({
        sourcePath: value.source,
        snapshotParent: value.snapshots,
        hostProtection: hostProtection(value),
        bootstrapApproval: value.approval,
      }),
    ).rejects.toMatchObject({ code: "runtime-approval-mismatch" });
  });

  it("detects source mutation after copying and removes only its new private tree", async () => {
    const value = await fixture();
    await writeFile(join(value.snapshots, "retained"), "unrelated\n");
    await expect(
      capturePreparedRuntime({
        sourcePath: value.source,
        snapshotParent: value.snapshots,
        hostProtection: hostProtection(value),
        bootstrapApproval: value.approval,
        testHookAfterCopy: async () => {
          await writeFile(join(value.source, "lib/libc.so.6"), "mutated\n");
        },
      }),
    ).rejects.toMatchObject({ code: "runtime-mutated" });
    expect(await readdir(value.snapshots)).toEqual(["retained"]);
  });

  it("makes snapshot mutation observable before later admission", async () => {
    const value = await fixture();
    const descriptor = await capturePreparedRuntime({
      sourcePath: value.source,
      snapshotParent: value.snapshots,
      hostProtection: hostProtection(value),
      bootstrapApproval: value.approval,
    });
    const bash = join(descriptor.snapshotPath, "bin/bash");
    await chmod(bash, 0o600);
    await writeFile(bash, "changed snapshot\n");
    expect(await inventoryRuntimeTree(descriptor.snapshotPath)).not.toEqual(descriptor.inventory);
    await expect(
      verifyPreparedRuntimeSnapshot(descriptor, {
        snapshotParent: value.snapshots,
        bootstrapApproval: value.approval,
      }),
    ).rejects.toThrow();
  });

  it("verifies an unchanged snapshot without rereading a changed or removed source", async () => {
    const value = await fixture();
    const descriptor = await capturePreparedRuntime({
      sourcePath: value.source,
      snapshotParent: value.snapshots,
      hostProtection: hostProtection(value),
      bootstrapApproval: value.approval,
    });
    await rm(value.source, { recursive: true, force: true });
    await expect(
      verifyPreparedRuntimeSnapshot(descriptor, {
        snapshotParent: value.snapshots,
        bootstrapApproval: value.approval,
      }),
    ).resolves.toMatchObject({ inventoryDigest: descriptor.inventoryDigest });
  });

  it("compares valid inventory values independently of JSON property insertion order", async () => {
    const value = await fixture();
    const descriptor = await capturePreparedRuntime({
      sourcePath: value.source,
      snapshotParent: value.snapshots,
      hostProtection: hostProtection(value),
      bootstrapApproval: value.approval,
    });
    const reordered = descriptor.inventory.map((entry) =>
      entry.type === "directory"
        ? { type: entry.type, path: entry.path }
        : {
            sha256: entry.sha256,
            executableMode: entry.executableMode,
            type: entry.type,
            path: entry.path,
          },
    );
    await expect(
      verifyPreparedRuntimeSnapshot(
        { ...descriptor, inventory: reordered },
        { snapshotParent: value.snapshots, bootstrapApproval: value.approval },
      ),
    ).resolves.toMatchObject({ inventoryDigest: descriptor.inventoryDigest });
  });

  it.each(["deleted", "extra"])("rejects a %s snapshot entry", async (change) => {
    const value = await fixture();
    const descriptor = await capturePreparedRuntime({
      sourcePath: value.source,
      snapshotParent: value.snapshots,
      hostProtection: hostProtection(value),
      bootstrapApproval: value.approval,
    });
    const lib = join(descriptor.snapshotPath, "lib");
    const libc = join(lib, "libc.so.6");
    await chmod(lib, 0o700);
    if (change === "deleted") await rm(libc);
    if (change === "extra") {
      const extra = join(lib, "extra.so");
      await writeFile(extra, "extra\n");
      await chmod(extra, 0o400);
    }
    await chmod(lib, 0o500);
    await expect(
      verifyPreparedRuntimeSnapshot(descriptor, {
        snapshotParent: value.snapshots,
        bootstrapApproval: value.approval,
      }),
    ).rejects.toMatchObject({ code: "runtime-mutated" });
  });

  it("rejects a writable snapshot entry as unsafe", async () => {
    const value = await fixture();
    const descriptor = await capturePreparedRuntime({
      sourcePath: value.source,
      snapshotParent: value.snapshots,
      hostProtection: hostProtection(value),
      bootstrapApproval: value.approval,
    });
    await chmod(join(descriptor.snapshotPath, "lib/libc.so.6"), 0o600);
    await expect(
      verifyPreparedRuntimeSnapshot(descriptor, {
        snapshotParent: value.snapshots,
        bootstrapApproval: value.approval,
      }),
    ).rejects.toMatchObject({ code: "runtime-unsafe-entry" });
  });

  it("rejects malformed persisted data before accessing its snapshot path", async () => {
    const value = await fixture();
    const malformed = {
      schemaVersion: 1,
      snapshotPath: "/definitely-not-accessed",
      unexpected: true,
    };
    await expect(
      verifyPreparedRuntimeSnapshot(malformed, {
        snapshotParent: value.snapshots,
        bootstrapApproval: value.approval,
      }),
    ).rejects.toMatchObject({ code: "runtime-mutated" });
  });

  it.each([
    "digest",
    "order",
    "duplicate",
  ])("rejects a descriptor with invalid %s metadata", async (kind) => {
    const value = await fixture();
    const descriptor = await capturePreparedRuntime({
      sourcePath: value.source,
      snapshotParent: value.snapshots,
      hostProtection: hostProtection(value),
      bootstrapApproval: value.approval,
    });
    const inventory = [...descriptor.inventory];
    if (kind === "order") inventory.reverse();
    const first = inventory[0];
    if (kind === "duplicate" && first !== undefined) inventory.push(first);
    const changed =
      kind === "digest"
        ? { ...descriptor, inventoryDigest: "0".repeat(64) }
        : { ...descriptor, inventory };
    await expect(
      verifyPreparedRuntimeSnapshot(changed, {
        snapshotParent: value.snapshots,
        bootstrapApproval: value.approval,
      }),
    ).rejects.toMatchObject({ code: "runtime-mutated" });
  });

  it("rejects a valid descriptor outside the caller's required snapshot parent", async () => {
    const value = await fixture();
    const descriptor = await capturePreparedRuntime({
      sourcePath: value.source,
      snapshotParent: value.snapshots,
      hostProtection: hostProtection(value),
      bootstrapApproval: value.approval,
    });
    const otherParent = join(value.root, "other-state");
    await mkdir(otherParent, { mode: 0o700 });
    await expect(
      verifyPreparedRuntimeSnapshot(descriptor, {
        snapshotParent: otherParent,
        bootstrapApproval: value.approval,
      }),
    ).rejects.toMatchObject({ code: "runtime-mutated" });
  });

  it("rejects a writable generated private parent", async () => {
    const value = await fixture();
    const descriptor = await capturePreparedRuntime({
      sourcePath: value.source,
      snapshotParent: value.snapshots,
      hostProtection: hostProtection(value),
      bootstrapApproval: value.approval,
    });
    await chmod(join(descriptor.snapshotPath, ".."), 0o777);
    await expect(
      verifyPreparedRuntimeSnapshot(descriptor, {
        snapshotParent: value.snapshots,
        bootstrapApproval: value.approval,
      }),
    ).rejects.toMatchObject({ code: "runtime-invalid-source" });
  });

  it("detects snapshot-root mutation across verification", async () => {
    const value = await fixture();
    const descriptor = await capturePreparedRuntime({
      sourcePath: value.source,
      snapshotParent: value.snapshots,
      hostProtection: hostProtection(value),
      bootstrapApproval: value.approval,
    });
    await expect(
      verifyPreparedRuntimeSnapshot(descriptor, {
        snapshotParent: value.snapshots,
        bootstrapApproval: value.approval,
        testHookBeforeFinalIdentity: async () => {
          await chmod(descriptor.snapshotPath, 0o700);
          await writeFile(join(descriptor.snapshotPath, "late-entry"), "late\n");
          await chmod(descriptor.snapshotPath, 0o500);
        },
      }),
    ).rejects.toMatchObject({ code: "runtime-mutated" });
  });

  it.each([
    [
      "missing bin/bash approval",
      (approval: HostApprovedBootstrapRuntime) => ({ ...approval, files: approval.files.slice(1) }),
    ],
    [
      "changed approved digest",
      (approval: HostApprovedBootstrapRuntime) => ({
        ...approval,
        files: approval.files.map((file) =>
          file.path === "bin/bash" ? { ...file, sha256: "0".repeat(64) } : file,
        ),
      }),
    ],
  ])("rejects %s", async (_name, change) => {
    const value = await fixture();
    await expect(
      capturePreparedRuntime({
        sourcePath: value.source,
        snapshotParent: value.snapshots,
        hostProtection: hostProtection(value),
        bootstrapApproval: change(value.approval),
      }),
    ).rejects.toMatchObject({ code: "runtime-approval-mismatch" });
  });

  it("rejects source roots that contain protected trees while allowing a prepared descendant", async () => {
    const value = await fixture();
    const checkout = join(value.root, "checkout");
    await expect(
      capturePreparedRuntime({
        sourcePath: checkout,
        snapshotParent: value.snapshots,
        hostProtection: hostProtection(value),
        bootstrapApproval: value.approval,
      }),
    ).rejects.toMatchObject({ code: "runtime-invalid-source" });
    await expect(
      capturePreparedRuntime({
        sourcePath: value.source,
        snapshotParent: value.snapshots,
        hostProtection: hostProtection(value),
        bootstrapApproval: value.approval,
      }),
    ).resolves.toMatchObject({ canonicalSourcePath: value.source });
  });

  it.each([
    ["missing contract", undefined],
    [
      "empty state roots",
      { primaryCheckout: "/checkout", stateRoots: [], childWorkspaceRoots: [] },
    ],
    [
      "noncanonical primary",
      { primaryCheckout: "/checkout/../other", stateRoots: ["/state"], childWorkspaceRoots: [] },
    ],
  ])("rejects %s host protection", async (_name, protection) => {
    const value = await fixture();
    await expect(
      capturePreparedRuntime({
        sourcePath: value.source,
        snapshotParent: value.snapshots,
        hostProtection: protection as ReturnType<typeof hostProtection>,
        bootstrapApproval: value.approval,
      }),
    ).rejects.toMatchObject({ code: "runtime-invalid-source" });
    expect(await readdir(value.snapshots)).toEqual([]);
  });

  it("rejects a snapshot parent below a writable non-sticky ancestor", async () => {
    const value = await fixture();
    const unsafeAncestor = join(value.root, "unsafe-state");
    const unsafeParent = join(unsafeAncestor, "snapshots");
    await mkdir(unsafeParent, { recursive: true });
    await chmod(unsafeAncestor, 0o777);
    await chmod(unsafeParent, 0o700);
    await expect(
      capturePreparedRuntime({
        sourcePath: value.source,
        snapshotParent: unsafeParent,
        hostProtection: hostProtection(value),
        bootstrapApproval: value.approval,
      }),
    ).rejects.toMatchObject({ code: "runtime-invalid-source" });
  });
});

async function digest(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function makeDirectoriesWritable(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => undefined);
  if (stat === undefined || !stat.isDirectory()) return;
  await chmod(path, 0o700);
  for (const name of await readdir(path)) await makeDirectoriesWritable(join(path, name));
}
