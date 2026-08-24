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
 * Auto-patch generation is handled separately (see `autoPatch` below).
 *
 * @module host/artifacts/collect
 * @see spec §7.2 (collection rules)
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { ArtifactCollectedRecord, ArtifactRejectedRecord } from "../../persistence/log.js";
import type { HandoffArgs } from "../../seam/schema.js";
import type { ArtifactConfig } from "../../manifest/types.js";
import { pathInProjection, type Projection } from "../workspace/mounts.js";

// ─── Defaults (per spec §4 validation rules) ────────────────────────────

const DEFAULT_MAX_FILE_BYTES = 1_048_576; // 1 MiB
const DEFAULT_MAX_FILES = 32;

/** Resolve artifact caps from the role's manifest config, falling back to spec defaults. */
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

// ─── Core collection function ───────────────────────────────────────────

/**
 * Collect declared artifact files from a role session's workspace.
 *
 * Validates each declared path against the role's projection, enforces
 * caps, copies accepted files to the artifacts storage directory, and
 * generates records for both accepted and rejected files.
 *
 * @param options - collection parameters.
 * @param options.runId - the current run ID.
 * @param options.role - the emitting role name.
 * @param options.visitIndex - the role's visit index (0-based).
 * @param options.sessionId - the session ID that emitted the handoff.
 * @param options.workspaceRoot - the emitting role's workspace root path (realpath).
 * @param options.projection - the role's projection (workspace root + mounts).
 * @param options.artifactsConfig - the role's artifact config from the manifest.
 * @param options.artifactsDir - the base artifacts directory
 *   (`<runStateDir>/artifacts/<runId>/`).
 * @param targetHandoff - the validated handoff event containing declared artifacts.
 * @returns collected and rejected records.
 *
 * @remarks
 * - `realpath` containment check uses the nearest-existing-ancestor rule
 *   (same as the confinement factory).
 * - Files outside the projection are rejected with `outside_projection`.
 * - Files exceeding `max_file_bytes` are rejected with `size_cap`.
 * - Once `max_files` is reached, further declarations are rejected with
 *   `count_cap`.
 * - Missing files are recorded as `missing` (not a rejection — the file
 *   was never there to collect).
 *
 * @see spec §7.2 (collection rules)
 */
