/**
 * Accepted-handoff artifact routing — Issue #48 R4.a.
 *
 * The host alone copies already-collected declared artifacts. An isolated
 * receiver gets workspace-relative copies beneath `artifacts/<role>-v<visit>/`;
 * a shared receiver gets the absolute host-store paths in its seed. Auto-patches
 * are deliberately excluded from both paths.
 */

import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { ArtifactCollectedRecord, ArtifactRejectedRecord } from "../../persistence/log.js";

/** A host-routed artifact with its receiver-visible seed path. */
export interface RoutedArtifact {
  readonly name: string;
  readonly description?: string;
  /** Absolute local path: receiver workspace for isolated roles, store for shared roles. */
  readonly localPath: string;
  /** Path that the receiver can pass to its tools. */
  readonly seedPath: string;
}

type ArtifactRoutingErrorCode =
  | "stored_artifact_missing"
  | "stored_artifact_escape"
  | "receiver_workspace_escape"
  | "destination_conflict"
  | "copy_failed";

/** Typed failure when a collected artifact cannot be safely routed. */
export class ArtifactRoutingError extends Error {
  readonly code: ArtifactRoutingErrorCode;

  constructor(code: ArtifactRoutingErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ArtifactRoutingError";
    this.code = code;
  }
}

/**
 * Materialize host-collected declared artifacts for one accepted handoff.
 *
 * The supplied records, rather than a directory scan, are the authority. This
 * preserves nested paths and prevents an auto-patch or unrelated store file
 * from becoming receiver input.
 */
export async function materializeArtifacts(options: {
  readonly artifactsDir: string;
  readonly emittingRole: string;
  readonly emittingVisitIndex: number;
  readonly receiverWorkspace: string;
  readonly isReceiverIsolated: boolean;
  readonly collected: readonly ArtifactCollectedRecord[];
}): Promise<readonly RoutedArtifact[]> {
  const declared = options.collected.filter((record) => record.kind === "declared");
  if (declared.length === 0) return [];

  const sourceDirectory = resolve(
    options.artifactsDir,
    `${options.emittingRole}-v${options.emittingVisitIndex}`,
  );
  const sourceDirectoryReal = await resolveDirectory(sourceDirectory, "stored artifact directory");
  const receiverRoot = options.isReceiverIsolated
    ? await resolveDirectory(options.receiverWorkspace, "receiver workspace")
    : null;
  const routed: RoutedArtifact[] = [];
  const receiverPaths: string[] = [];

  try {
    for (const record of declared) {
      const sourcePath = await resolveStoredArtifact(record.stored_path, sourceDirectoryReal);
      if (receiverRoot === null) {
        routed.push({
          name: record.source_path,
          ...(record.description !== undefined && { description: record.description }),
          localPath: sourcePath,
          seedPath: sourcePath,
        });
        continue;
      }

      const storedRelativePath = relative(sourceDirectoryReal, sourcePath);
      const receiverPath = resolve(
        receiverRoot,
        "artifacts",
        `${options.emittingRole}-v${options.emittingVisitIndex}`,
        storedRelativePath,
      );
      await ensureReceiverDirectory(dirname(receiverPath), receiverRoot);
      const created = await copyStoredArtifact(sourcePath, receiverPath, receiverRoot);
      if (created) receiverPaths.push(receiverPath);
      const seedPath = relative(receiverRoot, receiverPath);
      if (!isStrictlyWithin(receiverPath, receiverRoot) || isOutsideRelativePath(seedPath)) {
        throw new ArtifactRoutingError(
          "receiver_workspace_escape",
          `artifact destination escapes receiver workspace: ${receiverPath}`,
        );
      }
      routed.push({
        name: record.source_path,
        ...(record.description !== undefined && { description: record.description }),
        localPath: receiverPath,
        seedPath,
      });
    }
  } catch (error) {
    try {
      await Promise.all(receiverPaths.map(async (path) => rm(path, { force: true })));
    } catch (cleanupError) {
      throw new ArtifactRoutingError(
        "copy_failed",
        "could not remove a partially materialized artifact",
        { cause: cleanupError },
      );
    }
    throw error;
  }

  return Object.freeze(routed);
}

/** Build the host-generated artifact section appended to the receiver seed. */
export function formatArtifactsSeedSection(options: {
  readonly emittingRole: string;
  readonly emittingVisitIndex: number;
  readonly routed: readonly RoutedArtifact[];
  readonly rejected: readonly ArtifactRejectedRecord[];
}): string | null {
  if (options.routed.length === 0 && options.rejected.length === 0) return null;

  const lines = [`## Artifacts from ${options.emittingRole}-v${options.emittingVisitIndex}`];
  if (options.routed.length > 0) {
    lines.push("", "Available:");
    for (const artifact of options.routed) {
      lines.push(
        `  - ${artifact.name}${artifact.description === undefined ? "" : ` (${artifact.description})`}`,
        `    Path: ${artifact.seedPath}`,
      );
    }
  }
  if (options.rejected.length > 0) {
    lines.push("", "Not available:");
    for (const artifact of options.rejected) {
      lines.push(`  - ${artifact.path}: ${artifact.reason}`);
    }
  }
  return lines.join("\n");
}

/** Build a host-owned unavailable section without exposing a failed artifact path. */
export function formatArtifactsUnavailableSeedSection(options: {
  readonly emittingRole: string;
  readonly emittingVisitIndex: number;
  readonly phase: "collection" | "delivery";
  readonly failureReason: string;
}): string {
  return [
    `## Artifacts from ${options.emittingRole}-v${options.emittingVisitIndex}`,
    "",
    "Not available:",
    `  - Host artifact ${options.phase} failed: ${options.failureReason}`,
    "    No files from this handoff were delivered.",
  ].join("\n");
}

