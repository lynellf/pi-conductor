/**
 * Shared run/output helpers for the standalone `conduct` CLI (issue #134).
 *
 * Private to `src/bin/` — not exported from the public barrel. Both the
 * normal start and `resume` commands build the same production host
 * factory, emit the same immediate `run_started` NDJSON event, and render
 * the same terminal result. Keeping that path in one module removes the
 * start/resume duplication that previously lived in `cli-main.ts` and
 * keeps each CLI module under the repository size convention.
 */

import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";

import type { ExtensionUIContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { loadControllerHostApproval } from "../host/controller/host-approval.js";
import type { SandboxHostApproval } from "../host/execution/sandbox/host-approval.js";
import { loadSandboxHostApproval } from "../host/execution/sandbox/host-approval.js";
import {
  createProductionHost,
  type Host,
  type HostFactoryContext,
  type RunHandle,
} from "../index.js";
import { resolveCliBaseDir } from "./cli-base-dir.js";
import { type CliSignalSource, installCliSignalHandlers } from "./cli-signals.js";
import { createCliUiContext, createNonInteractiveUiContext } from "./cli-ui.js";

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

interface RunApprovalOptions {
  readonly cwd: string;
  readonly sandboxApproval?: string | undefined;
  readonly controllerApproval?: string | undefined;
}

type RunApprovalOutcome =
  | {
      readonly ok: true;
      readonly error?: never;
      readonly sandboxHostApproval?: SandboxHostApproval | undefined;
      readonly loadCurrentControllerApproval?:
        | (() => ReturnType<typeof loadControllerHostApproval>)
        | undefined;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly sandboxHostApproval?: never;
      readonly loadCurrentControllerApproval?: never;
    };

type HostContext = {
  readonly cwd: string;
  readonly baseDir: string;
  readonly modelRegistry: ModelRegistry;
  readonly uiContext: ExtensionUIContext;
  readonly sandboxHostApproval?: SandboxHostApproval | undefined;
  readonly loadCurrentControllerApproval?:
    | (() => ReturnType<typeof loadControllerHostApproval>)
    | undefined;
};

async function loadRunApprovals(options: RunApprovalOptions): Promise<RunApprovalOutcome> {
  let sandboxHostApproval: SandboxHostApproval | undefined;
  if (options.sandboxApproval !== undefined) {
    try {
      sandboxHostApproval = await loadSandboxHostApproval(
        resolve(options.cwd, options.sandboxApproval),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `invalid sandbox approval: ${message}` };
    }
  }

  let loadCurrentControllerApproval:
    | (() => ReturnType<typeof loadControllerHostApproval>)
    | undefined;
  if (options.controllerApproval !== undefined) {
    const approvalPath = resolve(options.cwd, options.controllerApproval);
    loadCurrentControllerApproval = () => loadControllerHostApproval(approvalPath);
    try {
      await loadCurrentControllerApproval();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `invalid controller approval: ${message}` };
    }
  }

  return {
    sandboxHostApproval,
    loadCurrentControllerApproval,
  } as RunApprovalOutcome;
}

/**
 * The production `Host` factory for a run. Built from the resolved base
 * directory + the run's model registry / UI context / approval pair. The
 * factory is called once per run start — the host is bound to a single
 * run and is never reused across resumes.
 */
function createRunHostFactory(hostContext: HostContext): (ctx: HostFactoryContext) => Host {
  return (ctx: HostFactoryContext): Host =>
    createProductionHost({
      extension: {
        modelRegistry: hostContext.modelRegistry,
        cwd: hostContext.cwd,
        uiContext: hostContext.uiContext,
        ...(hostContext.sandboxHostApproval === undefined
          ? {}
          : { sandboxHostApproval: hostContext.sandboxHostApproval }),
        ...(hostContext.loadCurrentControllerApproval === undefined
          ? {}
          : { loadControllerHostApproval: hostContext.loadCurrentControllerApproval }),
      },
      run: {
        log: ctx.log,
        loadedManifest: ctx.loadedManifest,
        runId: ctx.runId,
        sessionDir: join(hostContext.baseDir, ctx.runId, "sessions"),
      },
    });
}

/** Input for preparing the shared run context (manifest + base dir + host). */
export interface PrepareRunInput {
  readonly cwd: string;
  readonly manifestPath: string;
  readonly logDir?: string | undefined;
  readonly sandboxApproval?: string | undefined;
  readonly controllerApproval?: string | undefined;
  readonly nonInteractive: boolean;
  readonly json: boolean;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly modelRegistry: ModelRegistry;
  readonly console: Console;
  readonly exit: (code: number) => void;
}

/** Prepared host context shared by the start and resume commands. */
export interface PreparedRun {
  readonly manifestAbs: string;
  readonly baseDir: string;
  readonly hostFactory: (ctx: HostFactoryContext) => Host;
  readonly uiContext: ExtensionUIContext;
}

export type PrepareRunOutcome =
  | { readonly ok: true; readonly context: PreparedRun }
  | { readonly ok: false; readonly exitCode: 1 | 3 };

/**
 * Resolve the manifest, durable base directory, approvals, UI context,
 * and production host factory shared by start and resume. Reports the
 * same errors and exit codes as the original inline path: exit 3 for a
 * missing manifest (via `exit`), exit 1 for base-dir/approval failures.
 */
