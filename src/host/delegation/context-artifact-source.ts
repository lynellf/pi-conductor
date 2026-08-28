/** Safe immutable parent-file capture for Issue #60 context artifacts. */

import { execFile } from "node:child_process";
import { constants, lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";

import {
  type ContextArtifactResolutionError,
  contextArtifactDigest,
  contextArtifactError,
  oversizedContextArtifact,
  type ResolveContextArtifactBatchOptions,
  type ResolvedContextArtifact,
} from "./context-artifact-contract.js";

const execFileAsync = promisify(execFile);

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

/** Source identity retained only until the batch's final pre-spawn check. */
export interface ContextArtifactFileCapture {
  readonly taskId: string;
  readonly artifactId: string;
  readonly safePath: string;
  readonly lexicalPath: string;
  readonly realPath: string;
  readonly identity: FileIdentity;
}

/** Resolve one safe H-authorized descriptor from B:path without using working-tree bytes. */
export async function resolveFileContextArtifact(
  options: ResolveContextArtifactBatchOptions,
  canonicalRoot: string,
  taskId: string,
  artifactId: string,
  safePath: string,
): Promise<
  | {
      readonly artifact: ResolvedContextArtifact;
      readonly capture: ContextArtifactFileCapture;
    }
  | {
      readonly error: ContextArtifactResolutionError;
      readonly oversizedByteLength?: number;
    }
> {
  const lexicalPath = join(canonicalRoot, ...safePath.split("/"));
  const walked = await walkRegularSource(canonicalRoot, safePath, taskId, artifactId);
  if ("code" in walked) return { error: walked };
  await options.testHook?.("after-source-lstat");

  let sourceRealPath: string;
  try {
    sourceRealPath = await realpath(lexicalPath);
  } catch (cause) {
    return { error: filesystemError(cause, taskId, artifactId, safePath) };
  }
  if (!isBeneath(canonicalRoot, sourceRealPath)) {
    return {
      error: contextArtifactError("context-artifact-realpath-escape", taskId, artifactId, safePath),
    };
  }

  const identity = await openIdentity(lexicalPath, taskId, artifactId, safePath);
  if ("code" in identity) return { error: identity };
  const blob = await readPinnedBlob(
    options.primaryCheckout,
    options.baseCommit,
    safePath,
    taskId,
    artifactId,
    options.limits.max_item_utf8_bytes,
  );
  if (!blob.valid) return blob;

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(blob.bytes);
  } catch {
    return {
      error: contextArtifactError("context-artifact-invalid-utf8", taskId, artifactId, safePath),
    };
  }
  const encoded = new TextEncoder().encode(text);
  if (!Buffer.from(encoded).equals(blob.bytes)) {
    return {
      error: contextArtifactError("context-artifact-invalid-utf8", taskId, artifactId, safePath),
    };
  }
  return {
    artifact: Object.freeze({
      id: artifactId,
      source: "file",
      provenance: Object.freeze({
        kind: "parent_materialized_file",
        path: safePath,
        base_commit: options.baseCommit,
      }),
      text,
      byte_length: blob.bytes.byteLength,
      sha256: contextArtifactDigest(blob.bytes),
    }),
    capture: Object.freeze({
      taskId,
      artifactId,
      safePath,
      lexicalPath,
      realPath: sourceRealPath,
      identity,
    }),
  };
}

/** Repeat lexical type, realpath, and identity checks after every source resolves. */
export async function fileCaptureChanged(
  capture: ContextArtifactFileCapture,
  canonicalRoot: string | null,
): Promise<boolean> {
  if (canonicalRoot === null) return true;
  try {
    const walked = await walkRegularSource(
      canonicalRoot,
      capture.safePath,
      capture.taskId,
      capture.artifactId,
    );
    if ("code" in walked) return true;
    const [currentRealPath, currentStats] = await Promise.all([
      realpath(capture.lexicalPath),
      lstat(capture.lexicalPath),
    ]);
    return (
      currentRealPath !== capture.realPath ||
      !sameIdentity(capture.identity, identityOf(currentStats))
    );
  } catch {
    return true;
  }
}

