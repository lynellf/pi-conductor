import type { ToolExecutionDiagnostic } from "../../persistence/tool-execution-diagnostic.js";
import type { ProcessIdentity } from "./supervised-process-identity.js";

export type SupervisedProcessDiagnostic = ToolExecutionDiagnostic;

/** Inputs for one Linux process-group-supervised executable invocation. */
export interface SupervisedProcessOptions {
  /** Durable caller identity reserved before any process is spawned. */
  readonly executionId: string;
  readonly command?: string;
  readonly file?: string;
  readonly args?: readonly string[];
  readonly stdin?: string | Uint8Array;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly graceMs?: number;
  readonly outputLimitBytes?: number;
  readonly signal?: AbortSignal;
  /** Persist the start record before command side effects begin. */
  readonly onStart: (record: {
    readonly executionId: string;
    readonly effectiveDeadlineMs: number;
  }) => void | Promise<void>;
  /** Persist the owned process identity as soon as it is established. */
  readonly onSpawn?: (
    record: { readonly executionId: string } & ProcessIdentity,
  ) => void | Promise<void>;
  readonly onOutput?: (stream: "stdout" | "stderr", chunk: Buffer) => void;
}

/** Successful terminal result after the owned process group has settled. */
export interface SupervisedProcessResult {
  readonly outcome: "exited";
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly elapsedMs: number;
  readonly pid: number;
}

/** Stable failure codes emitted by the supervised process boundary. */
export type SupervisedProcessFailureCode =
  | "supervised-process-aborted"
  | "supervised-process-timeout"
  | "supervised-process-spawn-failed"
  | "supervised-process-unsupported";

/** Structured process-boundary failure including cleanup evidence. */
export class SupervisedProcessError extends Error {
  readonly code: SupervisedProcessFailureCode;
  readonly cleanup: "confirmed" | "unconfirmed" | "not-started";
  readonly identity: ProcessIdentity | null;
  readonly elapsedMs: number | null;
  readonly diagnostic: SupervisedProcessDiagnostic | undefined;
  constructor(
    code: SupervisedProcessFailureCode,
    message: string,
    cleanup: "confirmed" | "unconfirmed" | "not-started",
    identity: ProcessIdentity | null,
    elapsedMs: number | null = null,
    diagnostic?: SupervisedProcessDiagnostic,
  ) {
    super(message);
    this.name = "SupervisedProcessError";
    this.code = code;
    this.cleanup = cleanup;
    this.identity = identity;
    this.elapsedMs = elapsedMs;
    this.diagnostic = diagnostic;
  }
}

/** Deadline failure; callers may retry only when cleanup is confirmed. */
export class SupervisedProcessTimeoutError extends SupervisedProcessError {
  constructor(
    cleanup: "confirmed" | "unconfirmed" | "not-started",
    identity: ProcessIdentity | null,
    elapsedMs: number,
    diagnostic?: SupervisedProcessDiagnostic,
  ) {
    super(
      "supervised-process-timeout",
      "supervised process exceeded its deadline",
      cleanup,
      identity,
      elapsedMs,
      diagnostic,
    );
    this.name = "SupervisedProcessTimeoutError";
  }
}

/** Abort failure emitted only after owned cleanup settles. */
export class SupervisedProcessAbortError extends SupervisedProcessError {
  constructor(
    cleanup: "confirmed" | "unconfirmed" | "not-started",
    identity: ProcessIdentity | null,
    elapsedMs: number,
    diagnostic?: SupervisedProcessDiagnostic,
  ) {
    super(
      "supervised-process-aborted",
      "supervised process was aborted",
      cleanup,
      identity,
      elapsedMs,
      diagnostic,
    );
    this.name = "SupervisedProcessAbortError";
  }
}

/** Report whether this implementation can prove Linux process-group cleanup. */
export function isSupervisedProcessSupported(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "linux";
}
