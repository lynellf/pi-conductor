/**
 * Artifact collection — spec §7.2.
 *
 * At every terminal of a writable worktree workspace (`session_ended` and
 * `session_failed`), the host calls `collectDeclaredArtifacts` to:
 *
 *   1. Resolve each declared artifact path (realpath, nearest-existing-
 *      ancestor rule).
 *   2. Enforce containment within the emitting role's workspace root
 *      or a writable mount.
 *   3. Enforce `max_file_bytes` / `max_files` caps (per the role's
 *      `artifacts` policy from the manifest).
 *   4. Copy accepted files to `<runStateDir>/artifacts/<runId>/<role>-v<visitIndex>/`.
 *   5. Generate `artifact_collected` records for accepted files and
 *      `artifact_rejected` records for each rejection reason
 *      (`outside_projection`, `size_cap`, `count_cap`, `missing`).
 *
 * Auto-patch generation is handled separately (see `autoPatch` below). This
 * module stays cohesive above the usual size limit because both collection
 * paths must share the same physical artifact-store containment guarantee.
 *
 * @module host/artifacts/collect
 * @see spec §7.2 (collection rules)
 */

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ArtifactConfig } from "../../manifest/types.js";
import type { ArtifactCollectedRecord, ArtifactRejectedRecord } from "../../persistence/log.js";
import type { HandoffArgs } from "../../seam/schema.js";
import type { Projection } from "../workspace/mounts.js";

// ─── Defaults (per spec §4 validation rules) ────────────────────────────

const DEFAULT_MAX_FILE_BYTES = 1_048_576; // 1 MiB
const DEFAULT_MAX_FILES = 32;

/** Resolves artifact caps from the role's manifest config. */
function resolveArtifactCaps(config: ArtifactConfig | undefined): {
  maxFileBytes: number;
  maxFiles: number;
} {
  return {
    maxFileBytes: config?.max_file_bytes ?? DEFAULT_MAX_FILE_BYTES,
    maxFiles: config?.max_files ?? DEFAULT_MAX_FILES,
  };
}

// ─── Collection result ──────────────────────────────────────────────────

/** Result of artifact collection for a single handoff. */
export interface CollectionResult {
  /** Successfully collected artifact records (one per accepted file). */
  readonly collected: ArtifactCollectedRecord[];
  /** Rejected artifact records (one per rejected declaration). */
  readonly rejected: ArtifactRejectedRecord[];
}

type ArtifactCollectionErrorCode =
  | "artifact_store_conflict"
  | "artifact_store_escape"
  | "auto_patch_failed"
  | "not_regular"
  | "workspace_mismatch";

/** Typed failure when artifact collection cannot safely proceed. */
export class ArtifactCollectionError extends Error {
  readonly code: ArtifactCollectionErrorCode;

  constructor(code: ArtifactCollectionErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ArtifactCollectionError";
    this.code = code;
  }
}

type ArtifactPathResolution =
  | { readonly kind: "missing" }
  | { readonly kind: "outside_projection" }
  | { readonly kind: "resolved"; readonly path: string; readonly storageSegments: string[] };

// ─── Core collection function ───────────────────────────────────────────