async function walkRegularSource(
  canonicalRoot: string,
  safePath: string,
  taskId: string,
  artifactId: string,
): Promise<{ readonly leafPath: string } | ContextArtifactResolutionError> {
  const parts = safePath.split("/");
  let current = canonicalRoot;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(current);
    } catch (cause) {
      return filesystemError(cause, taskId, artifactId, safePath);
    }
    if (stats.isSymbolicLink()) {
      return contextArtifactError("context-artifact-symlink", taskId, artifactId, safePath);
    }
    const leaf = index === parts.length - 1;
    if ((!leaf && !stats.isDirectory()) || (leaf && !stats.isFile())) {
      return contextArtifactError(
        "context-artifact-not-regular-file",
        taskId,
        artifactId,
        safePath,
      );
    }
  }
  return { leafPath: current };
}

async function openIdentity(
  path: string,
  taskId: string,
  artifactId: string,
  safePath: string,
): Promise<FileIdentity | ContextArtifactResolutionError> {
  if (typeof constants.O_NOFOLLOW !== "number") {
    return contextArtifactError("context-artifact-unreadable", taskId, artifactId, safePath);
  }
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        return contextArtifactError(
          "context-artifact-not-regular-file",
          taskId,
          artifactId,
          safePath,
        );
      }
      return identityOf(stats);
    } finally {
      await handle.close();
    }
  } catch (cause) {
    if (nodeCode(cause) === "ELOOP") {
      return contextArtifactError("context-artifact-changed", taskId, artifactId, safePath);
    }
    return filesystemError(cause, taskId, artifactId, safePath);
  }
}

async function readPinnedBlob(
  cwd: string,
  baseCommit: string,
  safePath: string,
  taskId: string,
  artifactId: string,
  itemLimit: number,
): Promise<
  | { readonly valid: true; readonly bytes: Buffer }
  | {
      readonly valid: false;
      readonly error: ContextArtifactResolutionError;
      readonly oversizedByteLength?: number;
    }
> {
  const object = `${baseCommit}:${safePath}`;
  const localOnlyEnvironment = { ...process.env, GIT_NO_LAZY_FETCH: "1" };
  try {
    const type = (
      await execFileAsync("git", ["cat-file", "-t", object], {
        cwd,
        env: localOnlyEnvironment,
      })
    ).stdout.trim();
    if (type !== "blob") {
      return {
        valid: false,
        error: contextArtifactError("context-artifact-unreadable", taskId, artifactId, safePath),
      };
    }
    const sizeText = (
      await execFileAsync("git", ["cat-file", "-s", object], {
        cwd,
        env: localOnlyEnvironment,
      })
    ).stdout.trim();
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0) {
      return {
        valid: false,
        error: contextArtifactError("context-artifact-unreadable", taskId, artifactId, safePath),
      };
    }
    if (size > itemLimit) {
      return {
        valid: false,
        error: oversizedContextArtifact(taskId, artifactId, safePath, size, itemLimit),
        oversizedByteLength: size,
      };
    }
    const result = await execFileAsync("git", ["cat-file", "blob", object], {
      cwd,
      env: localOnlyEnvironment,
      encoding: "buffer",
      maxBuffer: itemLimit + 1,
    });
    const bytes = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
    if (bytes.byteLength !== size) {
      return {
        valid: false,
        error: contextArtifactError("context-artifact-unreadable", taskId, artifactId, safePath),
      };
    }
    return { valid: true, bytes };
  } catch {
    return {
      valid: false,
      error: contextArtifactError("context-artifact-unreadable", taskId, artifactId, safePath),
    };
  }
}

function identityOf(stats: {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}): FileIdentity {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  });
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function isBeneath(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path.length > 0 && !path.startsWith("..") && !isAbsolute(path);
}

function filesystemError(
  cause: unknown,
  taskId: string,
  artifactId: string,
  path: string,
): ContextArtifactResolutionError {
  return contextArtifactError(
    nodeCode(cause) === "ENOENT" ? "context-artifact-missing" : "context-artifact-unreadable",
    taskId,
    artifactId,
    path,
  );
}

function nodeCode(cause: unknown): string | undefined {
  return cause !== null && typeof cause === "object" && "code" in cause
    ? String((cause as { readonly code?: unknown }).code)
    : undefined;
}
