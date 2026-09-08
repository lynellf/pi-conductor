/** Host-owned deterministic end-guard execution (§75). */

import { StringDecoder } from "node:string_decoder";
import { type EndGuardConfig, resolveEndGuardConfig } from "../manifest/end-guard.js";
import { capErrorDiagnostic } from "./bounded-diagnostic.js";

export type { EndGuardConfig } from "../manifest/end-guard.js";

import {
  isSupervisedProcessSupported,
  runSupervisedProcess,
  SupervisedProcessError,
} from "./execution/supervised-process.js";

const GRACE_MS = 2_000;
const OUTPUT_LIMIT_BYTES = 4 * 1024;

/** One host-owned guard invocation request. */
export interface EndGuardRunRequest {
  readonly attemptId: string;
  readonly supervisionId: string;
  readonly roleSessionId: string;
  readonly config: EndGuardConfig;
  readonly signal?: AbortSignal;
}

/** Terminal classification for one end-guard process. */
export type EndGuardOutcome =
  | "passed"
  | "failed"
  | "spawn_error"
  | "timed_out"
  | "aborted"
  | "cleanup_unconfirmed";

/** Bounded, host-observable result of one end-guard process. */
export interface EndGuardRunResult {
  readonly attemptId: string;
  readonly roleSessionId: string;
  readonly outcome: EndGuardOutcome;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly elapsedMs: number;
  readonly output: string;
  readonly truncated: boolean;
  readonly cleanup: "confirmed" | "unconfirmed" | "not-started";
}

interface ActiveRun {
  readonly controller: AbortController;
  readonly promise: Promise<EndGuardRunResult>;
}

function appendBounded(
  state: { chunks: Buffer[]; bytes: number; truncated: boolean },
  chunk: Buffer,
): void {
  if (chunk.byteLength === 0) return;
  const remaining = OUTPUT_LIMIT_BYTES - state.bytes;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }
  if (chunk.byteLength <= remaining) {
    state.chunks.push(chunk);
    state.bytes += chunk.byteLength;
  } else {
    const diagnostic = capErrorDiagnostic(chunk.toString("utf8"), remaining);
    const bounded = Buffer.from(diagnostic.output);
    state.chunks.push(bounded);
    state.bytes += bounded.byteLength;
    state.truncated = true;
  }
}

function outputText(state: { chunks: Buffer[] }): string {
  return Buffer.concat(state.chunks).toString("utf8");
}

/** Run and settle one trusted repository end guard at a time per primary checkout. */
export class EndGuardRunner {
  private active: (ActiveRun & { readonly roleSessionId: string }) | null = null;
  private readonly closed = new Set<string>();
  private globallyClosed = false;

  constructor(
    private readonly cwd: string,
    private readonly env?: NodeJS.ProcessEnv,
  ) {}

  /** Execute a guard with bounded combined diagnostics and confirmed cleanup. */
  run(request: EndGuardRunRequest): Promise<EndGuardRunResult> {
    if (this.globallyClosed || this.closed.has(request.roleSessionId)) {
      return Promise.reject(new Error("end guard admission is closed"));
    }
    if (this.active !== null) {
      return Promise.reject(new Error("end guard is already running for this session"));
    }
    if (request.signal?.aborted) {
      return Promise.resolve({
        attemptId: request.attemptId,
        roleSessionId: request.roleSessionId,
        outcome: "aborted",
        exitCode: null,
        signal: null,
        elapsedMs: 0,
        output: "end guard was aborted",
        truncated: false,
        cleanup: "not-started",
      });
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const output = { chunks: [] as Buffer[], bytes: 0, truncated: false };
    const promise = this.execute(request, controller, output).finally(() => {
      request.signal?.removeEventListener("abort", onAbort);
      this.active = null;
    });
    this.active = { controller, promise, roleSessionId: request.roleSessionId };
    return promise;
  }

  /** Close admission and await owned guard cleanup for a physical session. */
  async abort(roleSessionId?: string): Promise<void> {
    if (roleSessionId === undefined) this.globallyClosed = true;
    else this.closed.add(roleSessionId);
    const active = this.active;
    if (
      active !== null &&
      (roleSessionId === undefined || active.roleSessionId === roleSessionId)
    ) {
      active.controller.abort();
      await active.promise;
    }
  }

  private async execute(
    request: EndGuardRunRequest,
    controller: AbortController,
    output: { chunks: Buffer[]; bytes: number; truncated: boolean },
  ): Promise<EndGuardRunResult> {
    const startedAt = Date.now();
    let cleanup: EndGuardRunResult["cleanup"] = "not-started";
    let supervisorEntered = false;
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    if (!isSupervisedProcessSupported()) throw new Error("end guard supervision is unsupported");
    try {
      const config = resolveEndGuardConfig(request.config);
      supervisorEntered = true;
      const result = await runSupervisedProcess({
        command: config.command,
        cwd: this.cwd,
        ...(this.env !== undefined ? { env: this.env } : {}),
        executionId: request.supervisionId,
        timeoutMs: config.timeout_seconds * 1_000,
        graceMs: GRACE_MS,
        outputLimitBytes: OUTPUT_LIMIT_BYTES,
        signal: controller.signal,
        onStart: () => undefined,
        onOutput: (stream, chunk) =>
          appendBounded(output, Buffer.from(decoders[stream].write(chunk))),
      });
      cleanup = "confirmed";
      appendBounded(output, Buffer.from(decoders.stdout.end() + decoders.stderr.end()));
      if (output.chunks.length === 0) {
        const diagnostic = capErrorDiagnostic(`${result.stdout}${result.stderr}`);
        output.chunks.push(Buffer.from(diagnostic.output));
        output.bytes = Buffer.byteLength(diagnostic.output, "utf8");
        output.truncated = diagnostic.truncated || result.truncated;
      }
      return {
        attemptId: request.attemptId,
        roleSessionId: request.roleSessionId,
        outcome: result.exitCode === 0 ? "passed" : "failed",
        exitCode: result.exitCode,
        signal: result.signal,
        elapsedMs: result.elapsedMs,
        output: outputText(output),
        truncated: output.truncated || result.truncated,
        cleanup,
      };
    } catch (error) {
      appendBounded(output, Buffer.from(decoders.stdout.end() + decoders.stderr.end()));
      const processError = error instanceof SupervisedProcessError ? error : null;
      cleanup = processError?.cleanup ?? (supervisorEntered ? "unconfirmed" : "not-started");
      if (cleanup === "unconfirmed") this.globallyClosed = true;
      const outcome: EndGuardOutcome =
        cleanup === "unconfirmed"
          ? "cleanup_unconfirmed"
          : processError?.code === "supervised-process-timeout"
            ? "timed_out"
            : processError?.code === "supervised-process-aborted"
              ? "aborted"
              : "spawn_error";
      return {
        attemptId: request.attemptId,
        roleSessionId: request.roleSessionId,
        outcome,
        exitCode: null,
        signal: null,
        elapsedMs: processError?.elapsedMs ?? Date.now() - startedAt,
        output: (() => {
          if (output.chunks.length === 0) {
            const diagnostic = capErrorDiagnostic(
              error instanceof Error ? error.message : String(error),
            );
            output.chunks.push(Buffer.from(diagnostic.output));
            output.bytes = Buffer.byteLength(diagnostic.output, "utf8");
            output.truncated = diagnostic.truncated;
          }
          return outputText(output);
        })(),
        truncated: output.truncated,
        cleanup,
      };
    }
  }
}

export { isSupervisedProcessSupported };
