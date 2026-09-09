/**
 * Physical executable-tool attempt controller — September execution controls §76.
 *
 * This module owns attempt identity, deadline admission, timeout recovery, and
 * durable start/terminal records. It deliberately does not replay operations.
 * The lifecycle remains together so admission, cancellation, cleanup evidence,
 * and terminal recording share one arbitration boundary; persistence and timing
 * helpers are kept in neighboring modules.
 */

import { randomUUID } from "node:crypto";
import type { ToolExecutionPolicy } from "../../manifest/execution-policy.js";
import {
  reconstructToolExecutionTimeline,
  type ToolExecutionFinishedRecord,
  type ToolExecutionRecord,
  type ToolExecutionStartedRecord,
} from "../../persistence/tool-execution.js";
import type { ToolExecutionDiagnostic } from "../../persistence/tool-execution-diagnostic.js";
import { SupervisedProcessError } from "./supervised-process.js";
import {
  hasUnconfirmedCleanup,
  settleWithinCleanupWindow,
  timeoutDelay,
} from "./tool-execution-timing.js";

export type ToolExecutionErrorCode =
  | "tool_input_invalid"
  | "tool_timeout"
  | "tool_timeout_exhausted"
  | "tool_cleanup_unconfirmed"
  | "tool_aborted"
  | "tool_failed"
  | "tool_persistence_ambiguous"
  | "tool_closed"
  | "tool_resume_unknown_owner";

/** Structured controller failure surfaced at the model boundary. */
export class ToolExecutionError extends Error {
  readonly code: ToolExecutionErrorCode;
  readonly cleanup: "confirmed" | "unconfirmed" | "not-started";
  readonly executionId: string | undefined;
  readonly diagnostic: ToolExecutionDiagnostic | undefined;

  constructor(
    code: ToolExecutionErrorCode,
    message: string,
    options?: {
      readonly cleanup?: "confirmed" | "unconfirmed" | "not-started";
      readonly executionId?: string;
      readonly diagnostic?: ToolExecutionDiagnostic;
      readonly cause?: unknown;
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ToolExecutionError";
    this.code = code;
    this.cleanup = options?.cleanup ?? "not-started";
    this.executionId = options?.executionId;
    this.diagnostic = options?.diagnostic;
  }
}

export interface ToolExecutionScope {
  readonly executionId: string;
  readonly supervisionId: string;
  readonly signal: AbortSignal;
  readonly graceMs: number;
  remainingTimeoutMs(): number;
  assertOpen(): void;
}

export interface ToolExecutionRunOptions {
  readonly signal?: AbortSignal;
  /** A model-supplied deadline may shorten the pinned policy only. */
  readonly modelTimeoutSeconds?: number;
}

export interface ToolExecutionControllerOptions {
  readonly runId: string;
  readonly logicalSessionId: string;
  readonly roleSessionId: string;
  readonly policy: Readonly<Required<ToolExecutionPolicy>>;
  readonly persist: (record: ToolExecutionRecord) => void;
  readonly priorRecords?: readonly ToolExecutionRecord[];
  readonly onFatal?: (error: ToolExecutionError) => void;
  readonly idFactory?: () => string;
}

/** Stop resume when an execution has no durable terminal and no trusted owner. */
export function assertNoUnfinishedToolExecutions(records: readonly ToolExecutionRecord[]): void {
  const timeline = reconstructToolExecutionTimeline(records);
  if (timeline.unresolved.length > 0) {
    const details = timeline.unresolved
      .map(
        (entry) =>
          `execution_id=${entry.started.execution_id} tool_call_id=${entry.started.tool_call_id} supervision_id=${entry.started.supervision_id}`,
      )
      .join(", ");
    throw new ToolExecutionError(
      "tool_resume_unknown_owner",
      `unfinished tool execution has unknown ownership; cleanup must be confirmed before resume (${details}). Partial effects may remain; inspect and reconcile-tools before retrying or resuming.`,
      { cleanup: "unconfirmed" },
    );
  }
}

/** Controls one logical invocation's physical attempts across model replacement. */
export class ToolExecutionController {
  private readonly generated: ToolExecutionRecord[] = [];
  private readonly idFactory: () => string;
  private readonly priorRecords: readonly ToolExecutionRecord[];
  private readonly onFatal: ((error: ToolExecutionError) => void) | undefined;
  private closed = false;
  private readonly finishedIds = new Set<string>();
  private readonly activeAborts = new Set<AbortController>();

