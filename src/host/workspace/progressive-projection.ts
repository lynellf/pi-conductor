/** Public progressive sparse workspace projection API for Issue #51. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ProgressiveDisclosurePolicy } from "../../manifest/types.js";

import {
  checkPinnedWorkspaceHead,
  inspectPinnedRegularFile,
  isSafeRepositoryRelativePath,
  progressiveDisclosurePolicyAllowsPath,
} from "./progressive-projection-inspection.js";
import { materializePinnedPaths } from "./progressive-projection-materialization.js";
import type {
  ProgressiveProjectionExpansionResult,
  ProgressiveProjectionGitAuthority,
} from "./progressive-projection-types.js";
import { ProgressiveProjectionError } from "./progressive-projection-types.js";

export { captureProgressiveProjectionGitAuthority } from "./progressive-projection-inspection.js";
export type {
  ProgressiveProjectionExpansionResult,
  ProgressiveProjectionGitAuthority,
} from "./progressive-projection-types.js";
export { ProgressiveProjectionError } from "./progressive-projection-types.js";

const execFileAsync = promisify(execFile);

/** Add policy-approved exact regular files from the immutable pinned commit (Issue #51). */
export async function expandProgressiveProjection(
  authority: ProgressiveProjectionGitAuthority,
  policy: ProgressiveDisclosurePolicy,
  paths: readonly string[],
  pinnedCommit: string,
  isReadOnly: boolean,
): Promise<ProgressiveProjectionExpansionResult> {
  if (paths.length === 0) {
    return { kind: "denied", code: "empty-request" };
  }

  const unsafePath = paths.find((path) => !isSafeRepositoryRelativePath(path));
  if (unsafePath !== undefined) {
    return { kind: "denied", code: "unsafe-path", path: unsafePath };
  }

  const requestedPaths = new Set<string>();
  for (const path of paths) {
    if (requestedPaths.has(path)) {
      return { kind: "denied", code: "multiple-entries", path };
    }
    requestedPaths.add(path);
  }

  const deniedPath = paths.find((path) => !progressiveDisclosurePolicyAllowsPath(path, policy));
  if (deniedPath !== undefined) {
    return { kind: "denied", code: "not-allowed", path: deniedPath };
  }

  const initialHeadCheck = await checkPinnedWorkspaceHead(authority, pinnedCommit);
  if (initialHeadCheck.kind !== "ready") {
    return initialHeadCheck;
  }

  const inspections = await Promise.all(
    paths.map(async (path) => ({
      path,
      inspection: await inspectPinnedRegularFile(authority, pinnedCommit, path),
    })),
  );
  const indexInfo: string[] = [];
  for (const { inspection } of inspections) {
    switch (inspection.kind) {
      case "regular-file":
        indexInfo.push(inspection.indexInfo);
        break;
      case "symlink":
        return { kind: "denied", code: "symlink", path: inspection.path };
      case "not-regular-file":
        return { kind: "denied", code: "not-regular-file", path: inspection.path };
      case "multiple-entries":
        return { kind: "denied", code: "multiple-entries", path: inspection.path };
      case "unavailable":
        return { kind: "unavailable", path: inspection.path };
      case "pinned-commit-unavailable":
        return { kind: "unavailable", code: "pinned-commit-unavailable" };
    }
  }

  const beforeMutationHeadCheck = await checkPinnedWorkspaceHead(authority, pinnedCommit);
  if (beforeMutationHeadCheck.kind !== "ready") {
    return beforeMutationHeadCheck;
  }

  const materialization = await materializePinnedPaths(
    authority,
    paths,
    indexInfo.join(""),
    isReadOnly,
  );
  if (materialization.kind === "unavailable") {
    return { kind: "unavailable", code: "workspace-unavailable" };
  }

  return { kind: "approved", disclosedPaths: materialization.disclosedPaths };
}

/** Apply a role's validated initial selection without exposing unselected paths. */
export async function applyInitialProgressiveProjection(
  workspacePath: string,
  policy: ProgressiveDisclosurePolicy,
): Promise<void> {
  if (policy.initial_paths.length === 0) {
    throw new ProgressiveProjectionError(
      "initial progressive projection requires at least one path",
    );
  }
  try {
    await execFileAsync(
      "git",
      ["sparse-checkout", "set", "--no-cone", "--", ...policy.initial_paths],
      { cwd: workspacePath },
    );
  } catch (cause) {
    throw new ProgressiveProjectionError(
      `failed to apply initial progressive projection in '${workspacePath}': ${(cause as Error).message}`,
      { cause },
    );
  }
}
