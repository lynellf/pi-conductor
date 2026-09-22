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
 *   conduct resume [--non-interactive] [--log-dir <path>] [--json]
 *     <manifestPath> <runId>
 *
 * Exit codes:
 *   0 — run completed successfully or was explicitly aborted
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
 * `ModelRegistry`. The bootstrap in `conduct.ts` loads this module only after
 * registering CLI peer resolution. Imports by tests do not execute main().
 *
 * ## Module size
 *
 * CLI dispatch (argv parsing + start/resume/continuity/reconcile
 * routing) stays here as one coherent surface; run/output helpers live
 * in `cli-run-shared.ts` and UI/signal adapters in sibling modules.
 * Kept under the 500 LOC allowance with that split justification;
 * orchestration lives in `src/host/`.
 */

import type { Readable, Writable } from "node:stream";

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  type ResumeRunOptions,
  type RunHandle,
  resumeRun,
  type StartRunOptions,
  startRun,
} from "../index.js";
import { runContinuityCli } from "./cli-continuity.js";
import { createCliModelRegistry } from "./cli-model-registry.js";
import { runReconcileCli } from "./cli-reconcile.js";
import { prepareRunContext, runStarterCommand } from "./cli-run-shared.js";
import { type CliSignalSource, processSignalSource } from "./cli-signals.js";

export type { CliJsonResult } from "./cli-run-shared.js";

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
  /**
   * `resumeRun` impl. Only used when the command is `resume`; omitted by
   * callers of `runCli` that only ever start runs. Tests pass a mock that
   * resolves a fake handle.
   */
  readonly resumeRun?: (
    manifestPath: string,
    runId: string,
    opts: ResumeRunOptions,
  ) => Promise<RunHandle>;
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

// ─── Argv parsing ──────────────────────────────────────────────────────

const USAGE = [
  "Usage: conduct [--non-interactive] [--log-dir <path>] [--sandbox-approval <path>] [--controller-approval <path>] [--json] <manifestPath> <goal...>",
  "Usage: conduct resume [--non-interactive] [--log-dir <path>] [--sandbox-approval <path>] [--controller-approval <path>] [--json] <manifestPath> <run-id>",
].join("\n");

interface ParsedArgs {
  readonly command: "start" | "resume";
  readonly manifestPath: string;
  /** Present for `resume`; the run-id to resume. Always "" for `start`. */
  readonly runId?: string;
  readonly goal: string;
  readonly nonInteractive: boolean;
  readonly logDir?: string;
  readonly sandboxApproval?: string;
  readonly controllerApproval?: string;
  readonly json: boolean;
}

type ParseArgvResult =
  | { readonly ok: true; readonly args: ParsedArgs }
  | { readonly ok: false; readonly message?: string };

/**
 * Parse recognized options before the positional manifest + goal.
 * `resume` is detected as a real command before ordinary start
 * arguments: leading options, then an optional `resume` token, then
 * resume options, then `<manifestPath> <run-id>`. Once the start
 * manifest is found, every remaining word belongs to the goal so
 * legacy goals containing option-looking text are unchanged.
 */
function parseArgv(argv: readonly string[]): ParseArgvResult {
  let index = 0;
  let nonInteractive = false;
  let logDir: string | undefined;
  let sandboxApproval: string | undefined;
  let controllerApproval: string | undefined;
  let json = false;

  const parseOptions = (): ParseArgvResult | undefined => {
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
      if (arg === "--sandbox-approval") {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--"))
          return { ok: false, message: "pi-conductor: --sandbox-approval requires a path" };
        sandboxApproval = value;
        index += 2;
        continue;
      }
      if (arg === "--controller-approval") {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--"))
          return { ok: false, message: "pi-conductor: --controller-approval requires a path" };
        controllerApproval = value;
        index += 2;
        continue;
      }
      break;
    }
    return undefined;
  };

  const leadingError = parseOptions();
  if (leadingError !== undefined) return leadingError;

  let command: "start" | "resume" = "start";
  if (argv[index] === "resume") {
    command = "resume";
    index += 1;
    const resumeError = parseOptions();
    if (resumeError !== undefined) return resumeError;
  }

  const manifestPath = argv[index];
  if (!manifestPath) return { ok: false };

  if (command === "resume") {
    const runId = argv[index + 1];
    if (runId === undefined || runId.startsWith("--")) {
      return { ok: false, message: "pi-conductor: <run-id> is required for resume" };
    }
    return {
      ok: true,
      args: {
        command: "resume",
        manifestPath,
        runId,
        goal: "",
        nonInteractive,
        ...(logDir !== undefined && { logDir }),
        ...(sandboxApproval !== undefined && { sandboxApproval }),
        ...(controllerApproval !== undefined && { controllerApproval }),
        json,
      },
    };
  }

  const goalWords = argv.slice(index + 1);
  const goal = goalWords.join(" ").trim();
  if (goal.length === 0) return { ok: false };

  return {
    ok: true,
    args: {
      command: "start",
      manifestPath,
      goal,
      nonInteractive,
      ...(logDir !== undefined && { logDir }),
      ...(sandboxApproval !== undefined && { sandboxApproval }),
      ...(controllerApproval !== undefined && { controllerApproval }),
      json,
      runId: "",
    },
  };
}

