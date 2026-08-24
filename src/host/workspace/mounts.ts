/**
 * Projection roots + guarantee computation — spec §4, §6.
 *
 * Computes the per-session guarantee level from (backend, mounts, tools):
 * - `shared` backend → `none`
 * - isolated (worktree/copy/container) with no writable host mounts →
 *   `confined` (in-process) or `sandbox` (container)
 * - isolated with writable absolute (host) mount → capped at `confined`
 *   with a manifest warning (INV-004, rule 7)
 *
 * Also resolves the projection (roots a role may access) from the
 * manifest's `workspace.mounts` + pinned snapshot.
 */

import { join } from "node:path";
import type { Role } from "../../core/types.js";
import type {
  WorkspaceBackend,
  WorkspaceConfig,
  WorkspaceMount,
  WorkspaceSource,
} from "../../manifest/types.js";

/**
 * Computed guarantee level for a role session (spec §6).
 *
 * Computed, never self-declared (INV-004). No record, seed, or UI text
 * may claim a guarantee stronger than this computed level (INV-006).
 */
export type GuaranteeLevel = "none" | "confined" | "sandbox";

/**
 * Projection roots a role may access. For `shared` roles: just the
 * integration workspace. For isolated roles: workspace root + mounts.
 */
export interface Projection {
  /** The role's workspace root (integration workspace for `shared`, worktree/copy path for isolated). */
  readonly workspaceRoot: string;
  /** Additional mount roots (empty for `shared`). */
  readonly mounts: readonly ProjectionMount[];
}

/**
 * A mount in a role's projection (resolved from the manifest).
 */
export interface ProjectionMount {
  /** The resolved absolute path. */
  readonly path: string;
  /** Whether the role may write to this mount. */
  readonly writable: boolean;
}

/**
 * Result of guarantee computation — the level plus any warnings.
 */
export interface GuaranteeResult {
  /** The computed guarantee level. */
  readonly level: GuaranteeLevel;
  /** Manifest warnings, if any (rule 7 downgrade warning). */
  readonly warnings: string[];
  /** The computed projection for this role. */
  readonly projection: Projection;
}

// ─── Guarantee computation ──────────────────────────────────────────────

/**
 * Compute the guarantee level for a role given its workspace config,
 * tools, and the resolved pinned commit.
 *
 * Rule from spec §6:
 * - `shared` (no `workspace` block) → `none`
 * - read-only isolated (only read/grep/find/ls) → `confined` (in-process) / `sandbox` (container)
 * - writable isolated (edit/write declared) → `confined` (in-process) / `sandbox` (container)
 * - Any writable absolute (host) mount → capped at `confined` + warning
 *
 * @param backend - the workspace backend
 * @param tools - the role's declared tools
 * @param workspaceConfig - the role's `workspace` block (if any)
 * @param source - the source resolution (`snapshot` or `ref:<ref>`)
 * @param pinDir - the resolved pinned commit (for mount resolution)
 * @param pinSha8 - 8-char short commit hash (for mount resolution)
 */
