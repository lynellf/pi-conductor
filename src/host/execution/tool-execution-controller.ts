/** Physical executable-tool attempt controller — September execution controls §76. */

import { randomUUID } from "node:crypto";
import type { SandboxExecutionTerminal } from "../../persistence/sandbox-command.js";
import type {
  AnySandboxExecutionOwner,
  ControllerSandboxExecutionOwner,
  SandboxExecutionOwner,
} from "../../persistence/sandbox-execution.js";
import type {
  AnyToolExecutionStartedRecord,
  ControllerExecutionOrigin,
  ToolExecutionFinishedRecord,
  ToolExecutionRecord,
} from "../../persistence/tool-execution.js";
import { ExecutionAttemptTracker } from "./execution-attempt-tracker.js";
import {
  buildExecutionStart,
  diagnosticFrom,
  type ExecutionInvocation,
  effectiveTimeoutSeconds,
  executionTimeoutCount,
  isSupervisedAbort,
  isSupervisedTimeout,
  safeMilliseconds,
} from "./tool-execution-controller-support.js";
import type { SandboxToolExecutionAdapter } from "./tool-execution-lifecycle.js";
import {
  prepareControllerLifecycle,
  prepareSdkLifecycle,
} from "./tool-execution-lifecycle-admission.js";
import { buildToolExecutionTerminal } from "./tool-execution-terminal.js";
import {
  hasUnconfirmedCleanup,
  settleWithinCleanupWindow,
  timeoutDelay,
} from "./tool-execution-timing.js";

export {
  type ToolExecutionControllerOptions,
  ToolExecutionError,
  type ToolExecutionErrorCode,
  type ToolExecutionRunOptions,
  type ToolExecutionScope,
} from "./tool-execution-contract.js";
export { assertNoUnfinishedToolExecutions } from "./tool-execution-resume.js";

import {
  type ToolExecutionControllerOptions,
  ToolExecutionError,
  type ToolExecutionRunOptions,
  type ToolExecutionScope,
} from "./tool-execution-contract.js";

