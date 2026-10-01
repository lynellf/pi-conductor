/** Portable call admission/terminals; no enhanced cleanup witnesses (§4–5). */
import { randomUUID } from "node:crypto";
import type { ToolExecutionPolicy } from "../../manifest/execution-policy.js";
import type {
  BaselineExecutionFinishedRecord,
  BaselineExecutionRecord,
  BaselineExecutionStartedRecord,
} from "../../persistence/baseline-execution.js";
import { armDeadline } from "./deadline-timer.js";
import { SupervisedProcessError } from "./supervised-process-contract.js";
import {
  ToolExecutionError,
  type ToolExecutionRunOptions,
  type ToolExecutionScope,
} from "./tool-execution-contract.js";
import { effectiveTimeoutSeconds } from "./tool-execution-controller-support.js";

/** Minimal role-tool lifetime shared with the existing enhanced controller. */
export interface RoleExecutionController {
  run<T>(
    toolName: string,
    toolCallId: string,
    operation: (scope: ToolExecutionScope) => Promise<T>,
    options?: ToolExecutionRunOptions,
  ): Promise<T>;
  close(): Promise<void>;
}

/** Baseline controller configuration keeps its records separate from enhanced admission. */
export interface BaselineControllerOptions {
  readonly runId: string;
  readonly logicalSessionId: string;
  readonly roleSessionId: string;
  readonly policy: Readonly<Required<ToolExecutionPolicy>>;
  readonly persist: (record: BaselineExecutionRecord) => void;
  readonly onFatal?: (error: ToolExecutionError) => void;
}

/** Admit only explicit calls; interrupted work seals the invocation instead of replaying. */
export class BaselineExecutionController implements RoleExecutionController {
  private closed = false;
  private readonly active = new Set<AbortController>();
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly options: BaselineControllerOptions) {}

  run<T>(
    name: string,
    call: string,
    operation: (scope: ToolExecutionScope) => Promise<T>,
    options: ToolExecutionRunOptions = {},
  ): Promise<T> {
    const promise = this.execute(name, call, operation, options);
    this.pending.add(promise);
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }

  async close(): Promise<void> {
    this.seal();
    await Promise.allSettled([...this.pending]);
  }

  private persist(record: BaselineExecutionRecord): void {
    try {
      this.options.persist(record);
    } catch (cause) {
      const error = new ToolExecutionError(
        "tool_persistence_ambiguous",
        "baseline execution persistence is ambiguous; resume is blocked",
        { cleanup: "unconfirmed", cause },
      );
      this.fatal(error);
      throw error;
    }
  }

  private seal(): void {
    this.closed = true;
    for (const controller of this.active) controller.abort();
  }

  private fatal(error: ToolExecutionError): void {
    this.seal();
    this.options.onFatal?.(error);
  }

  private async execute<T>(
    name: string,
    call: string,
    operation: (scope: ToolExecutionScope) => Promise<T>,
    options: ToolExecutionRunOptions,
  ): Promise<T> {
    if (this.closed)
      throw new ToolExecutionError("tool_closed", "baseline tool admission is closed");
    if (options.signal?.aborted)
      throw new ToolExecutionError("tool_aborted", "baseline tool was aborted before admission");
    const timeoutMs =
      effectiveTimeoutSeconds(this.options.policy.timeout_seconds, options.modelTimeoutSeconds) *
      1000;
    const started: BaselineExecutionStartedRecord = {
      type: "baseline_execution_started",
      schema_version: 1,
      execution_tier: "baseline",
      run_id: this.options.runId,
      logical_session_id: this.options.logicalSessionId,
      role_session_id: this.options.roleSessionId,
      execution_id: randomUUID(),
      tool_call_id: call,
      tool_name: name,
      timeout_ms: timeoutMs,
      ts: Date.now(),
    };
    this.persist(started);
    const deadline = started.ts + timeoutMs;
    const controller = new AbortController();
    this.active.add(controller);
    const onAbort = () => this.seal();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    let cancelTimer = () => {};
    let rejectAbort!: (error: unknown) => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const onOperationAbort = () => rejectAbort(new Error("baseline cancellation"));
    controller.signal.addEventListener("abort", onOperationAbort, { once: true });
    const scope: ToolExecutionScope = {
      executionId: started.execution_id,
      supervisionId: started.execution_id,
      signal: controller.signal,
      graceMs: this.options.policy.termination_grace_seconds * 1000,
      remainingTimeoutMs: () => Math.max(0, deadline - Date.now()),
      assertOpen: () => {
        if (this.closed || controller.signal.aborted || Date.now() >= deadline)
          throw new ToolExecutionError("tool_aborted", "baseline admission/deadline is closed", {
            cleanup: "unconfirmed",
          });
      },
    };
    const task = Promise.resolve().then(() => {
      scope.assertOpen();
      return operation(scope);
    });
    const finish = (outcome: BaselineExecutionFinishedRecord["outcome"]) => {
      const { timeout_ms: _timeout, type: _type, ...identity } = started;
      this.persist({
        ...identity,
        type: "baseline_execution_finished",
        elapsed_ms: Math.max(0, Date.now() - started.ts),
        outcome,
        cleanup: "not-guaranteed",
        ts: Date.now(),
      });
    };
    cancelTimer = armDeadline(deadline, () => {
      timedOut = true;
      this.seal();
    });
    if (options.signal?.aborted || this.closed) this.seal();
    try {
      const value = await Promise.race([task, aborted]);
      if (Date.now() >= deadline) {
        timedOut = true;
        this.seal();
        throw new Error("baseline deadline");
      }
      if (controller.signal.aborted) throw new Error("baseline cancellation");
      finish("completed");
      return value;
    } catch (cause) {
      if (cause instanceof ToolExecutionError && cause.code === "tool_persistence_ambiguous")
        throw cause;
      const processError = cause instanceof SupervisedProcessError ? cause : undefined;
      timedOut ||= processError?.code === "supervised-process-timeout" || Date.now() >= deadline;
      const interrupted =
        timedOut || controller.signal.aborted || processError?.cleanup === "unconfirmed";
      if (!interrupted) {
        finish("failed");
        throw cause;
      }
      this.seal();
      let cancelSettlement = () => {};
      try {
        await Promise.race([
          task.catch(() => undefined),
          new Promise<void>((resolve) => {
            cancelSettlement = armDeadline(Date.now() + scope.graceMs * 2 + 2000, resolve);
          }),
        ]);
      } finally {
        cancelSettlement();
      }
      finish(
        timedOut
          ? "timed_out"
          : controller.signal.aborted && processError?.code !== "supervised-process-spawn-failed"
            ? "aborted"
            : "uncertain",
      );
      const error = new ToolExecutionError(
        "tool_cleanup_unconfirmed",
        "baseline execution interrupted; descendant cleanup is not guaranteed. Resume/replay is blocked; inspect partial effects.",
        { cleanup: "unconfirmed", executionId: started.execution_id, cause },
      );
      this.fatal(error);
      throw error;
    } finally {
      cancelTimer();
      options.signal?.removeEventListener("abort", onAbort);
      controller.signal.removeEventListener("abort", onOperationAbort);
      this.active.delete(controller);
    }
  }
}
