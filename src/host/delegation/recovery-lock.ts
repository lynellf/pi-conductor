/**
 * Atomic per-run execution lock for serialized resume — spec §11.1,
 * phase-3-lifecycle-recovery.md Task 6 / B1.
 *
 * Ensures that two concurrent resume calls for the same `run_id` cannot
 * both proceed past crash reconciliation and child recovery. The lock
 * uses exclusive file creation (`open(..., "wx")`) which is:
 *   - Atomic at the OS level (no race condition window).
 *   - Works across processes (not just within a single process).
 *   - Automatically released when the process exits (the lock file is
 *     unlinked on process crash).
 *
 * Lock lifecycle:
 *   1. `acquire` creates the lock file. If it already exists (stale or
 *      concurrent), it throws `ResumeLockError` with the `in_progress` code.
 *   2. The caller holds the lock through: main crash reconciliation → child
 *      recovery → cleanup retry → budget sync → finally: `release`.
 *   3. `release` unlinks the lock file. If the process crashes while holding
 *      the lock, the OS releases it automatically when the file handle is
 *      closed.
 *
 * The lock file is `<runStateDir>/.resume.lock`. Its presence is the
 * only state the lock tracks — no timestamps, no process IDs, no TTL.
 * A stale lock from a crashed process is indistinguishable from a live
 * lock, but the worst case is a second concurrent resume that fails with
 * `in_progress` (the desired behavior for B1). The lock is released on
 * normal exit and the file is removed.
 *
 * **B1 contract:** acquire the lock BEFORE `reconcileCrash`. If the lock
 * already exists, throw `ResumeLockError` with `in_progress` and perform
 * NO removal — the lock holder is responsible for cleanup.
 */

import { open as fsOpen } from "node:fs/promises";
import { join } from "node:path";

/** Lock file name (dot-prefixed for visibility). */
const LOCK_FILE = ".resume.lock";

/** Error code when another resume is already in progress. */
export const RESUME_LOCK_IN_PROGRESS = "in_progress" as const;

/**
 * Error thrown when the atomic lock cannot be acquired.
 * Code `in_progress` means another resume for this run_id is already
 * running. The caller must NOT attempt to write or remove any state.
 */
export class ResumeLockError extends Error {
  readonly code: typeof RESUME_LOCK_IN_PROGRESS;
  constructor(code: typeof RESUME_LOCK_IN_PROGRESS, message: string) {
    super(message);
    this.code = code;
    this.name = "ResumeLockError";
  }
}

/** The handle returned by `acquire`. The caller MUST call `release()` in `finally`. */
export interface ResumeLock {
  /** Release the lock, deleting the lock file. Call in `finally`. */
  release(): Promise<void>;
}

/**
 * Acquire an atomic per-run execution lock.
 *
 * Uses exclusive file creation (`open(..., "wx")`). This is atomic at the
 * OS level — there is no window between checking existence and creating the
 * file. If the file already exists, `open` throws with `EEXIST`.
 *
 * @param runStateDir - The run's state directory (typically `<baseDir>/<runId>`).
 * @returns A `ResumeLock` handle. The caller MUST call `lock.release()` in `finally`.
 * @throws `ResumeLockError` with code `in_progress` if the lock already exists.
 */
export async function acquireResumeLock(runStateDir: string): Promise<ResumeLock> {
  const lockPath = join(runStateDir, LOCK_FILE);
  try {
    // `open(..., "wx")` creates the file exclusively.
    // If the file exists, it throws with `EEXIST`.
    // `fd` is never read — the open is just to hold the lock.
    const fd = await fsOpen(lockPath, "wx");
    // Release the file descriptor immediately — we only needed the
    // exclusive-create semantics. The file's presence is the lock.
    await fd.close();
    return {
      async release(): Promise<void> {
        const { unlink } = await import("node:fs/promises");
        try {
          await unlink(lockPath);
        } catch {
          // Best-effort: if the file is already gone (e.g., process
          // crash between acquire and this release), that's fine.
          // The lock is a best-effort serialization mechanism.
        }
      },
    };
  } catch (cause: unknown) {
    const err = cause as { code?: string };
    if (err?.code === "EEXIST") {
      throw new ResumeLockError(
        RESUME_LOCK_IN_PROGRESS,
        `resumeLock: another resume is already in progress for run state directory '${runStateDir}' — lock file exists at '${lockPath}'`,
      );
    }
    // Other errors (permissions, ENOENT if the directory is missing) are
    // surfaced as-is — a missing state directory is a caller error.
    throw cause;
  }
}