  constructor(private readonly options: ToolExecutionControllerOptions) {
    this.idFactory = options.idFactory ?? randomUUID;
    this.priorRecords = Object.freeze([...(options.priorRecords ?? [])]);
    this.onFatal = options.onFatal;
    this.closed = this.timeoutCountForSession() > options.policy.max_recoverable_timeouts;
  }

  get records(): readonly ToolExecutionRecord[] {
    return Object.freeze([...this.generated]);
  }

  get timeoutCount(): number {
    return this.timeoutCountForSession();
  }

  async run<T>(
    toolName: string,
    toolCallId: string,
    operation: (scope: ToolExecutionScope) => Promise<T>,
    runOptions: ToolExecutionRunOptions = {},
  ): Promise<T> {
    if (this.closed) {
      throw new ToolExecutionError("tool_closed", "tool execution admission is closed");
    }
    const timeoutSeconds = this.effectiveTimeoutSeconds(runOptions.modelTimeoutSeconds);
    const executionId = this.idFactory();
    const supervisionId = this.idFactory();
    const recoveryCount = this.timeoutCountForSession();
    const startedAt = Date.now();
    const timeoutMs = safeMilliseconds(timeoutSeconds);
    const started: ToolExecutionStartedRecord = {
      type: "tool_execution_started",
      schema_version: 1,
      run_id: this.options.runId,
      execution_id: executionId,
      supervision_id: supervisionId,
      logical_session_id: this.options.logicalSessionId,
      role_session_id: this.options.roleSessionId,
      tool_call_id: toolCallId,
      tool_name: toolName,
      timeout_ms: timeoutMs,
      recovery_count: recoveryCount,
      ts: startedAt,
    };
    this.append(started);

    const operationAbort = new AbortController();
    this.activeAborts.add(operationAbort);
    let timeoutRequested = false;
    let externalAbort = runOptions.signal?.aborted === true;
    const deadline = startedAt + timeoutMs;
    let abortReject: ((reason: unknown) => void) | undefined;
    const onExternalAbort = () => {
      externalAbort = true;
      operationAbort.abort();
      abortReject?.(new Error("external abort"));
    };
    runOptions.signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (runOptions.signal?.aborted === true) onExternalAbort();

    const scope: ToolExecutionScope = {
      executionId,
      supervisionId,
      signal: operationAbort.signal,
      graceMs: this.options.policy.termination_grace_seconds * 1_000,
      remainingTimeoutMs: () => Math.max(0, deadline - Date.now()),
      assertOpen: () => {
        if (this.closed || operationAbort.signal.aborted || Date.now() >= deadline) {
          throw new ToolExecutionError(
            externalAbort ? "tool_aborted" : this.closed ? "tool_closed" : "tool_timeout",
            externalAbort
              ? "tool execution was aborted"
              : this.closed
                ? "tool execution admission is closed"
                : "tool execution exceeded its deadline",
            { cleanup: "confirmed", executionId },
          );
        }
      },
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let operationPromise: Promise<T>;
    try {
      scope.assertOpen();
      operationPromise = Promise.resolve().then(() => operation(scope));
    } catch (error) {
      runOptions.signal?.removeEventListener("abort", onExternalAbort);
      this.activeAborts.delete(operationAbort);
      return this.failBeforeOperation(started, error);
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timeoutRequested = true;
        operationAbort.abort();
        reject(new Error("controller timeout"));
      }, timeoutDelay(timeoutMs));
    });
    const abortPromise = new Promise<never>((_, reject) => {
      abortReject = reject;
      if (externalAbort) reject(new Error("external abort"));
    });