// ─── runCli ────────────────────────────────────────────────────────────

/** Run-stream deps shared by the start and resume bodies. */
interface RunStreamDeps {
  readonly cwd: string;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly signals: CliSignalSource;
  readonly console: Console;
  readonly exit: (code: number) => void;
  readonly modelRegistry: ModelRegistry;
}

/** Run the CLI with injectable deps. Returns the exit code to propagate. */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const {
    startRun: startRunImpl,
    resumeRun: resumeRunImpl,
    modelRegistry,
    console: out,
    exit,
    cwd,
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    signals = processSignalSource,
  } = deps;

  if (argv[0] === "continuity-report") {
    return runContinuityCli(argv, out);
  }

  if (argv[0] === "reconcile-tools") {
    return runReconcileCli(argv, out);
  }

  const parseResult = parseArgv(argv);
  if (!parseResult.ok) {
    if (parseResult.message !== undefined) out.error(parseResult.message);
    out.error(USAGE);
    exit(2);
    return 2;
  }
  const parsed = parseResult.args;

  if (parsed.command === "resume") {
    if (resumeRunImpl === undefined) {
      out.error("resumeRun is not available in this CLI dependency set");
      exit(1);
      return 1;
    }
    return runResume(parsed, {
      resumeRun: resumeRunImpl,
      cwd,
      stdin,
      stdout,
      stderr,
      signals,
      console: out,
      exit,
      modelRegistry,
    });
  }

  return runStart(parsed, {
    startRun: startRunImpl,
    cwd,
    stdin,
    stdout,
    stderr,
    signals,
    console: out,
    exit,
    modelRegistry,
  });
}

interface StartCommandDeps extends RunStreamDeps {
  readonly startRun: (manifestPath: string, opts: StartRunOptions) => Promise<RunHandle>;
}

interface ResumeCommandDeps extends RunStreamDeps {
  readonly resumeRun: (
    manifestPath: string,
    runId: string,
    opts: ResumeRunOptions,
  ) => Promise<RunHandle>;
}

/** Shared preparation for the start/resume bodies. */
async function prepareFromParsed(parsed: ParsedArgs, deps: RunStreamDeps) {
  return prepareRunContext({
    cwd: deps.cwd,
    manifestPath: parsed.manifestPath,
    logDir: parsed.logDir,
    sandboxApproval: parsed.sandboxApproval,
    controllerApproval: parsed.controllerApproval,
    nonInteractive: parsed.nonInteractive,
    json: parsed.json,
    stdin: deps.stdin,
    stdout: deps.stdout,
    stderr: deps.stderr,
    modelRegistry: deps.modelRegistry,
    console: deps.console,
    exit: deps.exit,
  });
}

/** Normal start: shared preparation, `startRun`, one event, shared terminal. */
async function runStart(parsed: ParsedArgs, deps: StartCommandDeps): Promise<number> {
  const { stdout, signals, console: out, exit, modelRegistry } = deps;
  const prepared = await prepareFromParsed(parsed, deps);
  if (prepared.ok === false) return prepared.exitCode;
  const { manifestAbs, hostFactory } = prepared.context;
  return runStarterCommand({
    prepared: prepared.context,
    start: () =>
      deps.startRun(manifestAbs, {
        goal: parsed.goal,
        hostFactory,
        modelRegistry,
        baseDir: prepared.context.baseDir,
      }),
    stdout,
    signals,
    exit,
    console: out,
    json: parsed.json,
  });
}

/** Resume: same preparation/terminal as start with `goal: ""` via `resumeRun`. */
async function runResume(parsed: ParsedArgs, deps: ResumeCommandDeps): Promise<number> {
  const { stdout, signals, console: out, exit, modelRegistry } = deps;
  const prepared = await prepareFromParsed(parsed, deps);
  if (prepared.ok === false) return prepared.exitCode;
  const { manifestAbs, hostFactory } = prepared.context;
  return runStarterCommand({
    prepared: prepared.context,
    start: () =>
      deps.resumeRun(manifestAbs, String(parsed.runId ?? ""), {
        goal: "",
        hostFactory,
        baseDir: prepared.context.baseDir,
        modelRegistry,
      }),
    stdout,
    signals,
    exit,
    console: out,
    json: parsed.json,
  });
}

// ─── Entrypoint ────────────────────────────────────────────────────────

/**
 * Default deps filled in for the entrypoint path. Tests bypass
 * this entirely by calling `runCli(argv, deps)` directly.
 */
export async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  if (argv[0] === "continuity-report") {
    return runContinuityCli(argv, globalThis.console);
  }
  if (argv[0] === "reconcile-tools") {
    return runReconcileCli(argv, globalThis.console);
  }
  return runCli(argv, {
    startRun,
    resumeRun,
    modelRegistry: await createCliModelRegistry(),
    console: globalThis.console,
    exit: (code) => process.exit(code),
    cwd: process.cwd(),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
