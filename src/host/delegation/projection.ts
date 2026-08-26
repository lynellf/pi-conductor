/** Exact delegated-child projection authority — Issue #52. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** A clean parent sparse-checkout's materialized (`H`) paths at one immutable base. */
export interface ParentMaterializedProjection {
  readonly baseCommit: string;
  readonly paths: readonly string[];
}

/** Captured delegated-child projection authority, if the batch requested one. */
export interface DelegateParentProjectionCapture {
  readonly baseCommit: string | null;
  readonly materializedPaths?: readonly string[];
}

/** Failure to capture a child projection from the clean parent checkout. */
export class ParentProjectionCaptureError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ParentProjectionCaptureError";
  }
}

/** Reject syntax that could broaden a Git sparse pattern or escape the worktree. */
export function isSafeExactProjectionPath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    return false;
  }

  return path
    .split("/")
    .every(
      (component) =>
        component !== "" &&
        component !== "." &&
        component !== ".." &&
        /^[A-Za-z0-9._-]+$/.test(component),
    );
}

/** Capture only materialized parent index entries after confirming a clean expected base. */
export async function captureMaterializedParentProjection(
  primaryCheckout: string,
  expectedBaseCommit: string,
): Promise<ParentMaterializedProjection> {
  try {
    await assertCleanExpectedBase(primaryCheckout, expectedBaseCommit);
    const { stdout } = await execFileAsync("git", ["ls-files", "-t", "-z"], {
      cwd: primaryCheckout,
    });
    // Repeat the cleanliness + HEAD check so the returned H set is tied to the
    // same clean base even if another process changed the parent while it was read.
    await assertCleanExpectedBase(primaryCheckout, expectedBaseCommit);

    const paths = new Set<string>();
    for (const entry of stdout.split("\0")) {
      // `git ls-files -t` marks ordinary materialized index entries with H;
      // skipped sparse entries are S and must never become child authority.
      if (!entry.startsWith("H ")) continue;
      const path = entry.slice(2);
      if (isSafeExactProjectionPath(path)) paths.add(path);
    }
    return Object.freeze({ baseCommit: expectedBaseCommit, paths: Object.freeze([...paths]) });
  } catch (cause) {
    if (cause instanceof ParentProjectionCaptureError) throw cause;
    throw new ParentProjectionCaptureError(
      `failed to capture materialized parent projection: ${errorMessage(cause)}`,
      { cause },
    );
  }
}

/** Capture parent H authority only when at least one task selected a child subset. */
export async function captureRequestedParentProjection(
  primaryCheckout: string,
  requestsProjection: boolean,
  gitCheck: {
    readonly isGit: boolean;
    readonly isClean: boolean;
    readonly headCommit: string | null;
  },
): Promise<DelegateParentProjectionCapture> {
  if (!requestsProjection || !gitCheck.isGit || !gitCheck.isClean || gitCheck.headCommit === null) {
    return Object.freeze({ baseCommit: gitCheck.headCommit });
  }
  const captured = await captureMaterializedParentProjection(primaryCheckout, gitCheck.headCommit);
  return Object.freeze({
    baseCommit: captured.baseCommit,
    materializedPaths: captured.paths,
  });
}

async function assertCleanExpectedBase(
  primaryCheckout: string,
  expectedBaseCommit: string,
): Promise<void> {
  const { stdout: status } = await execFileAsync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: primaryCheckout },
  );
  if (status.trim().length > 0) {
    throw new ParentProjectionCaptureError(
      "parent checkout changed while capturing delegated-child projection",
    );
  }

  const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: primaryCheckout,
  });
  if (head.trim() !== expectedBaseCommit) {
    throw new ParentProjectionCaptureError(
      `parent HEAD changed while capturing delegated-child projection (expected '${expectedBaseCommit}', received '${head.trim()}')`,
    );
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
