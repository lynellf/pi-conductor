/**
 * Tests for delegation/recovery-lock.ts — atomic per-run execution lock.
 * Phase 3 Task 6 / B1 verification.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  acquireResumeLock,
  RESUME_LOCK_IN_PROGRESS,
  ResumeLockError,
} from "../../../src/host/delegation/recovery-lock.js";

// ─── Fixtures ─────────────────────────────────────────────────────────

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "pi-conductor-recovery-lock-"));
});

/** Create the state directory and return its path. */
async function makeStateDir(name: string): Promise<string> {
  const stateDir = join(workdir, name);
  await mkdir(stateDir, { recursive: true });
  return stateDir;
}

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

// ─── Tests ─────────────────────────────────────────────────────────────

describe("acquireResumeLock", () => {
  test("acquires lock on first call; releases cleanly", async () => {
    const stateDir = await makeStateDir("run-1");
    const lock = await acquireResumeLock(stateDir);
    expect(lock).toBeDefined();
    expect(typeof lock.release).toBe("function");

    await lock.release();

    // Lock file should be gone after release.
    const lockPath = join(stateDir, ".resume.lock");
    const { access } = await import("node:fs/promises");
    await expect(access(lockPath)).rejects.toThrow("ENOENT");
  });

  test("second concurrent acquire for same state dir throws ResumeLockError", async () => {
    const stateDir = await makeStateDir("run-2");

    const lock1 = await acquireResumeLock(stateDir);
    await expect(acquireResumeLock(stateDir)).rejects.toThrow(ResumeLockError);

    await lock1.release();
  });

  test("ResumeLockError carries correct code and message", async () => {
    const stateDir = await makeStateDir("run-3");
    await acquireResumeLock(stateDir);

    try {
      await acquireResumeLock(stateDir);
      expect.unreachable("Should have thrown");
    } catch (cause) {
      expect(cause).toBeInstanceOf(ResumeLockError);
      const err = cause as ResumeLockError;
      expect(err.code).toBe(RESUME_LOCK_IN_PROGRESS);
      expect(err.message).toContain(stateDir);
      expect(err.message).toContain(".resume.lock");
    }
  });

  test("lock file is removed on normal exit (implicit via release)", async () => {
    const stateDir = await makeStateDir("run-4");
    const lock = await acquireResumeLock(stateDir);
    await lock.release();

    const lockPath = join(stateDir, ".resume.lock");
    const { access } = await import("node:fs/promises");
    await expect(access(lockPath)).rejects.toThrow("ENOENT");
  });

  test("second acquire in same process is rejected", async () => {
    const stateDir = await makeStateDir("run-5");

    // First acquire.
    const lock1 = await acquireResumeLock(stateDir);

    // Second acquire in the same process — the file already exists, so
    // `open(..., "wx")` throws EEXIST.
    await expect(acquireResumeLock(stateDir)).rejects.toThrow(ResumeLockError);

    await lock1.release();
  });

  test("missing state directory throws the underlying error (not in_progress)", async () => {
    const nonexistent = join(workdir, "does-not-exist", "nested", "run-6");
    await expect(acquireResumeLock(nonexistent)).rejects.toThrow();
  });

  test("release is idempotent — second release is a no-op", async () => {
    const stateDir = await makeStateDir("run-7");
    const lock = await acquireResumeLock(stateDir);
    await lock.release();
    // Second release should not throw.
    await lock.release();
  });

  test("lock path is deterministic and derived from runStateDir", async () => {
    const stateDir = await makeStateDir("my-nested/run-dir");
    const lock = await acquireResumeLock(stateDir);
    const lockPath = join(stateDir, ".resume.lock");

    // Verify the lock file exists.
    const { access } = await import("node:fs/promises");
    await expect(access(lockPath)).resolves.not.toThrow();

    await lock.release();
  });
});

describe("concurrent resume safety", () => {
  test("sequential acquires: first succeeds, second is rejected", async () => {
    const stateDir = await makeStateDir("run-8");

    // First acquire.
    const lock1 = await acquireResumeLock(stateDir);

    // Sequential second acquire should fail.
    await expect(acquireResumeLock(stateDir)).rejects.toThrow(ResumeLockError);

    await lock1.release();
  });

  test("release then re-acquire succeeds", async () => {
    const stateDir = await makeStateDir("run-9");

    const lock1 = await acquireResumeLock(stateDir);
    await lock1.release();

    // Should be able to re-acquire after release.
    const lock2 = await acquireResumeLock(stateDir);
    expect(lock2).toBeDefined();
    await lock2.release();
  });
});