export function computeGuarantee(args: {
  backend: WorkspaceBackend;
  tools: readonly string[] | undefined;
  workspaceConfig?: WorkspaceConfig;
  source: WorkspaceSource;
  pinDir: string;
  pinSha8: string;
}): GuaranteeResult {
  const { backend, tools, workspaceConfig, source, pinDir, pinSha8 } = args;

  // `shared` backend → guarantee is `none`.
  if (backend === "shared") {
    return {
      level: "none",
      warnings: [],
      projection: { workspaceRoot: pinDir, mounts: [] },
    };
  }

  const mounts = workspaceConfig?.mounts ?? [];
  const projectionMounts: ProjectionMount[] = [];

  // Add the pinned snapshot as the first mount (read-only).
  const snapshotMount: ProjectionMount = {
    path: join(pinDir, pinSha8),
    writable: false,
  };
  projectionMounts.push(snapshotMount);

  // Add declared mounts to the projection.
  for (const mount of mounts) {
    const resolvedPath = resolveMountPath(mount.path, pinDir, pinSha8);
    projectionMounts.push({
      path: resolvedPath,
      writable: mount.writable,
    });
  }

  const projection: Projection = {
    workspaceRoot: pinDir, // placeholder — the actual workspace path is set by the manager
    mounts: projectionMounts,
  };

  // Check for rule 7: writable absolute (host) mount → cap at `confined`.
  const hasWritableHostMount = projectionMounts.some((m) => m.writable && isAbsolutePath(m.path));

  // Determine the base guarantee from backend.
  let level: GuaranteeLevel;
  if (backend === "container") {
    // Container can earn `sandbox` IF no writable host mounts.
    level = hasWritableHostMount ? "confined" : "sandbox";
  } else {
    // worktree/copy are in-process → `confined`.
    level = "confined";
  }

  // Build warnings.
  const warnings: string[] = [];
  if (hasWritableHostMount) {
    warnings.push(
      "role has writable absolute (host) mount; guarantee capped at 'confined' (INV-004, rule 7)",
    );
  }

  return { level, warnings, projection };
}

// ─── Mount path resolution ──────────────────────────────────────────────

/**
 * Resolve a mount path. Relative paths resolve inside the pinned
 * snapshot; absolute paths are used as-is (host path).
 */
function resolveMountPath(mountPath: string, pinDir: string, pinSha8: string): string {
  if (isAbsolutePath(mountPath)) {
    return mountPath;
  }
  // Relative → inside the pinned snapshot.
  return join(pinDir, pinSha8, mountPath);
}

/**
 * Check if a path is absolute.
 */
function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[A-Z]:/i.test(path);
}

// ─── Projection helpers ─────────────────────────────────────────────────

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
  // Check the workspace root first.
  if (isInsideOrEqual(filePath, projection.workspaceRoot)) {
    return { inside: true, mount: { path: projection.workspaceRoot, writable: true } };
  }

  // Check each mount.
  for (const mount of projection.mounts) {
    if (isInsideOrEqual(filePath, mount.path)) {
      return { inside: true, mount };
    }
  }

  return { inside: false, reason: "path is outside all projection roots" };
}

/**
 * Check if a resolved path is inside (or equal to) a root directory.
 */
function isInsideOrEqual(path: string, root: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(normalizedRoot + "/");
}

/**
 * Normalize a path (strip trailing separators, resolve `.`, `..`).
 */
function normalizePath(path: string): string {
  // Simple normalization — realpath would require filesystem access.
  // This is used for string comparison after realpath has already
  // been resolved in the caller.
  return path.replace(/\/+$/, "").replace(/\/+/g, "/");
}

/**
 * Resolve a path to its real path (for containment checks).
 * Returns `null` if the path doesn't exist.
 */

// ─── Container-only guarantee computation ───────────────────────────────

/**
 * Additional guarantees computed only for the `container` backend (T8).
 */
export interface ContainerGuarantee {
  /** Whether the container has network access (`bridge`) or none. */
  readonly network: "bridge" | "none";
  /** Whether the container has `shell: container` (full bash inside). */
  readonly shell: "none" | "container";
  /** The Docker image used (if any). */
  readonly image?: string;
}

/**
 * Compute the full container guarantee (base + container-specific).
 */
export function computeContainerGuarantee(
  base: GuaranteeResult,
  workspaceConfig: WorkspaceConfig,
): GuaranteeResult & ContainerGuarantee {
  const container: ContainerGuarantee = {
    network: workspaceConfig.network ?? "bridge",
    shell: workspaceConfig.shell ?? "none",
  };
  if (workspaceConfig.image !== undefined) {
    (container as ContainerGuarantee & { image: string }).image = workspaceConfig.image;
  }

  // Container with network: none → capped at `confined` even without writable host mounts.
  const effectiveLevel =
    container.network === "none" && base.level === "sandbox" ? "confined" : base.level;

  return { ...base, ...container, level: effectiveLevel };
}
