#!/usr/bin/env node
/**
 * `conduct` — Phase 7C.3 CLI fallback.
 *
 * A thin wrapper around `startRun` that exercises the production
 * `Host` outside of pi's TUI. The primary launch surface is the
 * extension (`/conduct <goal>` inside pi); this CLI exists for
 * non-pi consumers and for scripted runs that don't need the TUI.
 *
 * Usage:
 *   conduct <manifestPath> <goal...>
 *
 * Exit codes:
 *   0 — run reached a terminal state (success or expected failure)
 *   1 — startRun / orchestration error (model not found, manifest
 *       parse error, runtime error, etc.)
 *   2 — usage error (missing argv)
 *   3 — manifest file does not exist on disk
 *
 * ## Why this lives in src/bin and not bin/
 *
 * The conventional npm layout puts the entrypoint in `bin/`. We
 * keep it under `src/bin/` so `tsc` compiles it to `dist/bin/`
 * (and `package.json#bin` points at the built output). The
 * extension entrypoint (`extensions/conduct.ts`) is loaded by
 * pi via jiti on the TS source — pi doesn't need a build artifact.
 * The CLI is invoked by users via `node dist/bin/conduct.js` or
 * the `conduct` shim from `package.json#bin`, so a build is the
 * natural shape.
 *
 * ## Why `runCli(argv, deps)` is exported
 *
 * The CLI's job is boring — parse argv, validate the manifest
 * exists, build a host factory, call `startRun`, report the
 * outcome on stdout/stderr/exit code. We export `runCli` with
 * injectable deps so the test file can drive it without spawning
 * a subprocess or touching the real `startRun` /
 * `ModelRegistry`. The auto-execution at the bottom of this file
 * is guarded by an `import.meta.url` check so tests that import
 * `runCli` do not trigger the entrypoint.
 *
 * ## Module size
 *
 * ~120 LOC including the auto-execution guard. The CLI is
 * intentionally small; orchestration lives in `src/host/`.
 */

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

import {
  createProductionHost,
  type Host,
  type HostFactoryContext,
  type RunHandle,
  type StartRunOptions,
  startRun,
} from "../index.js";

// ─── Public types ──────────────────────────────────────────────────────

/**
 * Injectable dependencies for `runCli`. Tests pass mocks; the
 * entrypoint at the bottom of this file passes the real impls.
 * Every field is required by `runCli` (no Partial at the call
 * site) — the entrypoint fills in the defaults before invoking
 * the function.
 */
export interface CliDeps {
  /** `startRun` impl. Tests pass a mock that resolves a fake handle. */
  readonly startRun: (manifestPath: string, opts: StartRunOptions) => Promise<RunHandle>;
  /** ModelRegistry passed through to the host factory. */
  readonly modelRegistry: ModelRegistry;
  /** Console for stdout/stderr. Tests pass a recorder. */
  readonly console: Console;
  /**
   * Called when the CLI wants to terminate. Defaults to
   * `process.exit` in production; tests pass a recorder that
   * captures the code without exiting.
   */
  readonly exit: (code: number) => void;
  /** Working directory for the run. Defaults to `process.cwd()`. */
  readonly cwd: string;
}

// ─── Argv parsing ──────────────────────────────────────────────────────

const USAGE = "Usage: conduct <manifestPath> <goal...>";

/**
 * Parse argv into (manifestPath, goal). Whitespace-only goal is
 * treated as missing (the spec/plan require a non-empty goal
 * string; the run loop would otherwise surface a noisier error).
 * Returns null when args are missing or malformed.
 */
function parseArgv(argv: readonly string[]): { manifestPath: string; goal: string } | null {
  const [manifestPath, ...goalWords] = argv;
  if (!manifestPath) return null;
  const goal = goalWords.join(" ").trim();
  if (goal.length === 0) return null;
  return { manifestPath, goal };
}

// ─── runCli ────────────────────────────────────────────────────────────

/**
 * Run the CLI with injectable deps. Returns the exit code the
 * caller should propagate. Never calls `process.exit` itself —
 * the entrypoint at the bottom of this file does that. Tests
 * pass a recording `exit` and assert on the returned code +
 * recorded codes.
 */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const { startRun: startRunImpl, modelRegistry, console: out, exit, cwd } = deps;

  const parsed = parseArgv(argv);
  if (parsed === null) {
    out.error(USAGE);
    exit(2);
    return 2;
  }

  // Verify the manifest exists on disk. `startRun` would also
  // fail, but with a less specific error; fail fast with a clear
  // path so the user can fix the typo.
  const manifestAbs = resolve(cwd, parsed.manifestPath);
  try {
    await access(manifestAbs);
  } catch {
    out.error(`Manifest not found: ${parsed.manifestPath}`);
    exit(3);
    return 3;
  }

  // Build a host factory that constructs a `ProductionHost` from
  // the registry + cwd. The factory is called once per `startRun`
  // invocation — the host is bound to a single run; it is NOT
  // reused across resumes.
  const hostFactory = (factoryCtx: HostFactoryContext): Host =>
    createProductionHost({
      extension: { modelRegistry, cwd },
      run: {
        log: factoryCtx.log,
        loadedManifest: factoryCtx.loadedManifest,
        runId: factoryCtx.runId,
      },
    });

  try {
    const handle = await startRunImpl(manifestAbs, {
      goal: parsed.goal,
      hostFactory,
    });
    const { finalCheckpoint, exitReason } = await handle.completion();
    out.log(
      `pi-conductor: run_id=${handle.runId} reached state=${finalCheckpoint.current_role} reason=${exitReason}`,
    );
    return 0;
  } catch (err) {
    // Typed errors carry the role + missing value in their
    // message (Phase 7A.1 acceptance). Surfacing the full message
    // is more useful than just the error class name.
    const message = err instanceof Error ? err.message : String(err);
    out.error(`pi-conductor: ${message}`);
    return 1;
  }
}

// ─── Entrypoint ────────────────────────────────────────────────────────

/**
 * Default deps filled in for the entrypoint path. Tests bypass
 * this entirely by calling `runCli(argv, deps)` directly.
 */
async function main(): Promise<number> {
  return runCli(process.argv.slice(2), {
    startRun,
    modelRegistry: ModelRegistry.create(AuthStorage.create()),
    console: globalThis.console,
    exit: (code) => process.exit(code),
    cwd: process.cwd(),
  });
}

/**
 * Only auto-execute when this file is the entrypoint (not when
 * imported by tests). The guard compares `import.meta.url` to
 * `process.argv[1]` — the standard ESM entrypoint idiom.
 */
const isEntrypoint = (() => {
  try {
    if (!process.argv[1]) return false;
    const invoked = fileURLToPath(new URL(`file://${process.argv[1]}`));
    const self = fileURLToPath(import.meta.url);
    return invoked === self;
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  void main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      // Defensive: main() already catches startRun errors. This
      // path is for unexpected throws (e.g., out-of-memory).
      globalThis.console.error(err);
      process.exit(1);
    },
  );
}
