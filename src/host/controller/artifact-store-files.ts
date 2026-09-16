/** Descriptor-confined artifact storage file operations — issue #115 §6. */

import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative } from "node:path";

import { withSandboxDirectory } from "../execution/sandbox/anchored-file-access.js";
import {
  type ArtifactManifest,
  ArtifactStoreError,
  assertArtifactManifest,
} from "./artifact-store-contract.js";

/** Identity retained across a publication's final staging check. */
export interface ArtifactFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

/** Read a no-follow, singly-linked bounded payload through an anchored directory descriptor. */
export async function readArtifactPayload(
  path: string,
  maxBytes: number,
): Promise<{ readonly bytes: Buffer; readonly identity: ArtifactFileIdentity }> {
  let observed: Awaited<ReturnType<typeof lstat>>;
  try {
    observed = await lstat(path);
  } catch (cause) {
    throw artifactFileError(cause);
  }
  if (observed.isSymbolicLink()) throw new ArtifactStoreError("artifact-symlink");
  if (!observed.isFile()) throw new ArtifactStoreError("artifact-not-regular-file");
  if (observed.nlink !== 1) throw new ArtifactStoreError("artifact-hardlink");
  if (observed.size > maxBytes) throw new ArtifactStoreError("artifact-oversized");
  try {
    return await withSandboxDirectory(dirname(path), async (files) => {
      const before = await files.fileStat(basename(path));
      const bytes = await files.read(basename(path), maxBytes);
      const after = await files.fileStat(basename(path));
      if (!sameIdentity(identityOf(before), identityOf(after)) || bytes.byteLength !== before.size)
        throw new ArtifactStoreError("artifact-corrupt");
      return { bytes, identity: identityOf(after) };
    });
  } catch (cause) {
    if (cause instanceof ArtifactStoreError) throw cause;
    throw new ArtifactStoreError("artifact-storage-failure");
  }
}

/** Recheck a staged payload identity before rename without following a replacement link. */
export async function assertSameArtifactPayload(
  path: string,
  expected: ArtifactFileIdentity,
): Promise<void> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch (cause) {
    throw artifactFileError(cause);
  }
  if (stat.isSymbolicLink()) throw new ArtifactStoreError("artifact-symlink");
  if (!stat.isFile()) throw new ArtifactStoreError("artifact-not-regular-file");
  if (stat.nlink !== 1) throw new ArtifactStoreError("artifact-hardlink");
  if (!sameIdentity(expected, identityOf(stat))) throw new ArtifactStoreError("artifact-corrupt");
}

/** Parse and verify a bounded manifest file. */
export async function readArtifactManifest(path: string): Promise<ArtifactManifest> {
  let source: string;
  try {
    source = (await readArtifactPayload(path, 64 * 1024)).bytes.toString("utf8");
  } catch (cause) {
    if (cause instanceof ArtifactStoreError && cause.code === "artifact-missing") throw cause;
    throw new ArtifactStoreError("artifact-corrupt");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(source);
  } catch {
    throw new ArtifactStoreError("artifact-corrupt");
  }
  assertArtifactManifest(manifest);
  return manifest;
}

/** Ensure an existing literal directory has no symlink leaf. */
export async function assertArtifactDirectory(
  path: string,
  code: ArtifactStoreError["code"],
): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ArtifactStoreError(code);
}

/** Verify that canonical published entries remain host-owned and immutable by mode. */
export async function assertImmutableArtifactDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  const owner = process.getuid?.();
  if (
    owner === undefined ||
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.uid !== owner ||
    (stat.mode & 0o777) !== 0o500
  )
    throw new ArtifactStoreError("artifact-corrupt");
}

/** Verify a host-private mutable container on the path to sealed artifact content. */
export async function assertPrivateArtifactDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  const owner = process.getuid?.();
  if (
    owner === undefined ||
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.uid !== owner ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new ArtifactStoreError("artifact-corrupt");
}

/** Verify that a canonical payload or manifest remains a singly-linked readonly host file. */
export async function assertImmutableArtifactFile(path: string): Promise<void> {
  const stat = await lstat(path);
  const owner = process.getuid?.();
  if (
    owner === undefined ||
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.uid !== owner ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o400
  )
    throw new ArtifactStoreError("artifact-corrupt");
}

/** Require that a canonical descendant remains inside its private storage root. */
export async function assertArtifactDirectoryBeneath(
  root: string,
  path: string,
  code: ArtifactStoreError["code"],
): Promise<void> {
  const canonical = await realpath(path).catch(() => undefined);
  if (canonical === undefined || canonical !== path || !isBeneath(root, canonical))
    throw new ArtifactStoreError(code);
  await assertArtifactDirectory(canonical, code);
}

/** Persist one regular file's contents before the containing directory is fsynced. */
export async function syncArtifactFile(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Persist a directory entry update such as manifest creation or atomic rename. */
export async function syncArtifactDirectory(path: string): Promise<void> {
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

/** Whether a filesystem failure reports a missing entry. */
export function isArtifactMissing(cause: unknown): boolean {
  return nodeCode(cause) === "ENOENT";
}

/** Whether a same-filesystem directory rename lost a deterministic destination race. */
export function isArtifactDestinationExists(cause: unknown): boolean {
  return nodeCode(cause) === "EEXIST" || nodeCode(cause) === "ENOTEMPTY";
}

function identityOf(stat: {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}): ArtifactFileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

function sameIdentity(left: ArtifactFileIdentity, right: ArtifactFileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function artifactFileError(cause: unknown): ArtifactStoreError {
  const code = nodeCode(cause);
  if (code === "ENOENT") return new ArtifactStoreError("artifact-missing");
  if (code === "ELOOP") return new ArtifactStoreError("artifact-symlink");
  return new ArtifactStoreError("artifact-storage-failure");
}

function nodeCode(cause: unknown): string | undefined {
  return cause !== null && typeof cause === "object" && "code" in cause
    ? String((cause as { readonly code?: unknown }).code)
    : undefined;
}

function isBeneath(root: string, path: string): boolean {
  const value = relative(root, path);
  return value.length > 0 && !value.startsWith("..") && !isAbsolute(value);
}