/** Collects declared regular files from an emitter workspace — issue #48 §7.2. */
export async function collectDeclaredArtifacts(
  options: {
    runId: string;
    role: string;
    visitIndex: number;
    sessionId: string;
    workspaceRoot: string;
    projection: Projection;
    artifactsConfig: ArtifactConfig | undefined;
    artifactsDir: string;
  },
  targetHandoff: Pick<HandoffArgs, "artifacts">,
): Promise<CollectionResult> {
  const {
    runId,
    role,
    visitIndex,
    sessionId,
    workspaceRoot,
    projection,
    artifactsConfig,
    artifactsDir,
  } = options;
  const declared = targetHandoff.artifacts;

  if (!declared || declared.length === 0) {
    return { collected: [], rejected: [] };
  }

  const workspaceRootReal = await realpath(workspaceRoot);
  const projectionWorkspaceRootReal = await realpath(projection.workspaceRoot);
  if (workspaceRootReal !== projectionWorkspaceRootReal) {
    throw new ArtifactCollectionError(
      "workspace_mismatch",
      "artifact workspace root must match the emitter projection root",
    );
  }

  const caps = resolveArtifactCaps(artifactsConfig);
  const collected: ArtifactCollectedRecord[] = [];
  const rejected: ArtifactRejectedRecord[] = [];
  for (const declaration of declared) {
    const resolved = await resolveArtifactPath(declaration.path, workspaceRootReal, projection);
    if (resolved.kind === "outside_projection") {
      rejected.push(
        rejectedArtifact(runId, role, sessionId, declaration.path, "outside_projection"),
      );
      continue;
    }
    if (resolved.kind === "missing") {
      rejected.push(rejectedArtifact(runId, role, sessionId, declaration.path, "missing"));
      continue;
    }

    const fileStat = await stat(resolved.path);
    if (!fileStat.isFile()) {
      throw new ArtifactCollectionError(
        "not_regular",
        `declared artifact is not a regular file: ${declaration.path}`,
      );
    }
    if (fileStat.size > caps.maxFileBytes) {
      rejected.push(rejectedArtifact(runId, role, sessionId, declaration.path, "size_cap"));
      continue;
    }
    if (collected.length >= caps.maxFiles) {
      rejected.push(rejectedArtifact(runId, role, sessionId, declaration.path, "count_cap"));
      continue;
    }

    const fileBuffer = await readFile(resolved.path);
    if (fileBuffer.length > caps.maxFileBytes) {
      rejected.push(rejectedArtifact(runId, role, sessionId, declaration.path, "size_cap"));
      continue;
    }

    const storedPath = await prepareArtifactStorePath(
      artifactsDir,
      role,
      visitIndex,
      join(...resolved.storageSegments),
    );
    await writeArtifactFile(storedPath, fileBuffer);

    const record: ArtifactCollectedRecord = {
      type: "artifact_collected",
      run_id: runId,
      role,
      visit_index: visitIndex,
      session_id: sessionId,
      source_path: declaration.path,
      stored_path: storedPath,
      ...(declaration.description !== undefined && { description: declaration.description }),
      kind: "declared",
      bytes: fileBuffer.length,
      sha256: createHash("sha256").update(fileBuffer).digest("hex"),
      ts: Date.now(),
    };
    collected.push(record);
  }

  return { collected, rejected };
}

async function prepareArtifactStorePath(
  artifactsDir: string,
  role: string,
  visitIndex: number,
  relativeStoredPath: string,
): Promise<string> {
  const artifactStoreRoot = resolve(artifactsDir);
  const visitStoreDir = resolve(artifactStoreRoot, `${role}-v${visitIndex}`);
  const storedPath = resolve(visitStoreDir, relativeStoredPath);
  if (
    !isStrictlyWithinRoot(visitStoreDir, artifactStoreRoot) ||
    !isStrictlyWithinRoot(storedPath, visitStoreDir)
  ) {
    throw new ArtifactCollectionError(
      "artifact_store_escape",
      `role artifact storage path escapes the run artifact store: ${role}`,
    );
  }

  await mkdir(artifactStoreRoot, { recursive: true });
  const artifactStoreRootReal = await assertArtifactStoreDirectory(
    artifactStoreRoot,
    artifactStoreRoot,
  );
  await ensureArtifactStoreDirectory(artifactStoreRoot, visitStoreDir, artifactStoreRootReal);
  await ensureArtifactStoreDirectory(artifactStoreRoot, dirname(storedPath), artifactStoreRootReal);

  const storedParentReal = await realpath(dirname(storedPath));
  const storedPathReal = resolve(storedParentReal, relative(dirname(storedPath), storedPath));
  if (!isStrictlyWithinRoot(storedPathReal, artifactStoreRootReal)) {
    throw new ArtifactCollectionError(
      "artifact_store_escape",
      `artifact destination escapes the run artifact store: ${storedPath}`,
    );
  }
  return storedPathReal;
}

