import { createHash } from "node:crypto";
import {
  chmod,
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

import { afterEach, describe, expect, it } from "vitest";

import {
  captureSandboxAdmission,
  encodeSandboxAdmissionMetadata,
  readSandboxAdmission,
} from "../../src/host/execution/sandbox/admission-store.js";
import { pinSandboxPolicy } from "../../src/host/execution/sandbox/policy-pin.js";
import type { HostApprovedBootstrapRuntime } from "../../src/host/execution/sandbox/runtime-types.js";

const cleanup: string[] = [];

afterEach(async () => {
  for (const root of cleanup.splice(0)) {
    await makeDirectoriesWritable(root);
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "conductor-admission-test-"));
  cleanup.push(root);
  const checkout = join(root, "checkout");
  const source = join(checkout, ".pi/runtime");
  const state = join(root, "state");
  const runStateDir = join(state, "run-1");
  await mkdir(join(source, "bin"), { recursive: true });
  await mkdir(join(source, "lib"));
  await mkdir(runStateDir, { recursive: true, mode: 0o700 });
  await chmod(state, 0o700);
  await chmod(runStateDir, 0o700);
  await writeFile(join(source, "bin/bash"), "approved bash\n", { mode: 0o700 });
  await writeFile(join(source, "lib/libc.so.6"), "approved libc\n", { mode: 0o600 });
  const bootstrapApproval: HostApprovedBootstrapRuntime = {
    approvalId: "approved-bootstrap-test",
    files: [
      { path: "bin/bash", sha256: await digest(join(source, "bin/bash")) },
      { path: "lib/libc.so.6", sha256: await digest(join(source, "lib/libc.so.6")) },
    ],
  };
  const policy = pinSandboxPolicy({
    execution: {
      backend: "bubblewrap",
      runtime_root: ".pi/runtime",
      writable_paths: ["src/a.ts"],
    },
    selectedPaths: ["src/a.ts"],
    trackedPaths: ["src/a.ts"],
  });
  return {
    root,
    checkout,
    source,
    state,
    runStateDir,
    bootstrapApproval,
    policy,
    hostProtection: {
      primaryCheckout: checkout,
      stateRoots: [state],
      childWorkspaceRoots: [] as string[],
    },
  };
}

describe("private sandbox admission store", () => {
  it("captures, fsyncs, and reopens one identity-bound admission", async () => {
    const value = await fixture();
    const record = await capture(value);
    const reopened = await readSandboxAdmission({
      runStateDir: value.runStateDir,
      expectedRunId: "run-1",
      expectedChildId: "child-1",
      expectedSandbox: record.sandbox,
      bootstrapApproval: value.bootstrapApproval,
    });
    expect(reopened).toEqual(record);
    expect(Object.isFrozen(reopened.policy.execution)).toBe(true);
    const artifact = join(value.runStateDir, "sandboxes", record.sandbox.materialization_id);
    expect((await lstat(artifact)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(artifact, "admission.json"))).mode & 0o777).toBe(0o600);
  });

  it("does not reread a substituted or removed source after acceptance", async () => {
    const value = await fixture();
    const record = await capture(value);
    await rm(value.source, { recursive: true, force: true });
    await mkdir(value.source, { recursive: true });
    await writeFile(join(value.source, "replacement"), "untrusted\n");
    await expect(
      readSandboxAdmission({
        runStateDir: value.runStateDir,
        expectedRunId: "run-1",
        expectedChildId: "child-1",
        expectedSandbox: record.sandbox,
        bootstrapApproval: value.bootstrapApproval,
      }),
    ).resolves.toMatchObject({ sandbox: record.sandbox });
  });

  it.each([
    ["run", { expectedRunId: "other-run", expectedChildId: "child-1" }],
    ["child", { expectedRunId: "run-1", expectedChildId: "other-child" }],
  ])("rejects a cross-%s admission reference", async (_name, expected) => {
    const value = await fixture();
    const record = await capture(value);
    await expect(
      readSandboxAdmission({
        runStateDir: value.runStateDir,
        ...expected,
        expectedSandbox: record.sandbox,
        bootstrapApproval: value.bootstrapApproval,
      }),
    ).rejects.toThrow("identity does not match");
  });

  it("rejects a traversal materialization ID before path lookup", async () => {
    const value = await fixture();
    await expect(
      readSandboxAdmission({
        runStateDir: value.runStateDir,
        expectedRunId: "run-1",
        expectedChildId: "child-1",
        expectedSandbox: {
          backend: "bubblewrap",
          execution_policy_digest: "0".repeat(64),
          runtime_digest: "1".repeat(64),
          materialization_id: "../../escape",
        },
        bootstrapApproval: value.bootstrapApproval,
      }),
    ).rejects.toThrow("expected sandbox descriptor is invalid");
  });

  it("rejects tampered admission digest metadata", async () => {
    const value = await fixture();
    const record = await capture(value);
    const metadata = metadataPath(value.runStateDir, record.sandbox.materialization_id);
    const parsed = JSON.parse(await readFile(metadata, "utf8")) as Record<string, unknown>;
    const sandbox = parsed.sandbox as Record<string, unknown>;
    sandbox.runtime_digest = "0".repeat(64);
    await writeFile(metadata, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
    await expect(reopen(value, record)).rejects.toThrow();
  });

  it.each(["deleted", "tampered"])("rejects a %s accepted snapshot", async (kind) => {
    const value = await fixture();
    const record = await capture(value);
    const bash = join(record.runtime.snapshotPath, "bin/bash");
    await chmod(record.runtime.snapshotPath, 0o700);
    await chmod(dirname(bash), 0o700);
    if (kind === "deleted") await rm(bash);
    else {
      await chmod(bash, 0o600);
      await writeFile(bash, "tampered\n");
      await chmod(bash, 0o500);
    }
    await chmod(dirname(bash), 0o500);
    await chmod(record.runtime.snapshotPath, 0o500);
    await expect(reopen(value, record)).rejects.toThrow();
  });

  it("rejects an existing symlinked sandbox store without chmodding its target", async () => {
    const value = await fixture();
    const target = join(value.root, "symlink-target");
    await mkdir(target, { mode: 0o777 });
    await chmod(target, 0o777);
    await symlink(target, join(value.runStateDir, "sandboxes"));
    await expect(capture(value)).rejects.toThrow();
    expect((await lstat(target)).mode & 0o777).toBe(0o777);
  });

  it("rejects a writable sandbox-store ancestor before opening metadata", async () => {
    const value = await fixture();
    const record = await capture(value);
    await chmod(join(value.runStateDir, "sandboxes"), 0o777);
    await expect(reopen(value, record)).rejects.toThrow("ancestor");
  });

  it("detects same-size metadata mutation after its no-follow descriptor opens", async () => {
    const value = await fixture();
    const record = await capture(value);
    const metadata = metadataPath(value.runStateDir, record.sandbox.materialization_id);
    const original = await readFile(metadata, "utf8");
    const changed = original.replace('"childId":"child-1"', '"childId":"child-2"');
    expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(original));
    await expect(
      readSandboxAdmission({
        runStateDir: value.runStateDir,
        expectedRunId: "run-1",
        expectedChildId: "child-1",
        expectedSandbox: record.sandbox,
        bootstrapApproval: value.bootstrapApproval,
        testHookAfterMetadataOpen: async () => {
          await writeFile(metadata, changed);
        },
      }),
    ).rejects.toThrow("changed during read");
  });

  it("rejects oversized metadata before creating a file", async () => {
    const value = await fixture();
    const record = await capture(value);
    const oversized = {
      ...record,
      childId: "x".repeat(8 * 1024 * 1024),
    } as typeof record;
    expect(() => encodeSandboxAdmissionMetadata(oversized)).toThrow("exceeds 8388608 bytes");
  });
});

async function capture(value: Awaited<ReturnType<typeof fixture>>) {
  return captureSandboxAdmission({
    runId: "run-1",
    childId: "child-1",
    manifestRoot: value.checkout,
    policy: value.policy,
    hostProtection: value.hostProtection,
    bootstrapApproval: value.bootstrapApproval,
    runStateDir: value.runStateDir,
  });
}

async function reopen(
  value: Awaited<ReturnType<typeof fixture>>,
  record: Awaited<ReturnType<typeof capture>>,
) {
  return readSandboxAdmission({
    runStateDir: value.runStateDir,
    expectedRunId: "run-1",
    expectedChildId: "child-1",
    expectedSandbox: record.sandbox,
    bootstrapApproval: value.bootstrapApproval,
  });
}

function metadataPath(runStateDir: string, materializationId: string): string {
  return join(runStateDir, "sandboxes", materializationId, "admission.json");
}

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
