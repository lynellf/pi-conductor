/** Private immutable controller runtimes, shared across invocations (#115 §§2, 6). */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { PreparedRuntimeDescriptor } from "../../persistence/sandbox-runtime.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import {
  assertPrivateAdmissionDirectory,
  syncAdmissionDirectoryChain,
} from "../execution/sandbox/admission-metadata.js";
import { withSandboxDirectory } from "../execution/sandbox/anchored-file-access.js";
import {
  canonicalTrustedSnapshotParent,
  capturePreparedRuntime,
} from "../execution/sandbox/runtime-capture.js";
import { syncRuntimeTree } from "../execution/sandbox/runtime-files.js";
import type { RuntimeHostProtection } from "../execution/sandbox/runtime-types.js";
import { verifyPreparedRuntimeSnapshot } from "../execution/sandbox/runtime-verify.js";
import type { ApprovedControllerDefinition } from "./approved-definition.js";

/** Host-only inputs; the caller persists execution start before calling capture. */
export interface ControllerRuntimeStoreOptions {
  readonly runStateDir: string;
  readonly definition: ApprovedControllerDefinition;
  readonly protection: RuntimeHostProtection;
  /** Re-check active epoch/revocation at each publish boundary. */
  readonly assertOpen: () => void;
}

/** Snapshot retrieval never substitutes a new runtime for an existing metadata binding. */
export class ControllerRuntimeStore {
  private readonly pending = new Map<string, Promise<PreparedRuntimeDescriptor>>();
  constructor(private readonly options: ControllerRuntimeStoreOptions) {}

  /** Capture once under an already-durable preparation operation, or verify the pinned snapshot. */
  prepare(runtimeId: string, assertCaptureOpen?: () => void): Promise<PreparedRuntimeDescriptor> {
    const assertOpen = () => {
      this.options.assertOpen();
      assertCaptureOpen?.();
    };
    const known = this.pending.get(runtimeId);
    if (known !== undefined)
      return known.then((value) => {
        assertOpen();
        return value;
      });
    const work = this.prepareOne(runtimeId, assertOpen);
    this.pending.set(runtimeId, work);
    return work;
  }

  /** Verify full immutable contents immediately before every execution. */
  async verify(
    runtimeId: string,
    value: PreparedRuntimeDescriptor,
  ): Promise<PreparedRuntimeDescriptor> {
    this.options.assertOpen();
    const runtime = this.registration(runtimeId);
    const verified = await verifyPreparedRuntimeSnapshot(value, {
      snapshotParent: await this.directory(runtimeId),
      bootstrapApproval: runtime.bootstrap_approval,
    });
    if (
      verified.inventoryDigest !== runtime.inventory_sha256 ||
      verified.canonicalSourcePath !== runtime.source_root
    )
      throw new Error("controller runtime inventory differs from pinned approval");
    this.options.assertOpen();
    return verified;
  }

  private registration(runtimeId: string) {
    const { config, approval } = this.options.definition;
    if (
      runtimeId !== config.runtime_id &&
      !config.adapters.some((entry) => entry.runtime_id === runtimeId)
    )
      throw new Error("controller runtime is outside the pinned definition");
    const runtime = approval.runtimes.find((entry) => entry.runtime_id === runtimeId);
    if (runtime === undefined) throw new Error("controller runtime registration is missing");
    return runtime;
  }

  private async directory(runtimeId: string): Promise<string> {
    const state = await canonicalTrustedSnapshotParent(this.options.runStateDir);
    const root = join(state, "controller-runtimes");
    await privateDirectory(root);
    const directory = join(
      root,
      sha256Canonical({
        run_id: this.options.definition.record.run_id,
        definition_digest: this.options.definition.record.definition_digest,
        runtime_id: runtimeId,
      }),
    );
    await privateDirectory(directory);
    await syncAdmissionDirectoryChain(directory, root, state);
    return directory;
  }

  private async prepareOne(
    runtimeId: string,
    assertOpen: () => void,
  ): Promise<PreparedRuntimeDescriptor> {
    assertOpen();
    const runtime = this.registration(runtimeId);
    const directory = await this.directory(runtimeId);
    const binding = {
      run_id: this.options.definition.record.run_id,
      definition_digest: this.options.definition.record.definition_digest,
      runtime_id: runtimeId,
    };
    let prior: unknown;
    try {
      prior = await withSandboxDirectory(directory, async (files) => {
        const stat = await files.fileStat("snapshot.json");
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.uid !== process.getuid?.() ||
          (stat.mode & 0o7777) !== 0o600
        )
          throw new Error("controller runtime metadata is not private");
        return JSON.parse(
          (await files.read("snapshot.json", 1024 * 1024)).toString("utf8"),
        ) as unknown;
      });
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
    }
    if (prior !== undefined) {
      if (
        prior === null ||
        typeof prior !== "object" ||
        !("binding" in prior) ||
        !("snapshot" in prior) ||
        sha256Canonical(prior.binding) !== sha256Canonical(binding)
      )
        throw new Error("controller runtime metadata binding differs from pinned authority");
      const snapshot = await verifyPreparedRuntimeSnapshot(prior.snapshot, {
        snapshotParent: directory,
        bootstrapApproval: runtime.bootstrap_approval,
      });
      return this.verify(runtimeId, snapshot);
    }
    assertOpen();
    const snapshot = await capturePreparedRuntime({
      sourcePath: runtime.source_root,
      snapshotParent: directory,
      hostProtection: this.options.protection,
      bootstrapApproval: runtime.bootstrap_approval,
    });
    await this.verify(runtimeId, snapshot);
    await syncRuntimeTree(snapshot.snapshotPath);
    assertOpen();
    const bytes = Buffer.from(`${JSON.stringify({ binding, snapshot })}\n`);
    if (bytes.length > 1024 * 1024) throw new Error("controller runtime metadata exceeds limit");
    const temporary = join(directory, `snapshot-${randomUUID()}.tmp`);
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    assertOpen();
    // A competing store can never replace an already published snapshot. A crash
    // before unlink retains an unsafe link count and therefore blocks resume.
    await link(temporary, join(directory, "snapshot.json"));
    await unlink(temporary);
    await syncAdmissionDirectoryChain(directory);
    return snapshot;
  }
}

async function privateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
  }
  await assertPrivateAdmissionDirectory(path);
}