async function ensureArtifactStoreDirectory(
  artifactStoreRoot: string,
  directory: string,
  artifactStoreRootReal: string,
): Promise<void> {
  const directoryRelative = relative(artifactStoreRoot, directory);
  if (!isWithinRoot(directory, artifactStoreRoot)) {
    throw new ArtifactCollectionError(
      "artifact_store_escape",
      `artifact directory escapes the run artifact store: ${directory}`,
    );
  }

  let current = artifactStoreRoot;
  for (const segment of directoryRelative.split(sep)) {
    if (segment.length === 0) continue;
    try {
      current = join(current, segment);
      await mkdir(current);
    } catch (cause) {
      if (!isAlreadyExists(cause)) throw cause;
    }
    await assertArtifactStoreDirectory(current, artifactStoreRootReal);
  }
}

async function assertArtifactStoreDirectory(directory: string, artifactStoreRootReal: string) {
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new ArtifactCollectionError(
      "artifact_store_escape",
      `artifact directory must not be a symbolic link: ${directory}`,
    );
  }
  const directoryReal = await realpath(directory);
  if (!isWithinRoot(directoryReal, artifactStoreRootReal)) {
    throw new ArtifactCollectionError(
      "artifact_store_escape",
      `artifact directory escapes the run artifact store: ${directory}`,
    );
  }
  return directoryReal;
}

async function writeArtifactFile(storedPath: string, contents: Uint8Array): Promise<void> {
  try {
    await writeFile(storedPath, contents, { flag: "wx" });
  } catch (cause) {
    if (isAlreadyExists(cause)) {
      throw new ArtifactCollectionError(
        "artifact_store_conflict",
        `artifact storage already contains: ${storedPath}`,
      );
    }
    throw cause;
  }
}

function rejectedArtifact(
  runId: string,
  role: string,
  sessionId: string,
  path: string,
  reason: ArtifactRejectedRecord["reason"],
): ArtifactRejectedRecord {
  return {
    type: "artifact_rejected",
    run_id: runId,
    role,
    session_id: sessionId,
    path,
    reason,
    ts: Date.now(),
  };
}

async function resolveArtifactPath(
  declaredPath: string,
  workspaceRoot: string,
  projection: Projection,
): Promise<ArtifactPathResolution> {
  const storageSegments = pathSegments(declaredPath);
  if (storageSegments === null) return { kind: "outside_projection" };

  const mountIndex = virtualMountIndex(storageSegments);
  if (mountIndex === null) {
    return resolvePathInsideRoot(
      resolve(workspaceRoot, ...storageSegments),
      workspaceRoot,
      storageSegments,
    );
  }

  const mount = projection.mounts[mountIndex];
  if (mount === undefined || !mount.writable) return { kind: "outside_projection" };
  const mountRoot = await realpath(mount.path);
  return resolvePathInsideRoot(
    resolve(mountRoot, ...storageSegments.slice(2)),
    mountRoot,
    storageSegments,
  );
}

function pathSegments(declaredPath: string): string[] | null {
  if (isAbsolutePath(declaredPath)) return null;
  const segments = declaredPath.split(/[\\/]/);
  if (segments.includes("..")) return null;
  return segments.filter((segment) => segment.length > 0 && segment !== ".");
}

function virtualMountIndex(segments: readonly string[]): number | null {
  const index = segments[1];
  if (segments[0] !== "mounts" || index === undefined || !/^(0|[1-9]\d*)$/.test(index)) {
    return null;
  }
  const value = Number(index);
  return Number.isSafeInteger(value) ? value : null;
}