/** Controls one logical invocation's physical attempts across model replacement. */
export class ToolExecutionController {
  private readonly generated: ToolExecutionRecord[] = [];
  private readonly idFactory: () => string;
  private readonly priorRecords: readonly ToolExecutionRecord[];
  private readonly onFatal: ((error: ToolExecutionError) => void) | undefined;
  private closed = false;
  private readonly finishedIds = new Set<string>();
  private readonly attempts = new ExecutionAttemptTracker();
  private readonly terminalEvidence = new Map<string, () => SandboxExecutionTerminal>();

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
    return this.attempts.track(
      this.runAttempt({ kind: "sdk", toolName, toolCallId }, operation, runOptions),
    );
  }

  /** Run a controller executable with real non-SDK operation provenance. */
  async runController<T>(
    origin: ControllerExecutionOrigin,
    operation: (scope: ToolExecutionScope) => Promise<T>,
    runOptions: ToolExecutionRunOptions = {},
  ): Promise<T> {
    return this.attempts.track(
      this.runAttempt({ kind: "controller", origin }, operation, runOptions),
    );
  }

  /** Use a verified backend lifecycle while retaining controller deadlines and records (#106 §6). */
  async runLifecycle<T>(
    toolName: string,
    toolCallId: string,
    sandbox: SandboxExecutionOwner,
    adapter: SandboxToolExecutionAdapter<T>,
    runOptions: ToolExecutionRunOptions = {},
  ): Promise<T> {
    const prepared = prepareSdkLifecycle(sandbox, adapter, runOptions, {
      started: (executionId) => this.started(executionId),
      append: (record) => this.append(record),
    });
    return this.attempts.track(
      this.runAttempt(
        { kind: "sdk", toolName, toolCallId },
        prepared.operation,
        runOptions,
        prepared.owner,
        prepared.terminalEvidence,
      ),
    );
  }

  /** Run a verified controller backend while preserving its non-SDK owner identity. */
  async runControllerLifecycle<T>(
    origin: ControllerExecutionOrigin,
    sandbox: ControllerSandboxExecutionOwner,
    adapter: SandboxToolExecutionAdapter<T>,
    runOptions: ToolExecutionRunOptions = {},
  ): Promise<T> {
    const prepared = prepareControllerLifecycle(origin, sandbox, adapter, runOptions, {
      started: (executionId) => this.started(executionId),
      append: (record) => this.append(record),
    });
    return this.attempts.track(
      this.runAttempt(
        { kind: "controller", origin },
        prepared.operation,
        runOptions,
        prepared.owner,
        prepared.terminalEvidence,
      ),
    );
  }

  /** Permanently seal admission and await every owned execution cleanup. */
  close(): Promise<void> {
    this.closed = true;
    return this.attempts.close();
  }

  private async runAttempt<T>(
    identity: ExecutionInvocation,
    operation: (scope: ToolExecutionScope) => Promise<T>,
    runOptions: ToolExecutionRunOptions,
    sandbox?: AnySandboxExecutionOwner,
    terminalEvidence?: () => SandboxExecutionTerminal,
  ): Promise<T> {
    if (this.closed) {
      throw new ToolExecutionError("tool_closed", "tool execution admission is closed");
    }
    const timeoutSeconds = effectiveTimeoutSeconds(
      this.options.policy.timeout_seconds,
      runOptions.modelTimeoutSeconds,
    );
    const executionId = this.idFactory();
    const supervisionId = this.idFactory();
    const recoveryCount = this.timeoutCountForInvocation(identity);
    if (recoveryCount > this.options.policy.max_recoverable_timeouts)
      throw new ToolExecutionError("tool_closed", "tool execution timeout budget is exhausted");
    const startedAt = Date.now();
    const timeoutMs = safeMilliseconds(timeoutSeconds);
    const admission =
      runOptions.captureAdmission === undefined ? undefined : await runOptions.captureAdmission();
    if (this.closed) {
      throw new ToolExecutionError("tool_closed", "tool execution admission is closed");
    }
    const started = buildExecutionStart({
      identity,
      runId: this.options.runId,
      logicalSessionId: this.options.logicalSessionId,
      roleSessionId: this.options.roleSessionId,
      executionId,
      supervisionId,
      timeoutMs,
      recoveryCount,
      startedAt,
      ...(admission === undefined ? {} : { admission }),
      ...(sandbox === undefined ? {} : { sandbox }),
    });
    this.append(started);
    if (terminalEvidence !== undefined) this.terminalEvidence.set(executionId, terminalEvidence);

    const operationAbort = new AbortController();
    this.attempts.addAbort(operationAbort);
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
      this.attempts.deleteAbort(operationAbort);
      try {
        return this.failBeforeOperation(started, error);
      } finally {
        this.terminalEvidence.delete(executionId);
      }
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          timeoutRequested = true;
          operationAbort.abort();
          reject(new Error("controller timeout"));
        },
        timeoutDelay(Math.max(0, deadline - Date.now())),
      );
    });
    const abortPromise = new Promise<never>((_, reject) => {
      abortReject = reject;
      if (externalAbort) reject(new Error("external abort"));
    });
    let closeRequested = false;
    const closeReject = (reason: unknown) => {
      closeRequested = true;
      operationAbort.abort();
      abortReject?.(reason);
    };
    this.attempts.addReject(closeReject);

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
        closeRequested ||
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
      if (hasUnconfirmedCleanup(settled.error)) {
        return this.finishUnconfirmed(started, executionId, recoveryCount, settled.error);
      }
      if (aborted && !timedOut) {
        return this.finishAborted(started, executionId, recoveryCount, settled.error ?? error);
      }
      return this.finishTimeout(started, executionId, recoveryCount, settled.error ?? error);
    } finally {
      this.terminalEvidence.delete(executionId);
      if (timer !== undefined) clearTimeout(timer);
      if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
      runOptions.signal?.removeEventListener("abort", onExternalAbort);
      this.attempts.deleteAbort(operationAbort);
      this.attempts.deleteReject(closeReject);
    }
  }

  private timeoutCountForSession(): number {
    return executionTimeoutCount([...this.priorRecords, ...this.generated], this.options.runId, {
      kind: "sdk",
      logicalSessionId: this.options.logicalSessionId,
    });
  }

  private started(executionId: string): AnyToolExecutionStartedRecord | undefined {
    const record = this.generated.find(
      (candidate) =>
        candidate.type === "tool_execution_started" && candidate.execution_id === executionId,
    );
    return record?.type === "tool_execution_started" ? record : undefined;
  }

  private timeoutCountForInvocation(identity: ExecutionInvocation): number {
    if (identity.kind === "sdk") return this.timeoutCountForSession();
    return executionTimeoutCount([...this.priorRecords, ...this.generated], this.options.runId, {
      kind: "controller",
      origin: identity.origin,
    });
  }

  private timeoutCountForStart(started: AnyToolExecutionStartedRecord): number {
    return started.schema_version === 1
      ? this.timeoutCountForSession()
      : this.timeoutCountForInvocation({ kind: "controller", origin: started.origin });
  }

  private append(record: ToolExecutionRecord): void {
    try {
      this.options.persist(record);
    } catch (cause) {
      const executionId = record.execution_id;
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
    started: AnyToolExecutionStartedRecord,
    executionId: string,
    _recoveryCount: number,
    cause: unknown,
  ): never {
    const priorTimeouts = this.timeoutCountForStart(started);
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
    started: AnyToolExecutionStartedRecord,
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
    started: AnyToolExecutionStartedRecord,
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
    started: AnyToolExecutionStartedRecord,
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

  private failBeforeOperation(started: AnyToolExecutionStartedRecord, cause: unknown): never {
    this.appendFinished(started, "aborted", "confirmed");
    throw cause;
  }

  private appendFinished(
    started: AnyToolExecutionStartedRecord,
    outcome: ToolExecutionFinishedRecord["outcome"],
    cleanup: ToolExecutionFinishedRecord["cleanup"],
    diagnostic?: ToolExecutionFinishedRecord["diagnostic"],
  ): void {
    if (this.finishedIds.has(started.execution_id)) return;
    const ready = this.generated.find(
      (record) =>
        record.type === "tool_execution_sandbox_ready" &&
        record.execution_id === started.execution_id,
    );
    let record: import("../../persistence/tool-execution.js").AnyToolExecutionFinishedRecord;
    try {
      record = buildToolExecutionTerminal(
        started,
        outcome,
        cleanup,
        diagnostic,
        ready?.type === "tool_execution_sandbox_ready" ? ready : undefined,
        this.terminalEvidence.get(started.execution_id),
      );
    } catch (cause) {
      const error = new ToolExecutionError(
        "tool_cleanup_unconfirmed",
        "tool terminal evidence is invalid; preserve the execution for reconciliation",
        { cleanup: "unconfirmed", executionId: started.execution_id, cause },
      );
      this.closeOnFatal(error);
      throw error;
    }
    this.append(record);
    this.finishedIds.add(started.execution_id);
  }

  private closeOnFatal(error: ToolExecutionError): void {
    if (this.closed) return;
    this.closed = true;
    this.attempts.abort(error);
    this.onFatal?.(error);
  }
}