export async function collectDeclaredArtifacts(
  options: {
    runId: string;
    role: string;
    visitIndex: number;
    sessionId: string;
    workspaceRoot: string;
    projection: ReturnType<typeof pathInProjection> extends { inside: true }
      ? Projection
      : never;
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

  const caps = resolveArtifactCaps(artifactsConfig);
  const declared = targetHandoff.artifacts;

  if (!declared || declared.length === 0) {
    return { collected: [], rejected: [] };
  }

  const collected: ArtifactCollectedRecord[] = [];
  const rejected: ArtifactRejectedRecord[] = [];
  const artifactStoreDir = join(artifactsDir, `${role}-v${visitIndex}`);

  // Ensure the storage directory exists.
  await mkdir(artifactStoreDir, { recursive: true });

  for (const decl of declared) {
    // ── Containment check ────────────────────────────────────────────
    const containmentResult = pathInProjection(
      decl.path,
      projection as unknown as ReturnType<typeof pathInProjection> extends { inside: true }
        ? Projection
        : never,
    );

    if (!containmentResult.inside) {
      rejected.push({
        type: "artifact_rejected",
        run_id: runId,
        role,
        session_id: sessionId,
        path: decl.path,
        reason: "outside_projection",
        ts: Date.now(),
      });
      continue;
    }

    // ── File existence + size check ────────────────────────────────────
    // Resolve the file within the workspace. The path is already within
    // the projection; resolve it relative to the workspace root.
    const resolvedPath = resolve(workspaceRoot, decl.path);

    let fileStat: { size: number };
    try {
      fileStat = await stat(resolvedPath);
    } catch (err: unknown) {
      // File doesn't exist — record as missing.
      rejected.push({
        type: "artifact_rejected",
        run_id: runId,
        role,
        session_id: sessionId,
        path: decl.path,
        reason: "missing",
        ts: Date.now(),
      });
      continue;
    }

    // Check file size cap.
    if (fileStat.size > caps.maxFileBytes) {
      rejected.push({
        type: "artifact_rejected",
        run_id: runId,
        role,
        session_id: sessionId,
        path: decl.path,
        reason: "size_cap",
        ts: Date.now(),
      });
      continue;
    }

    // Check count cap (how many files have we already collected?).
    if (collected.length >= caps.maxFiles) {
      rejected.push({
        type: "artifact_rejected",
        run_id: runId,
        role,
        session_id: sessionId,
        path: decl.path,
        reason: "count_cap",
        ts: Date.now(),
      });
      continue;
    }

    // ── Copy file to artifacts store ───────────────────────────────────
    const fileName = decl.path.split(/[\\/]/).pop() ?? decl.path;
    const storedPath = join(artifactStoreDir, fileName);

    // Read and hash the file.
    const fileBuffer = await readFile(resolvedPath);
    const sha256 = createHash("sha256").update(fileBuffer).digest("hex");

    // Copy to store (atomic-ish: write to temp, then rename).
    const tempPath = storedPath + `.tmp-${process.pid}-${Date.now()}`;
    await mkdir(dirname(storedPath), { recursive: true });
    await writeFile(tempPath, fileBuffer);
    // Rename is atomic on POSIX; falls through on failure.
    try {
      await (rename as unknown as (from: string, to: string) => Promise<void>)(
        tempPath,
        storedPath,
      );
    } catch {
      // Fallback: try rename via fs/promises (Node 20.1.0+).
      try {
        const { rename: fsRename } = await import("node:fs/promises");
        await fsRename(tempPath, storedPath);
      } catch {
        // Last resort: copy then delete temp.
        await copyFile(tempPath, storedPath);
        try {
          await (await import("node:fs/promises")).rm(tempPath);
        } catch {
          // Best-effort cleanup of temp file.
        }
      }
    }

    collected.push({
      type: "artifact_collected",
      run_id: runId,
      role,
      visit_index: visitIndex,
      session_id: sessionId,
      source_path: decl.path,
      stored_path: storedPath,
      kind: "declared",
      bytes: fileStat.size,
      sha256,
      ts: Date.now(),
    });
  }

  return { collected, rejected };
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
 * @returns the generated `ArtifactCollectedRecord` or null if patch generation fails.
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
}): Promise<ArtifactCollectedRecord | null> {
  const { workspacePath, artifactsDir, runId, role, visitIndex, sessionId, kind } =
    options;

  const artifactStoreDir = join(artifactsDir, `${role}-v${visitIndex}`);
  const patchFileName = `patch-${role}-v${visitIndex}.patch`;
  const storedPath = join(artifactStoreDir, patchFileName);

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

    // Step 2: git diff --cached --binary for the staged changes.
    const patchBuffer = execFileSync("git", ["diff", "--cached", "--binary"], {
      cwd: workspacePath,
      stdio: "pipe",
    });

    // If no diff was generated, skip auto-patch.
    if (patchBuffer.length === 0) {
      return null;
    }

    // Write the patch to the artifacts store.
    await mkdir(artifactStoreDir, { recursive: true });
    await writeFile(storedPath, patchBuffer);

    // Compute SHA-256 of the patch.
    const sha256 = createHash("sha256").update(patchBuffer).digest("hex");

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
      sha256,
      ts: Date.now(),
    };
  } catch {
    // Git not available, or workspace is not a git repo — skip.
    return null;
  }
}

// ─── Private helpers ────────────────────────────────────────────────────

// Node 20.1.0+ exports `rename` in `fs/promises`, but earlier versions
// don't. This import helper defers the resolution.
const rename = (await import("node:fs/promises")).rename;