export async function prepareRunContext(input: PrepareRunInput): Promise<PrepareRunOutcome> {
  const manifestAbs = resolve(input.cwd, input.manifestPath);
  try {
    await access(manifestAbs);
  } catch {
    input.console.error(`Manifest not found: ${input.manifestPath}`);
    input.exit(3);
    return { ok: false, exitCode: 3 };
  }

  const baseDirOutcome = await resolveCliBaseDir(input.cwd, input.logDir);
  if (baseDirOutcome.ok === false) {
    input.console.error(`pi-conductor: ${baseDirOutcome.error}`);
    return { ok: false, exitCode: 1 };
  }
  const baseDir = baseDirOutcome.baseDir;

  const approvalOutcome = await loadRunApprovals({
    cwd: input.cwd,
    sandboxApproval: input.sandboxApproval,
    controllerApproval: input.controllerApproval,
  });
  if (approvalOutcome.ok === false) {
    input.console.error(`pi-conductor: ${approvalOutcome.error}`);
    return { ok: false, exitCode: 1 };
  }

  const uiContext = input.nonInteractive
    ? createNonInteractiveUiContext()
    : createCliUiContext(input.stdin, input.json ? input.stderr : input.stdout);

  const hostFactory = createRunHostFactory({
    cwd: input.cwd,
    baseDir,
    modelRegistry: input.modelRegistry,
    uiContext,
    sandboxHostApproval: approvalOutcome.sandboxHostApproval,
    loadCurrentControllerApproval: approvalOutcome.loadCurrentControllerApproval,
  });

  return { ok: true, context: { manifestAbs, baseDir, hostFactory, uiContext } };
}

/**
 * Write exactly one `run_started` NDJSON event to stdout. Callers invoke
 * this immediately after `startRun`/`resumeRun` resolves and before
 * signal registration/completion waiting so the run is discoverable
 * while still running. `log_dir` is the resolved absolute base dir.
 */
export async function emitRunStarted(
  stdout: Writable,
  runId: string,
  logDir: string,
): Promise<void> {
  await writeOutput(
    stdout,
    `${JSON.stringify({
      schema_version: 1,
      event: "run_started",
      run_id: runId,
      log_dir: logDir,
    })}\n`,
  );
}

/** Input for awaiting a run handle and rendering its terminal result. */
export interface ExecuteRunInput {
  readonly handle: RunHandle;
  readonly signals: CliSignalSource;
  readonly exit: (code: number) => void;
  readonly console: Console;
  readonly stdout: Writable;
  readonly json: boolean;
}

/** Input for the shared starter path (one event + terminal) used by start/resume. */
export interface StarterCommandInput {
  readonly prepared: PreparedRun;
  readonly start: () => Promise<RunHandle>;
  readonly stdout: Writable;
  readonly signals: CliSignalSource;
  readonly exit: (code: number) => void;
  readonly console: Console;
  readonly json: boolean;
}

/**
 * Resolve one starter handle into exactly one immediate `run_started`
 * event plus the shared signal/terminal path. Preserves stdout error
 * handling: write failures reject so the caller reports exit 1.
 */
export async function runStarterCommand(input: StarterCommandInput): Promise<number> {
  try {
    const handle = await input.start();
    await emitRunStarted(input.stdout, handle.runId, input.prepared.baseDir);
    return await executeRunHandle({
      handle,
      signals: input.signals,
      exit: input.exit,
      console: input.console,
      stdout: input.stdout,
      json: input.json,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    input.console.error(`pi-conductor: ${message}`);
    return 1;
  }
}

/**
 * Await `handle.completion()` under the shared signal/warning/terminal
 * path. Installs first-signal abort handling, surfaces advisory
 * `unregistered-provider` warnings to stderr, then renders the existing
 * terminal result (NDJSON under `--json`, human-readable otherwise).
 * Returns 1 for `session_failed`, 0 otherwise. Stdout write failures
 * reject so the caller reports them as exit 1.
 */
export async function executeRunHandle(input: ExecuteRunInput): Promise<number> {
  const { handle, signals, exit, console: out, stdout, json } = input;
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
    if (json) {
      const stats = handle.runStats();
      const terminalStats = stats.exitReason === exitReason ? stats : { ...stats, exitReason };
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
        run_stats: terminalStats,
      };
      await writeOutput(stdout, `${JSON.stringify(result)}\n`);
    } else {
      const finalization = handle.runStats().finalizationFailure;
      const finalizationDiagnostic =
        finalization === undefined
          ? ""
          : ` finalization=${finalization.phase}:${finalization.code} recovery=${
              finalization.recovery === "inspect_disposal"
                ? "inspect and stop remaining resources on original host, then start a fresh run"
                : "resume with --reset-orchestrator-context"
            } failure_detail=${finalization.diagnostic}`;
      out.log(
        `pi-conductor: run_id=${handle.runId} reached state=${finalCheckpoint.current_role} reason=${exitReason}${finalizationDiagnostic}`,
      );
    }
    return exitReason === "session_failed" ? 1 : 0;
  } finally {
    removeSignalHandlers();
  }
}