    try {
      const result = await Promise.race([operationPromise, timeoutPromise, abortPromise]);
      if (Date.now() >= deadline) {
        timeoutRequested = true;
        operationAbort.abort();
        return this.finishTimeout(started, executionId, recoveryCount, undefined);
      }
      if (timeoutRequested)
        return this.finishTimeout(started, executionId, recoveryCount, undefined);
      if (externalAbort) return this.finishAborted(started, executionId, recoveryCount, undefined);
      this.appendFinished(started, "completed", "confirmed");
      return result;
    } catch (error) {
      if (error instanceof ToolExecutionError && error.code === "tool_persistence_ambiguous") {
        throw error;
      }
      if (error instanceof ToolExecutionError && this.finishedIds.has(executionId)) throw error;
      const timedOut =
        timeoutRequested ||
        isSupervisedTimeout(error) ||
        (error instanceof ToolExecutionError && error.code === "tool_timeout");
      const aborted =
        externalAbort ||
        isSupervisedAbort(error) ||
        (error instanceof ToolExecutionError && error.code === "tool_aborted");
      if (!timedOut && !aborted) {
        if (hasUnconfirmedCleanup(error)) {
          return this.finishUnconfirmed(started, executionId, recoveryCount, error);
        }
        return this.finishFailed(started, executionId, recoveryCount, error);
      }

      const settled = await settleWithinCleanupWindow(
        operationPromise,
        this.options.policy.termination_grace_seconds,
        (timerToClear) => {
          cleanupTimer = timerToClear;
        },
      );
      const cleanupConfirmed = settled.settled && settled.cleanup !== "unconfirmed";
      if (!cleanupConfirmed) {
        return this.finishUnconfirmed(started, executionId, recoveryCount, settled.error ?? error);
      }
      if (aborted && !timedOut) {
        return this.finishAborted(started, executionId, recoveryCount, settled.error ?? error);
      }
      return this.finishTimeout(started, executionId, recoveryCount, settled.error ?? error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
      runOptions.signal?.removeEventListener("abort", onExternalAbort);
      this.activeAborts.delete(operationAbort);
    }
  }

  private effectiveTimeoutSeconds(modelTimeoutSeconds: number | undefined): number {
    if (modelTimeoutSeconds === undefined) return this.options.policy.timeout_seconds;
    if (!Number.isInteger(modelTimeoutSeconds) || !Number.isFinite(modelTimeoutSeconds)) {
      throw new ToolExecutionError("tool_input_invalid", "model timeout must be a finite integer");
    }
    if (modelTimeoutSeconds <= 0 || modelTimeoutSeconds > this.options.policy.timeout_seconds) {
      throw new ToolExecutionError(
        "tool_input_invalid",
        "model timeout must be positive and no greater than the pinned deadline",
      );
    }
    return modelTimeoutSeconds;
  }

  private timeoutCountForSession(): number {
    return [...this.priorRecords, ...this.generated].filter(
      (record) =>
        record.type === "tool_execution_finished" &&
        record.outcome === "timed_out" &&
        record.run_id === this.options.runId &&
        record.logical_session_id === this.options.logicalSessionId,
    ).length;
  }

  private append(record: ToolExecutionRecord): void {
    try {
      this.options.persist(record);
    } catch (cause) {
      const executionId =
        record.type === "tool_execution_started" || record.type === "tool_execution_finished"
          ? record.execution_id
          : undefined;
      const error = new ToolExecutionError(
        "tool_persistence_ambiguous",
        "tool execution persistence outcome is ambiguous; resume requires ownership reconciliation",
        { cleanup: "unconfirmed", ...(executionId === undefined ? {} : { executionId }), cause },
      );
      this.closeOnFatal(error);
      throw error;
    }
    this.generated.push(record);
  }

