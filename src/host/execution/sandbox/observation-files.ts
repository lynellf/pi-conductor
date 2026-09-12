/** Descriptor-anchored trusted-file observation for Issue #106 §5. */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, posix } from "node:path";

import { BubblewrapObservationError } from "./observation-error.js";
import { sameIdentity, validIdentity } from "./observation-support.js";
import type { BubblewrapAncestorDirectory, BubblewrapBinaryIdentity } from "./prerequisites.js";

/** Trusted regular-file facts collected with pre/post descriptor checks. */
export interface ObservedTrustedFile {
  readonly identity: BubblewrapBinaryIdentity;
  readonly sha256: string;
  readonly ancestors: readonly BubblewrapAncestorDirectory[];
}

/** File observation seam used to test ordering without machine-local binaries. */
export type BubblewrapFileObserver = (path: string, label: string) => Promise<ObservedTrustedFile>;

/** Canonical-path seam used only for deterministic boundary tests. */
export type CanonicalizePath = (path: string) => Promise<string>;

/** Require an already normalized absolute path with no symlink resolution. */
export async function canonicalAbsolutePath(
  path: string,
  label: string,
  canonicalizePath: CanonicalizePath = async (value) => realpath(value),
): Promise<string> {
  if (!posix.isAbsolute(path) || posix.normalize(path) !== path) {
    throw new BubblewrapObservationError(
      `${label} path must be absolute and canonical`,
      "bubblewrap-observation-invalid-path",
    );
  }
  try {
    const resolved = await canonicalizePath(path);
    if (resolved !== path) {
      throw new BubblewrapObservationError(
        `${label} path is not canonical`,
        "bubblewrap-observation-invalid-path",
      );
    }
    return resolved;
  } catch (cause) {
    if (cause instanceof BubblewrapObservationError) throw cause;
    throw new BubblewrapObservationError(
      `${label} path is unavailable`,
      "bubblewrap-observation-unavailable",
      { cause },
    );
  }
}

/** Inspect and hash one trusted regular file through a stable no-follow descriptor. */
export async function inspectTrustedFile(
  path: string,
  label: string,
): Promise<ObservedTrustedFile> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.uid !== 0 || (before.mode & 0o022) !== 0) {
      throw new BubblewrapObservationError(
        `${label} is not a root-owned non-writable regular file`,
        "bubblewrap-observation-unsafe-file",
      );
    }
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    const identity = fileIdentity(opened);
    if (!validIdentity(identity)) {
      throw new BubblewrapObservationError(
        "file identity is invalid",
        "bubblewrap-observation-invalid-path",
      );
    }
    if (!sameIdentity(identity, fileIdentity(before))) throw mutated(label);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const read = await handle.read(buffer, 0, buffer.length, position);
      if (read.bytesRead === 0) break;
      hash.update(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
    const after = await handle.stat();
    const afterPath = await lstat(path);
    if (
      !sameIdentity(identity, fileIdentity(after)) ||
      !sameIdentity(identity, fileIdentity(afterPath))
    ) {
      throw mutated(label);
    }
    return { identity, sha256: hash.digest("hex"), ancestors: await trustedAncestors(path) };
  } catch (cause) {
    if (cause instanceof BubblewrapObservationError) throw cause;
    throw new BubblewrapObservationError(
      `${label} could not be observed`,
      "bubblewrap-observation-unavailable",
      { cause },
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function trustedAncestors(path: string): Promise<readonly BubblewrapAncestorDirectory[]> {
  const paths: string[] = [];
  let current = dirname(path);
  while (true) {
    paths.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const entries: BubblewrapAncestorDirectory[] = [];
  for (const ancestor of paths.reverse()) {
    const stat = await lstat(ancestor);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
      throw new BubblewrapObservationError(
        `Bubblewrap ancestor '${ancestor}' is unsafe`,
        "bubblewrap-observation-unsafe-file",
      );
    }
    entries.push({ path: ancestor, isDirectory: true, uid: stat.uid, mode: stat.mode });
  }
  return entries;
}

function fileIdentity(stat: {
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

function mutated(label: string): BubblewrapObservationError {
  return new BubblewrapObservationError(
    `${label} changed during observation`,
    "bubblewrap-observation-mutated",
  );
}
