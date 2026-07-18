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
 *   conduct [--non-interactive] [--log-dir <path>] [--json]
 *     <manifestPath> <goal...>
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
 * Kept below the repo's ~400 LOC ceiling by placing UI and signal
 * adapters in sibling modules. Orchestration lives in `src/host/`.
 */

import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
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
import {
  type CliSignalSource,
  installCliSignalHandlers,
  processSignalSource,
} from "./cli-signals.js";
import { createCliUiContext, createNonInteractiveUiContext } from "./cli-ui.js";

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
  /** Input stream for CLI `ask_user` prompts. Defaults to `process.stdin`. */
  readonly stdin?: Readable;
  /** Output stream for CLI `ask_user` prompts. Defaults to `process.stdout`. */
  readonly stdout?: Writable;
  /** Diagnostic stream used by `ask_user` in JSON mode. Defaults to `process.stderr`. */
  readonly stderr?: Writable;
  /** Signal subscription boundary. Defaults to the current Node.js process. */
  readonly signals?: CliSignalSource;
}

/** Versioned machine-readable terminal response emitted by `conduct --json`. */
export interface CliJsonResult {
  readonly schema_version: 1;
  readonly run_id: string;
  readonly exit_reason: "done" | "session_failed" | "aborted";
  readonly final_role: string;
  readonly latest_response: {
    readonly role: string;
    readonly text: string;
    readonly completed_at: number;
  } | null;
  readonly run_stats: ReturnType<RunHandle["runStats"]>;
}

// ─── Argv parsing ──────────────────────────────────────────────────────

const USAGE =
  "Usage: conduct [--non-interactive] [--log-dir <path>] [--json] <manifestPath> <goal...>";

interface ParsedArgs {
  readonly manifestPath: string;
  readonly goal: string;
  readonly nonInteractive: boolean;
  readonly logDir?: string;
  readonly json: boolean;
}

type ParseArgvResult =
  | { readonly ok: true; readonly args: ParsedArgs }
  | { readonly ok: false; readonly message?: string };

/**
 * Parse recognized options before the positional manifest + goal.
 * Once the manifest is found, every remaining word belongs to the
 * goal so legacy goals containing option-looking text are unchanged.
 */
function parseArgv(argv: readonly string[]): ParseArgvResult {
  let index = 0;
  let nonInteractive = false;
  let logDir: string | undefined;
  let json = false;

  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "--non-interactive") {
      nonInteractive = true;
      index += 1;
      continue;
    }
    if (arg === "--json") {
      json = true;
      index += 1;
      continue;
    }
    if (arg === "--log-dir") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, message: "pi-conductor: --log-dir requires a path" };
      }
      logDir = value;
      index += 2;
      continue;
    }
    break;
  }

  const manifestPath = argv[index];
  if (!manifestPath) return { ok: false };
  const goalWords = argv.slice(index + 1);
  const goal = goalWords.join(" ").trim();
  if (goal.length === 0) return { ok: false };

  return {
    ok: true,
    args: {
      manifestPath,
      goal,
      nonInteractive,
      ...(logDir !== undefined && { logDir }),
      json,
    },
  };
}

function writeOutput(stream: Writable, value: string): Promise<void> {
  return new Promise((resolveWrite, rejectWrite) => {
    stream.write(value, (error) => {
      if (error !== null && error !== undefined) {
        rejectWrite(error);
        return;
      }
      resolveWrite();
    });
  });
}

// ─── runCli ────────────────────────────────────────────────────────────

/**
 * Run the CLI with injectable deps. Returns the exit code the
 * caller should propagate. Never calls `process.exit` itself —
 * the entrypoint at the bottom of this file does that. Tests
 * pass a recording `exit` and assert on the returned code +
 * recorded codes.
 *
 * Warnings from the load-time `unregistered-provider` check are
 * written to stderr before the run begins.
 */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const {
    startRun: startRunImpl,
    modelRegistry,
    console: out,
    exit,
    cwd,
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    signals = processSignalSource,
  } = deps;

  const parseResult = parseArgv(argv);
  if (!parseResult.ok) {
    if (parseResult.message !== undefined) out.error(parseResult.message);
    out.error(USAGE);
    exit(2);
    return 2;
  }
  const parsed = parseResult.args;

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

  let baseDir: string | undefined;
  if (parsed.logDir !== undefined) {
    baseDir = resolve(cwd, parsed.logDir);
    try {
      await mkdir(baseDir, { recursive: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      out.error(`pi-conductor: Cannot create log directory '${parsed.logDir}': ${message}`);
      return 1;
    }
  }

  const uiContext = parsed.nonInteractive
    ? createNonInteractiveUiContext()
    : createCliUiContext(stdin, parsed.json ? stderr : stdout);

  // Build a host factory that constructs a `ProductionHost` from
  // the registry + cwd. The factory is called once per `startRun`
  // invocation — the host is bound to a single run; it is NOT
  // reused across resumes.
  const hostFactory = (factoryCtx: HostFactoryContext): Host =>
    createProductionHost({
      extension: { modelRegistry, cwd, uiContext },
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
      modelRegistry,
      ...(baseDir !== undefined && { baseDir }),
    });

    const removeSignalHandlers = installCliSignalHandlers({
      handle,
      source: signals,
      exit,
      onAbortError: (error, signal) => {
        const message = error instanceof Error ? error.message : String(error);
        out.error(`pi-conductor: abort requested by ${signal} failed: ${message}`);
      },
    });

    try {
      // Surface any load-time provider-registration warnings (advisory only).
      // Warnings are printed to stderr before `runLoop` so the user sees
      // the preflight result before any runtime errors. The aggregated
      // message names every affected role + entry.
      const unregisteredWarnings = handle.loadedManifest.warnings.filter(
        (w) => w.code === "unregistered-provider",
      );
      if (unregisteredWarnings.length > 0) {
        const entries = unregisteredWarnings.map((w) => w.message).join("; ");
        out.error(
          `pi-conductor: ${unregisteredWarnings.length} unregistered provider warning(s): ${entries}`,
        );
      }

      const { finalCheckpoint, exitReason } = await handle.completion();
      if (parsed.json) {
        const latestResponse = handle.latestResponse();
        const result: CliJsonResult = {
          schema_version: 1,
          run_id: handle.runId,
          exit_reason: exitReason,
          final_role: finalCheckpoint.current_role,
          latest_response:
            latestResponse === null
              ? null
              : {
                  role: latestResponse.role,
                  text: latestResponse.text,
                  completed_at: latestResponse.completedAt,
                },
          run_stats: handle.runStats(),
        };
        await writeOutput(stdout, `${JSON.stringify(result)}\n`);
      } else {
        out.log(
          `pi-conductor: run_id=${handle.runId} reached state=${finalCheckpoint.current_role} reason=${exitReason}`,
        );
      }
      return 0;
    } finally {
      removeSignalHandlers();
    }
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
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
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
