/** Private no-follow metadata persistence helpers for Issue #106 §7. */

import { constants, type Stats } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { dirname } from "node:path";

import { syncAdmissionDirectoryChain } from "./admission-metadata.js";

const MAX_METADATA_BYTES = 64 * 1024;

/** Create and durably persist one bounded JSON metadata file. */
export async function writeOutputMetadata(path: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > MAX_METADATA_BYTES) throw new Error("sandbox output metadata is too large");
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await writeAll(file, bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await syncAdmissionDirectoryChain(dirname(path));
}

/** Read stable metadata from a descriptor-checked file. */
export async function readOutputMetadata(file: FileHandle): Promise<unknown> {
  const before = await file.stat();
  assertMetadata(before);
  const bytes = Buffer.alloc(before.size + 1);
  let offset = 0;
  while (offset < before.size) {
    const result = await file.read(bytes, offset, before.size - offset, offset);
    if (result.bytesRead === 0) throw new Error("sandbox output metadata changed during read");
    offset += result.bytesRead;
  }
  if (!same(before, await file.stat()))
    throw new Error("sandbox output metadata changed during read");
  try {
    return JSON.parse(bytes.subarray(0, offset).toString("utf8")) as unknown;
  } catch (cause) {
    throw new Error("sandbox output metadata is not valid JSON", { cause });
  }
}

function assertMetadata(stat: Stats): void {
  const owner = process.getuid?.();
  if (
    owner === undefined ||
    !stat.isFile() ||
    stat.uid !== owner ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size > MAX_METADATA_BYTES
  )
    throw new Error("sandbox output metadata file is unsafe");
}

async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await file.write(bytes, offset, bytes.length - offset, offset);
    if (result.bytesWritten === 0)
      throw new Error("sandbox output metadata write made no progress");
    offset += result.bytesWritten;
  }
}

function same(left: Stats, right: Stats): boolean {
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
