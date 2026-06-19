/**
 * Manifest path resolution for the extension shell — Phase 7B.
 *
 * Two sources, in order of precedence:
 *
 *   1. `--conduct-manifest <path>` flag value (string). The
 *      extension factory reads the flag at command time
 *      (not at factory time) so a `--flag` set on the
 *      pi CLI line flows into the command handler.
 *   2. `<cwd>/.pi/conductor.yaml` (the project-local default).
 *
 * Resolution is explicit and boring: a string from the flag, or
 * a join. There is no fuzzy "search parents for a manifest"
 * logic in v1 — the spec/plan call for `.pi/conductor.yaml`
 * under `ctx.cwd` as the default, nothing more. The plan's
 * 7B.2 acceptance is "Missing manifest produces a user-facing
 * notification and no run"; `resolveManifestPath` returns
 * `null` when neither source yields a file, and the caller
 * (`/conduct`) turns that into a notification.
 *
 * The function is sync because `fs.accessSync` is sync and the
 * test surface relies on synchronous I/O (the rest of the host
 * is sync-friendly per the file-backed `RecordLog` design).
 * The function does NOT call `loadManifest` — the caller hands
 * the resolved path to `startRun`, which does the load +
 * validate + derive. Splitting "find the path" from "load the
 * path" keeps the resolution testable without a tempdir.
 */

import { accessSync, constants } from "node:fs";
import { join } from "node:path";

/**
 * Default project-local manifest path, relative to the
 * extension's cwd. Mirrors the plan: `.pi/conductor.yaml` is
 * the v1 default (single file, no walk-up search).
 */
export const DEFAULT_MANIFEST_PATH = ".pi/conductor.yaml";

/**
 * Result of `resolveManifestPath` — either the resolved
 * absolute path to a file that exists, or `null` when
 * neither source yields a file. `null` is the user-facing
 * "no manifest" signal; the command handler turns it into
 * a notification and returns without starting a run.
 */
export type ResolvedManifestPath = string | null;

/**
 * Resolve the manifest path. Order:
 *
 *   1. If `flagValue` is a non-empty string, use it as-is
 *      (relative paths are joined against `cwd`). The flag
 *      takes precedence over the default — users who pass
 *      `--conduct-manifest` expect that path to be used,
 *      even if a default would also resolve.
 *   2. Otherwise, fall back to `<cwd>/.pi/conductor.yaml`.
 *   3. If neither file exists on disk, return `null`.
 *
 * @param flagValue - The current value of `--conduct-manifest`,
 *                    or `undefined` if the flag was not set.
 * @param cwd - The extension's working directory. The default
 *              path is joined against this; an absolute
 *              `flagValue` is returned unchanged.
 * @returns The resolved path, or `null` when no manifest is
 *          found at the resolved location.
 */
export function resolveManifestPath(
  flagValue: string | undefined,
  cwd: string,
): ResolvedManifestPath {
  if (typeof flagValue === "string" && flagValue.length > 0) {
    const candidate = isAbsolute(flagValue) ? flagValue : join(cwd, flagValue);
    if (fileExists(candidate)) return candidate;
    return null;
  }
  const defaultPath = join(cwd, DEFAULT_MANIFEST_PATH);
  if (fileExists(defaultPath)) return defaultPath;
  return null;
}

/**
 * `path.isAbsolute` re-implemented locally to avoid importing
 * `node:path` twice in this file (the join above is the only
 * `node:path` use). One-line abstraction; the win is that
 * tests can read the rule inline without a path-doc lookup.
 */
function isAbsolute(p: string): boolean {
  return p.startsWith("/");
}

/**
 * Sync file existence check via `fs.accessSync` with
 * `F_OK` (existence, not readability — the manifest loader
 * reads the file itself; we just need "is there a file
 * here?"). Throws are caught and turned into `false` so
 * the resolution is total: any I/O error → "no file".
 */
function fileExists(p: string): boolean {
  try {
    accessSync(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
