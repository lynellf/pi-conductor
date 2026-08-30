/**
 * Issue #70 — test-only isolated agent-dir helper.
 *
 * `createAgentSession` defaults its `agentDir` to `~/.pi/agent`, and
 * `ProductionHost` defaults `isolatedAgentDir` to `getAgentDir()` when
 * no `agentDir` is passed. Both leak the developer's real
 * `~/.pi/agent` (extensions, skills, settings) into the test process.
 * On a machine with user extensions installed (e.g.
 * `pi-conductor-analytics-plugin`), the test suite becomes a function
 * of the developer's home directory and any delayed callback fired
 * from a user extension can surface as a flaky
 * unhandled-rejection/uncaughtException in the test worker — the
 * exact failure mode in the issue.
 *
 * The fix is plumbing: every test that spawns a real SDK session must
 * pass an explicit `agentDir` pointing at a fresh, empty `mkdtemp`.
 * This module owns that contract so every leak site consumes the same
 * API and the same cleanup discipline.
 *
 * ## API
 *
 * - {@link makeIsolatedAgentDir} — sync `mkdtemp` under `os.tmpdir()`.
 *   Returns a fresh empty directory. Synchronous so callers can wire it
 *   into the synchronous `ProductionHost` constructor (per-test
 *   `beforeEach` works because `beforeEach` accepts sync callbacks).
 * - {@link rmIsolatedAgentDir} — async `rm({ recursive, force })`.
 *   Safe to call on an already-removed path; idempotent.
 * - {@link trackIsolatedAgentDir} — register a per-test cleanup via
 *   Vitest's `onTestFinished` that removes the given dir at the end
 *   of the *current* test. Convenience for fixtures that allocate
 *   inside the test (no `beforeEach`).
 * - {@link makeAndTrackIsolatedAgentDir} — `mkdtemp` + register the
 *   cleanup in one call. The fixture path; lets `makeHost(...)` style
 *   helpers allocate-and-cleanup without each test wiring `afterEach`.
 *
 * ## Granularity decision: per-test
 *
 * Per-test `mkdtemp` keeps tests hermetic (no cross-test extension
 * leakage through stale `mkdtemp` siblings that survived a crashed
 * `rm`) and matches the existing per-test `workdir` precedent across
 * the suite (`tests/host/production-host-factory.test.ts`,
 * `tests/host/e2e.test.ts`, etc.). The cost is one extra `mkdir`/`rm`
 * per test; for a 1556-test suite run on a single fork, this is
 * measured in tens of milliseconds and dominated by the SDK module
 * load.
 *
 * ## Production runtime stays unchanged
 *
 * This helper is test-only. Production `src/` code never imports it.
 */

import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

/**
 * Allocate a fresh, empty directory suitable for use as an isolated
 * SDK agent dir.
 *
 * The directory is created under `os.tmpdir()` with the given prefix
 * (default `"pi-conductor-isolated-agent-"`) and contains no user
 * extensions, settings, or auth — any SDK extension runner spawned
 * against this dir sees an empty agent dir and short-circuits
 * before reading the developer's real `~/.pi/agent`.
 *
 * Synchronous so callers can wire it into a `ProductionHost` ctor
 * inside a `beforeEach` callback (or any sync setup point).
 *
 * @param prefix - `mkdtemp` prefix. Default includes the package
 *   name so the temp dir is identifiable in `ls /tmp`.
 * @returns Absolute path to the new empty directory.
 */
export function makeIsolatedAgentDir(prefix?: string): string {
  return mkdtempSync(join(tmpdir(), prefix ?? "pi-conductor-isolated-agent-"));
}

/**
 * Remove a previously-allocated isolated agent dir. Best-effort:
 * `rm({ recursive, force: true })` swallows `ENOENT` so calling it
 * twice (or after a test already cleaned up) is safe.
 *
 * @param dir - Path returned by {@link makeIsolatedAgentDir}.
 */
export async function rmIsolatedAgentDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/**
 * Register a per-test cleanup via Vitest's `onTestFinished` that
 * removes the given dir at the end of the current test. Safe to
 * call multiple times — each registration cleans its own dir.
 * Idempotent on already-removed paths.
 *
 * Note: scoped to the *current* test (`onTestFinished` binds to
 * `getCurrentTest()`), not the enclosing `describe` like
 * `afterEach`. This prevents N cleanups from accumulating on the
 * same suite and leaving stale dirs in `os.tmpdir()` after the
 * suite finishes.
 *
 * @param dir - Path returned by {@link makeIsolatedAgentDir}.
 */
export function trackIsolatedAgentDir(dir: string): void {
  onTestFinished(async () => {
    await rmIsolatedAgentDir(dir);
  });
}

/**
 * Convenience: `mkdtemp` + register cleanup in one call. Use this
 * from fixture helpers (`makeHost(...)`) that allocate an isolated
 * agent dir per call without requiring the caller to wire up
 * `beforeEach`/`afterEach`.
 *
 * @param prefix - Optional `mkdtemp` prefix override.
 * @returns Absolute path to the new empty directory. Cleaned up
 *   automatically at the end of the current test.
 */
export function makeAndTrackIsolatedAgentDir(prefix?: string): string {
  const dir = makeIsolatedAgentDir(prefix);
  trackIsolatedAgentDir(dir);
  return dir;
}
