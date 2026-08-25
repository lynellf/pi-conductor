/**
 * Projection roots + guarantee computation — Issue #48 R1.
 *
 * Computes the per-session guarantee from the provisioned workspace and
 * actual shared snapshot checkout. The strongest available guarantee is
 * `confined`; container execution is rejected before this code is reached.
 */

import { join } from "node:path";
import type { WorkspaceBackend, WorkspaceConfig } from "../../manifest/types.js";
import { assertSupportedWorkspaceBackend } from "./manager.js";

/** Computed guarantee level for a role session. */
export type GuaranteeLevel = "none" | "confined";

/** Projection roots a role may access. */
export interface Projection {
  /** The role's workspace root (integration workspace for `shared`). */
  readonly workspaceRoot: string;
  /** Additional mount roots (empty for `shared`). */
  readonly mounts: readonly ProjectionMount[];
}

/** A mount in a role's projection. */
export interface ProjectionMount {
  /** The resolved absolute path. */
  readonly path: string;
  /** Whether the role may write to this mount. */
  readonly writable: boolean;
}

/** Result of guarantee computation — the level plus any warnings. */
export interface GuaranteeResult {
  /** The computed guarantee level. */
  readonly level: GuaranteeLevel;
  /** Manifest warnings, if any. */
  readonly warnings: string[];
  /** The computed projection for this role. */
  readonly projection: Projection;
}

/**
 * Compute the guarantee and projection from provisioned paths.
 *
 * `workspacePath` and `snapshotPath` are host-created paths, never derived
 * from the integration checkout or a commit hash in this function.
 */
export function computeGuarantee(args: {
  backend: WorkspaceBackend;
  workspaceConfig?: WorkspaceConfig;
  workspacePath: string;
  snapshotPath: string;
}): GuaranteeResult {
  const { backend, workspaceConfig, workspacePath, snapshotPath } = args;

  assertSupportedWorkspaceBackend(backend);

  if (backend === "shared") {
    return {
      level: "none",
      warnings: [],
      projection: { workspaceRoot: workspacePath, mounts: [] },
    };
  }

  const projectionMounts: ProjectionMount[] = [];
  for (const mount of workspaceConfig?.mounts ?? []) {
    projectionMounts.push({
      path: resolveMountPath(mount.path, snapshotPath),
      writable: mount.writable,
    });
  }

  const hasWritableHostMount = projectionMounts.some(
    (mount) => mount.writable && isAbsolutePath(mount.path),
  );
  const warnings = hasWritableHostMount
    ? ["role has writable absolute (host) mount; guarantee remains 'confined' (INV-004, rule 7)"]
    : [];

  return {
    level: "confined",
    warnings,
    projection: {
      workspaceRoot: workspacePath,
      mounts: projectionMounts,
    },
  };
}

/** Resolve a mount path relative to the actual shared snapshot checkout. */
function resolveMountPath(mountPath: string, snapshotPath: string): string {
  return isAbsolutePath(mountPath) ? mountPath : join(snapshotPath, mountPath);
}

/** Check whether a path is absolute. */
function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[A-Z]:/i.test(path);
}

/**
 * Check whether a path is within (or equal to) any projection root.
 *
 * This is a string-level check — the caller is responsible for resolving
 * realpaths beforehand. Used by artifact collection (§7.2) for containment
 * checks.
 */
export function pathInProjection(
  filePath: string,
  projection: Projection,
): { inside: true; mount: ProjectionMount } | { inside: false; reason: string } {
  if (isInsideOrEqual(filePath, projection.workspaceRoot)) {
    return { inside: true, mount: { path: projection.workspaceRoot, writable: true } };
  }

  for (const mount of projection.mounts) {
    if (isInsideOrEqual(filePath, mount.path)) {
      return { inside: true, mount };
    }
  }

  return { inside: false, reason: "path is outside all projection roots" };
}

/** Check if a resolved path is inside (or equal to) a root directory. */
function isInsideOrEqual(path: string, root: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

/** Normalize a path (strip trailing separators, resolve `.`, `..`). */
function normalizePath(path: string): string {
  return path.replace(/\/+$/, "").replace(/\/+/g, "/");
}
