/** Empty immutable workspaces and exact bootstrap bytes for controller operations (#115 §3). */
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  assertPrivateAdmissionDirectory,
  syncAdmissionDirectoryChain,
} from "../execution/sandbox/admission-metadata.js";
import { withSandboxDirectory } from "../execution/sandbox/anchored-file-access.js";
import { BUBBLEWRAP_BOOTSTRAP_SOURCE } from "../execution/sandbox/bootstrap.js";
import type { SandboxWritableMount } from "../execution/sandbox/mount-plan.js";
import { canonicalTrustedSnapshotParent } from "../execution/sandbox/runtime-capture.js";

/** Host-owned mounts. Private staging is the only optional writable workspace overlay. */
export interface ControllerInvocationFiles {
  readonly readonlyWorkspaceRoot: string;
  readonly privateWritableRoot: string;
  readonly bootstrapPath: string;
  readonly writableMounts: readonly SandboxWritableMount[];
  /** Host-verified immutable mounts for source-aware fixed adapters. */
  readonly readonlyInputs: readonly {
    readonly sourcePath: string;
    readonly destination: "/inputs" | "/source-git";
  }[];
  /** Bounded ephemeral filesystem quota requested by a source-aware adapter. */
  readonly scratchBytes?: number;
  verify(): Promise<void>;
}

/** Call only after durable executable start. Failed preparation is retained with the run. */
export async function prepareControllerInvocationFiles(
  runStateDir: string,
  assertOpen: () => void,
  stagingRoot?: string,
  source?: {
    readonly workspaceRoot: string;
    readonly readonlyInputs: readonly {
      readonly sourcePath: string;
      readonly destination: "/inputs" | "/source-git";
    }[];
    readonly scratchBytes: number;
  },
): Promise<ControllerInvocationFiles> {
  assertOpen();
  const state = await canonicalTrustedSnapshotParent(runStateDir);
  const root = join(state, "controller-invocations");
  try {
    await mkdir(root, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  await assertPrivateAdmissionDirectory(root);
  const invocation = await mkdtemp(join(root, "operation-"));
  const base = join(invocation, "base");
  const writable = stagingRoot ?? join(invocation, "writable");
  const bootstrap = join(invocation, "bootstrap.sh");
  await mkdir(base, { mode: 0o700 });
  if (stagingRoot === undefined) await mkdir(writable, { mode: 0o700 });
  else {
    await canonicalTrustedSnapshotParent(stagingRoot);
    await assertPrivateAdmissionDirectory(stagingRoot);
    await assertPrivateAdmissionDirectory(join(stagingRoot, "output"));
    await mkdir(join(base, "output"), { mode: 0o500 });
  }
  const file = await open(
    bootstrap,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o400,
  );
  try {
    await file.writeFile(BUBBLEWRAP_BOOTSTRAP_SOURCE);
    await file.sync();
  } finally {
    await file.close();
  }
  await chmod(base, 0o500);
  await syncAdmissionDirectoryChain(base, invocation, root, state);
  const baseIdentity = await lstat(base);
  const bootstrapIdentity = await lstat(bootstrap);
  assertOpen();
  const verify = async () => {
    assertOpen();
    await canonicalTrustedSnapshotParent(invocation);
    const currentBase = await lstat(base);
    if (
      !currentBase.isDirectory() ||
      currentBase.ino !== baseIdentity.ino ||
      currentBase.dev !== baseIdentity.dev ||
      (currentBase.mode & 0o7777) !== 0o500
    )
      throw new Error("controller immutable workspace identity changed");
    const entries = await readdir(base);
    if (
      stagingRoot === undefined
        ? entries.length !== 0
        : entries.length !== 1 || entries[0] !== "output"
    )
      throw new Error("controller immutable workspace contains unexpected inputs");
    if (stagingRoot !== undefined) {
      await assertPrivateAdmissionDirectory(stagingRoot);
      await assertPrivateAdmissionDirectory(join(stagingRoot, "output"));
      const placeholder = await lstat(join(base, "output"));
      if (!placeholder.isDirectory() || (await readdir(join(base, "output"))).length !== 0)
        throw new Error("controller staging mount placeholder changed");
    }
    await withSandboxDirectory(invocation, async (files) => {
      const stat = await files.fileStat("bootstrap.sh");
      if (
        stat.ino !== bootstrapIdentity.ino ||
        stat.dev !== bootstrapIdentity.dev ||
        (stat.mode & 0o7777) !== 0o400 ||
        (await files.read("bootstrap.sh", 8192)).toString("utf8") !== BUBBLEWRAP_BOOTSTRAP_SOURCE
      )
        throw new Error("controller trusted bootstrap changed");
    });
    assertOpen();
  };
  return Object.freeze({
    // A source service has already opened this immutable checkout under its live authority.
    readonlyWorkspaceRoot: source?.workspaceRoot ?? base,
    privateWritableRoot: writable,
    bootstrapPath: bootstrap,
    writableMounts:
      stagingRoot === undefined ? [] : [{ path: "output", kind: "directory" as const }],
    readonlyInputs: source?.readonlyInputs ?? [],
    ...(source === undefined ? {} : { scratchBytes: source.scratchBytes }),
    verify,
  });
}