  private finishTimeout(
    started: ToolExecutionStartedRecord,
    executionId: string,
    _recoveryCount: number,
    cause: unknown,
  ): never {
    const priorTimeouts = this.timeoutCountForSession();
    const diagnostic = diagnosticFrom(cause);
    this.appendFinished(started, "timed_out", "confirmed", diagnostic);
    const code =
      priorTimeouts >= this.options.policy.max_recoverable_timeouts
        ? "tool_timeout_exhausted"
        : "tool_timeout";
    const error = new ToolExecutionError(code, "tool execution exceeded its deadline", {
      cleanup: "confirmed",
      executionId,
      cause,
      ...(diagnostic === undefined ? {} : { diagnostic }),
    });
    if (code === "tool_timeout_exhausted") {
      this.closeOnFatal(error);
    }
    throw error;
  }

  private finishAborted(
    started: ToolExecutionStartedRecord,
    executionId: string,
    _recoveryCount: number,
    cause: unknown,
  ): never {
    const diagnostic = diagnosticFrom(cause);
    this.appendFinished(started, "aborted", "confirmed", diagnostic);
    throw new ToolExecutionError("tool_aborted", "tool execution was aborted", {
      cleanup: "confirmed",
      executionId,
      cause,
      ...(diagnostic === undefined ? {} : { diagnostic }),
    });
  }

  private finishUnconfirmed(
    started: ToolExecutionStartedRecord,
    executionId: string,
    _recoveryCount: number,
    cause: unknown,
  ): never {
    const diagnostic = diagnosticFrom(cause);
    this.appendFinished(started, "cleanup_unconfirmed", "unconfirmed", diagnostic);
    const error = new ToolExecutionError(
      "tool_cleanup_unconfirmed",
      "tool execution cleanup could not be confirmed",
      {
        cleanup: "unconfirmed",
        executionId,
        cause,
        ...(diagnostic === undefined ? {} : { diagnostic }),
      },
    );
    this.closeOnFatal(error);
    throw error;
  }

  private finishFailed(
    started: ToolExecutionStartedRecord,
    executionId: string,
    _recoveryCount: number,
    cause: unknown,
  ): never {
    this.appendFinished(started, "failed", "confirmed");
    throw new ToolExecutionError("tool_failed", "tool execution failed", {
      cleanup: "confirmed",
      executionId,
      cause,
    });
  }

  private failBeforeOperation(started: ToolExecutionStartedRecord, cause: unknown): never {
    this.appendFinished(started, "aborted", "confirmed");
    throw cause;
  }

  private appendFinished(
    started: ToolExecutionStartedRecord,
    outcome: ToolExecutionFinishedRecord["outcome"],
    cleanup: ToolExecutionFinishedRecord["cleanup"],
    diagnostic?: ToolExecutionFinishedRecord["diagnostic"],
  ): void {
    if (this.finishedIds.has(started.execution_id)) return;
    this.append({
      type: "tool_execution_finished",
      schema_version: 1,
      run_id: started.run_id,
      execution_id: started.execution_id,
      supervision_id: started.supervision_id,
      logical_session_id: started.logical_session_id,
      role_session_id: started.role_session_id,
      tool_call_id: started.tool_call_id,
      tool_name: started.tool_name,
      elapsed_ms: Math.max(0, Date.now() - started.ts),
      recovery_count: started.recovery_count,
      outcome,
      cleanup,
      ...(diagnostic === undefined ? {} : { diagnostic }),
      ts: Date.now(),
    });
    this.finishedIds.add(started.execution_id);
  }

  private closeOnFatal(error: ToolExecutionError): void {
    if (this.closed) return;
    this.closed = true;
    for (const abort of this.activeAborts) abort.abort();
    this.onFatal?.(error);
  }
}

function diagnosticFrom(cause: unknown): ToolExecutionFinishedRecord["diagnostic"] {
  return cause instanceof SupervisedProcessError ? cause.diagnostic : undefined;
}

function isSupervisedTimeout(error: unknown): boolean {
  return error instanceof SupervisedProcessError && error.code === "supervised-process-timeout";
}

function isSupervisedAbort(error: unknown): boolean {
  return error instanceof SupervisedProcessError && error.code === "supervised-process-aborted";
}

function safeMilliseconds(seconds: number): number {
  const milliseconds = seconds * 1_000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
    throw new ToolExecutionError(
      "tool_input_invalid",
      "tool deadline cannot be represented safely",
    );
  }
  return milliseconds;
}
