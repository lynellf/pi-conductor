/** Owner-authorized bounded reads of retained sandbox output (#106 §7). */

import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "typebox/value";
import {
  type SandboxOutputAttribution,
  type SandboxOutputFinalRecord,
  sandboxOutputAttributionSchema,
  sandboxOutputFinalRecordSchema,
} from "../../../persistence/sandbox-output.js";
import { assertPrivateAdmissionDirectory } from "./admission-metadata.js";
import { checkedFile, DIRECTORY, descend, READ, same } from "./anchored-file-handles.js";
import { readOutputMetadata } from "./output-metadata.js";
import { canonicalTrustedSnapshotParent } from "./runtime-capture.js";

const OUTPUT_REFERENCE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_CHUNK_BYTES = 64 * 1024;

/** Child identity and byte range used to authorize one opaque output reference. */
export interface ReadSandboxExecutionOutputOptions {
  readonly runStateDir: string;
  readonly expectedRunId: string;
  readonly expectedChildId: string;
  readonly expectedExecutionId?: string;
  readonly outputRef: string;
  readonly stream: "stdout" | "stderr";
  readonly offset: number;
  readonly maxBytes: number;
}

/** Verified byte range; EOF refers to retained bytes, with capture completeness explicit. */
export interface SandboxOutputChunk {
  readonly capture: "complete" | "incomplete";
  readonly retainedByteCount: number;
  readonly encoding: "utf8" | "base64";
  readonly data: string;
  readonly byteCount: number;
  readonly nextOffset: number;
  readonly eof: boolean;
}

/** Resolve an opaque reference through persisted ownership and return one verified bounded chunk. */
export async function readSandboxExecutionOutput(
  options: ReadSandboxExecutionOutputOptions,
): Promise<SandboxOutputChunk> {
  if (!OUTPUT_REFERENCE.test(options.outputRef))
    throw new Error("sandbox output reference is invalid");
  assertBound(options.offset, Number.MAX_SAFE_INTEGER, "output offset");
  assertBound(options.maxBytes, MAX_CHUNK_BYTES, "output read bound");
  const runState = await canonicalTrustedSnapshotParent(options.runStateDir);
  const rootPath = join(runState, "sandbox-output");
  await assertPrivateAdmissionDirectory(rootPath);
  const anchor = await open("/", DIRECTORY);
  let root: FileHandle | undefined;
  let directory: FileHandle | undefined;
  try {
    root = await descend(anchor, rootPath.slice(1).split("/"), false);
    assertPrivateDirectory(await root.stat(), "sandbox output root");
    directory = await descend(root, [options.outputRef], false);
    assertPrivateDirectory(await directory.stat(), "sandbox output reference");
    const attribution = await readTypedAttribution(directory);
    assertOwner(attribution, options);
    const final = await readTypedFinal(directory, options.outputRef);
    if (final.stdout.byteCount + final.stderr.byteCount > attribution.maxBytes)
      throw new Error("sandbox output settlement exceeds its attributed cap");
    const expected = final[options.stream];
    if (!expected.retainedVerified)
      throw new Error("sandbox output retained bytes are not verified");
    const file = await checkedFile(directory, `${options.stream}.bin`, READ);
    try {
      return {
        ...(await verifyAndRead(file, expected, options.offset, options.maxBytes)),
        capture: final.capture,
        retainedByteCount: expected.byteCount,
      };
    } finally {
      await file.close();
    }
  } finally {
    await directory?.close();
    await root?.close();
    await anchor.close();
  }
}

async function readTypedAttribution(directory: FileHandle): Promise<SandboxOutputAttribution> {
  const file = await checkedFile(directory, "attribution.json", READ);
  try {
    const value = await readOutputMetadata(file);
    if (!Value.Check(sandboxOutputAttributionSchema, value))
      throw new Error("sandbox output attribution is corrupt");
    return value;
  } finally {
    await file.close();
  }
}

async function readTypedFinal(
  directory: FileHandle,
  outputRef: string,
): Promise<SandboxOutputFinalRecord> {
  const file = await checkedFile(directory, "final.json", READ);
  try {
    const value = await readOutputMetadata(file);
    if (!Value.Check(sandboxOutputFinalRecordSchema, value) || value.outputRef !== outputRef)
      throw new Error("sandbox output settlement is corrupt");
    return value;
  } finally {
    await file.close();
  }
}

function assertOwner(
  attribution: SandboxOutputAttribution,
  options: ReadSandboxExecutionOutputOptions,
): void {
  if (
    attribution.outputRef !== options.outputRef ||
    attribution.runId !== options.expectedRunId ||
    attribution.childId !== options.expectedChildId ||
    (options.expectedExecutionId !== undefined &&
      attribution.executionId !== options.expectedExecutionId)
  )
    throw new Error("sandbox output attribution does not match the requesting child execution");
}

async function verifyAndRead(
  file: FileHandle,
  expected: { readonly byteCount: number; readonly sha256: string },
  offset: number,
  maxBytes: number,
): Promise<Omit<SandboxOutputChunk, "capture" | "retainedByteCount">> {
  const before = await file.stat();
  assertRetainedFile(before, expected.byteCount);
  const hash = createHash("sha256");
  const scratch = Buffer.allocUnsafe(MAX_CHUNK_BYTES);
  const wanted = Math.min(maxBytes, Math.max(0, expected.byteCount - offset));
  const result = Buffer.alloc(wanted);
  let position = 0;
  let copied = 0;
  while (position < expected.byteCount) {
    const length = Math.min(scratch.length, expected.byteCount - position);
    const read = await file.read(scratch, 0, length, position);
    if (read.bytesRead === 0) throw new Error("sandbox output changed during verification");
    const bytes = scratch.subarray(0, read.bytesRead);
    hash.update(bytes);
    const overlapStart = Math.max(position, offset);
    const overlapEnd = Math.min(position + read.bytesRead, offset + wanted);
    if (overlapEnd > overlapStart) {
      const sourceStart = overlapStart - position;
      bytes.copy(result, copied, sourceStart, sourceStart + overlapEnd - overlapStart);
      copied += overlapEnd - overlapStart;
    }
    position += read.bytesRead;
  }
  if (!same(before, await file.stat()))
    throw new Error("sandbox output changed during verification");
  if (hash.digest("hex") !== expected.sha256)
    throw new Error("sandbox output digest does not match metadata");
  const encoded = encodeBytes(result);
  return {
    ...encoded,
    byteCount: result.length,
    nextOffset: offset + result.length,
    eof: offset + result.length >= expected.byteCount,
  };
}

function assertRetainedFile(stat: Stats, expectedBytes: number): void {
  const owner = process.getuid?.();
  if (
    owner === undefined ||
    !stat.isFile() ||
    stat.uid !== owner ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size !== expectedBytes
  )
    throw new Error("sandbox output retained file is unsafe or has an unexpected size");
}

function assertPrivateDirectory(stat: Stats, label: string): void {
  const owner = process.getuid?.();
  if (
    owner === undefined ||
    !stat.isDirectory() ||
    stat.uid !== owner ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error(`${label} is unsafe`);
}

function encodeBytes(bytes: Buffer): {
  readonly encoding: "utf8" | "base64";
  readonly data: string;
} {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes)
    ? { encoding: "utf8", data: text }
    : { encoding: "base64", data: bytes.toString("base64") };
}

function assertBound(value: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new Error(`${label} is invalid`);
}