async function resolveStoredArtifact(
  storedPath: string,
  sourceDirectoryReal: string,
): Promise<string> {
  const candidate = resolve(storedPath);
  if (!isStrictlyWithin(candidate, sourceDirectoryReal)) {
    throw new ArtifactRoutingError(
      "stored_artifact_escape",
      `stored artifact escapes its visit directory: ${storedPath}`,
    );
  }
  try {
    const file = await lstat(candidate);
    if (!file.isFile() || file.isSymbolicLink()) {
      throw new ArtifactRoutingError(
        "stored_artifact_missing",
        `stored artifact is not a regular file: ${storedPath}`,
      );
    }
    const resolved = await realpath(candidate);
    if (!isStrictlyWithin(resolved, sourceDirectoryReal)) {
      throw new ArtifactRoutingError(
        "stored_artifact_escape",
        `stored artifact resolves outside its visit directory: ${storedPath}`,
      );
    }
    return resolved;
  } catch (error) {
    if (error instanceof ArtifactRoutingError) throw error;
    throw new ArtifactRoutingError(
      "stored_artifact_missing",
      `stored artifact is unavailable: ${storedPath}`,
      {
        cause: error,
      },
    );
  }
}

async function resolveDirectory(path: string, label: string): Promise<string> {
  try {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new ArtifactRoutingError(
        "receiver_workspace_escape",
        `${label} must be a non-symbolic-link directory: ${path}`,
      );
    }
    return await realpath(path);
  } catch (error) {
    if (error instanceof ArtifactRoutingError) throw error;
    throw new ArtifactRoutingError("stored_artifact_missing", `${label} is unavailable: ${path}`, {
      cause: error,
    });
  }
}

async function ensureReceiverDirectory(directory: string, receiverRoot: string): Promise<void> {
  if (!isWithin(directory, receiverRoot)) {
    throw new ArtifactRoutingError(
      "receiver_workspace_escape",
      `artifact directory escapes receiver workspace: ${directory}`,
    );
  }
  const segments = relative(receiverRoot, directory).split(sep);
  let current = receiverRoot;
  for (const segment of segments) {
    if (segment.length === 0 || segment === ".") continue;
    current = join(current, segment);
    try {
      await mkdir(current);
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw new ArtifactRoutingError(
          "copy_failed",
          `could not create artifact directory: ${current}`,
          {
            cause: error,
          },
        );
      }
    }
    try {
      const entry = await lstat(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new ArtifactRoutingError(
          "receiver_workspace_escape",
          `artifact directory must not be a symbolic link: ${current}`,
        );
      }
      const resolved = await realpath(current);
      if (!isWithin(resolved, receiverRoot)) {
        throw new ArtifactRoutingError(
          "receiver_workspace_escape",
          `artifact directory resolves outside receiver workspace: ${current}`,
        );
      }
    } catch (error) {
      if (error instanceof ArtifactRoutingError) throw error;
      throw new ArtifactRoutingError(
        "copy_failed",
        `could not inspect artifact directory: ${current}`,
        {
          cause: error,
        },
      );
    }
  }
}

async function copyStoredArtifact(
  sourcePath: string,
  receiverPath: string,
  receiverRoot: string,
): Promise<boolean> {
  try {
    await copyFile(sourcePath, receiverPath, constants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if (isAlreadyExists(error)) {
      if (await isIdenticalReceiverArtifact(sourcePath, receiverPath, receiverRoot)) return false;
      throw new ArtifactRoutingError(
        "destination_conflict",
        `receiver artifact destination already exists: ${receiverPath}`,
      );
    }
    throw new ArtifactRoutingError("copy_failed", `could not route artifact to: ${receiverPath}`, {
      cause: error,
    });
  }
}

/** Accept only the exact regular-file copy left by a pre-prompt interrupted route. */
async function isIdenticalReceiverArtifact(
  sourcePath: string,
  receiverPath: string,
  receiverRoot: string,
): Promise<boolean> {
  try {
    const destination = await lstat(receiverPath);
    if (!destination.isFile() || destination.isSymbolicLink()) {
      throw new ArtifactRoutingError(
        "receiver_workspace_escape",
        `receiver artifact destination is not a regular file: ${receiverPath}`,
      );
    }
    const destinationReal = await realpath(receiverPath);
    if (!isStrictlyWithin(destinationReal, receiverRoot)) {
      throw new ArtifactRoutingError(
        "receiver_workspace_escape",
        `receiver artifact destination escapes its workspace: ${receiverPath}`,
      );
    }
    const [sourceBytes, destinationBytes] = await Promise.all([
      readFile(sourcePath),
      readFile(destinationReal),
    ]);
    return sourceBytes.equals(destinationBytes);
  } catch (error) {
    if (error instanceof ArtifactRoutingError) throw error;
    throw new ArtifactRoutingError(
      "copy_failed",
      `could not inspect receiver artifact destination: ${receiverPath}`,
      { cause: error },
    );
  }
}

function isWithin(candidate: string, root: string): boolean {
  const relativePath = relative(root, candidate);
  return !isOutsideRelativePath(relativePath);
}

function isStrictlyWithin(candidate: string, root: string): boolean {
  return candidate !== root && isWithin(candidate, root);
}

function isOutsideRelativePath(path: string): boolean {
  return (
    path === ".." || path.startsWith(`..${sep}`) || path.startsWith("/") || path.startsWith("\\")
  );
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