async function resolvePathInsideRoot(
  candidate: string,
  root: string,
  storageSegments: string[],
): Promise<ArtifactPathResolution> {
  if (!isWithinRoot(candidate, root)) return { kind: "outside_projection" };

  let nearest = candidate;
  for (;;) {
    try {
      const resolved = await realpath(nearest);
      if (!isWithinRoot(resolved, root)) return { kind: "outside_projection" };
      return nearest === candidate
        ? { kind: "resolved", path: resolved, storageSegments }
        : { kind: "missing" };
    } catch (cause) {
      if (!isNotFound(cause)) throw cause;
      const parent = dirname(nearest);
      if (parent === nearest) return { kind: "missing" };
      nearest = parent;
    }
  }
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path);
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolutePath(relativePath))
  );
}

function isStrictlyWithinRoot(candidate: string, root: string): boolean {
  return candidate !== root && isWithinRoot(candidate, root);
}

function isNotFound(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

function isAlreadyExists(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST";
}

// ─── Auto-patch generation (writable worktree workspaces only) ──────────

/**
 * Generate a git diff patch from a writable worktree workspace.
 *
 * At every terminal of a writable worktree workspace (`session_ended` or
 * `session_failed`), the host generates `git diff` (plus `git add -N`
 * for untracked, `--binary`) into the artifacts storage. This is
 * model-independent and exfiltration-free by construction (the host
 * derives it from Git state).
 *
 * @param options - auto-patch parameters.
 * @param options.workspacePath - the role's workspace path (worktree root).
 * @param options.artifactsDir - the base artifacts directory.
 * @param options.role - the emitting role name.
 * @param options.visitIndex - the role's visit index (0-based).
 * @param options.kind - whether this is from a normal terminal or a failure.
 * @returns the generated `ArtifactCollectedRecord`, or null only when Git produces an empty diff.
 *
 * @see spec §7.2 (auto-patch)
 */
export async function collectAutoPatch(options: {
  workspacePath: string;
  artifactsDir: string;
  runId: string;
  role: string;
  visitIndex: number;
  sessionId: string;
  kind: "declared" | "auto_patch";
  /** Retry-terminal filename supplied by the host to avoid overwriting a prior patch. */
  patchFileName?: string;
}): Promise<ArtifactCollectedRecord | null> {
  const { workspacePath, artifactsDir, runId, role, visitIndex, sessionId, kind } = options;

  let patchBuffer: Buffer;
  try {
    // Generate the patch via git diff.
    // This is a synchronous shell call — acceptable for a short-lived
    // operations tool; the patch is small and the workspace is local.
    const { execFileSync } = await import("node:child_process");

    // Step 1: git add -N for untracked files (intent-to-add).
    execFileSync("git", ["add", "-N", "."], {
      cwd: workspacePath,
      stdio: "pipe",
    });

    // Step 2: normal working-tree diff includes ordinary unstaged edits
    // and the intent-to-add untracked files from step 1.
    patchBuffer = execFileSync("git", ["diff", "--binary"], {
      cwd: workspacePath,
      stdio: "pipe",
    });
  } catch (cause) {
    throw new ArtifactCollectionError(
      "auto_patch_failed",
      "could not generate auto-patch from the Git working tree",
      { cause },
    );
  }

  // A successfully generated empty diff has no patch to retain.
  if (patchBuffer.length === 0) {
    return null;
  }

  const patchFileName = options.patchFileName ?? `patch-${role}-v${visitIndex}.patch`;
  const storedPath = await prepareArtifactStorePath(artifactsDir, role, visitIndex, patchFileName);
  await writeArtifactFile(storedPath, patchBuffer);

  return {
    type: "artifact_collected",
    run_id: runId,
    role,
    visit_index: visitIndex,
    session_id: sessionId,
    source_path: "(auto_patch)",
    stored_path: storedPath,
    kind,
    bytes: patchBuffer.length,
    sha256: createHash("sha256").update(patchBuffer).digest("hex"),
    ts: Date.now(),
  };
}
