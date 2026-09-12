/** No-follow bounded metadata persistence for Issue #106 §3. */

import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname } from "node:path";

import type { SandboxAdmissionRecord } from "../../../persistence/sandbox-admission.js";
import { SandboxAdmissionStoreError } from "./admission-error.js";

const MAX_ADMISSION_BYTES = 8 * 1024 * 1024;

/** Serialize bounded metadata before an admission file can be created. */
export function encodeSandboxAdmissionMetadata(value: SandboxAdmissionRecord): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.length > MAX_ADMISSION_BYTES) {
    throw new SandboxAdmissionStoreError(
      `sandbox admission metadata exceeds ${MAX_ADMISSION_BYTES} bytes`,
    );
  }
  return bytes;
}

/** Create, fsync, and publish one private admission metadata file. */
export async function writeDurableAdmissionMetadata(
  path: string,
  value: SandboxAdmissionRecord,
): Promise<void> {
  const bytes = encodeSandboxAdmissionMetadata(value);
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncAdmissionDirectoryChain(dirname(path));
}

/** Read one bounded private metadata file while rejecting replacement and mutation. */
export async function readAdmissionMetadata(
  path: string,
  testHookAfterOpen?: () => Promise<void>,
): Promise<unknown> {
  const before = await lstat(path);
  const owner = process.getuid?.();
  if (
    owner === undefined ||
    !before.isFile() ||
    before.uid !== owner ||
    before.nlink !== 1 ||
    (before.mode & 0o777) !== 0o600 ||
    before.size > MAX_ADMISSION_BYTES
  ) {
    throw new SandboxAdmissionStoreError("sandbox admission metadata file is unsafe");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!sameMetadataIdentity(before, opened)) {
      throw new SandboxAdmissionStoreError("sandbox admission metadata changed before open");
    }
    await testHookAfterOpen?.();
    const bytes = Buffer.alloc(opened.size + 1);
    let position = 0;
    while (position < bytes.length) {
      const read = await handle.read(bytes, position, bytes.length - position, position);
      if (read.bytesRead === 0) break;
      position += read.bytesRead;
    }
    const after = await handle.stat();
    if (!sameMetadataIdentity(opened, after) || position !== opened.size) {
      throw new SandboxAdmissionStoreError("sandbox admission metadata changed during read");
    }
    try {
      return JSON.parse(bytes.subarray(0, position).toString("utf8")) as unknown;
    } catch (cause) {
      throw new SandboxAdmissionStoreError("sandbox admission metadata is not JSON", undefined, {
        cause,
      });
    }
  } finally {
    await handle.close();
  }
}

/** Fsync private admission directories in child-to-parent creation order. */
export async function syncAdmissionDirectoryChain(...paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

/** Require an exact canonical owner-private admission directory. */
export async function assertPrivateAdmissionDirectory(path: string): Promise<void> {
  const canonical = await realpath(path).catch(() => undefined);
  const stat = await lstat(path).catch(() => undefined);
  const owner = process.getuid?.();
  if (
    canonical !== path ||
    stat === undefined ||
    !stat.isDirectory() ||
    owner === undefined ||
    stat.uid !== owner ||
    (stat.mode & 0o777) !== 0o700
  ) {
    throw new SandboxAdmissionStoreError("sandbox admission directory is unsafe");
  }
}

function sameMetadataIdentity(left: MetadataIdentity, right: MetadataIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

interface MetadataIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly nlink: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}
