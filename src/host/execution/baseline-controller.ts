/** Portable call admission/terminals; foreground settlement is not cleanup (§4–5). */
import { randomUUID } from "node:crypto";
import type { ToolExecutionPolicy } from "../../manifest/execution-policy.js";
import {
  assertBaselineExecutionsSettled,
  type BaselineExecutionFinishedRecord,
  type BaselineExecutionRecord,
  type BaselineExecutionStartedRecord,
  type BaselineForegroundStatus,
} from "../../persistence/baseline-execution.js";
import { BaselineProcessError } from "./baseline-process-error.js";
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

/** Baseline configuration keeps foreground evidence separate from enhanced admission. */
export interface BaselineControllerOptions {
  readonly runId: string;
  readonly logicalSessionId: string;
  readonly roleSessionId: string;
  readonly policy: Readonly<Required<ToolExecutionPolicy>>;
  readonly persist: (record: BaselineExecutionRecord) => void;
  readonly priorRecords?: readonly BaselineExecutionRecord[];
  readonly onFatal?: (error: ToolExecutionError) => void;
}

/** Recover settled foreground interruptions within budget; never replay effects. */
export class BaselineExecutionController implements RoleExecutionController {
  private closed = false;
  private recoveryCount = 0;
  private readonly active = new Set<AbortController>();
  private readonly cancelling = new Set<AbortController>();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly options: BaselineControllerOptions) {
    assertBaselineExecutionsSettled(options.priorRecords ?? []);
    this.recoveryCount = (options.priorRecords ?? []).filter(
      (record) =>
        record.type === "baseline_execution_finished" &&
        record.run_id === options.runId &&
        record.logical_session_id === options.logicalSessionId &&
        (record.outcome === "timed_out" || record.outcome === "aborted"),
    ).length;
  }

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
        { cleanup: "not-guaranteed", cause },
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
    if (this.recoveryCount > this.options.policy.max_recoverable_timeouts)
      throw new ToolExecutionError(
        "tool_timeout_exhausted",
        "baseline timeout recovery budget exhausted",
        { cleanup: "not-guaranteed" },
      );
    if (this.closed || this.cancelling.size > 0)
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
    const interrupt = () => {
      this.cancelling.add(controller);
      controller.abort();
    };
    options.signal?.addEventListener("abort", interrupt, { once: true });
    let timedOut = false;
    let foregroundStatus: BaselineForegroundStatus | undefined;
    let activeForeground = 0;
    let resolveForeground: (() => void) | undefined;
    let invoked = false;
    let taskSettled = false;
    let taskError: unknown;
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
      trackForeground: () => {
        activeForeground++;
        foregroundStatus = undefined;
        let settled = false;
        return (status) => {
          if (settled) return;
          settled = true;
          activeForeground--;
          if (activeForeground === 0) {
            foregroundStatus = status;
            resolveForeground?.();
          }
        };
      },
      remainingTimeoutMs: () => Math.max(0, deadline - Date.now()),
      assertOpen: () => {
        if (this.closed || controller.signal.aborted || Date.now() >= deadline)
          throw new ToolExecutionError("tool_aborted", "baseline admission/deadline is closed", {
            cleanup: "not-guaranteed",
          });
      },
    };
    const task = Promise.resolve().then(() => {
      scope.assertOpen();
      invoked = true;
      return operation(scope);
    });
    void task.then(
      () => {
        taskSettled = true;
      },
      (error) => {
        taskSettled = true;
        taskError = error;
      },
    );
    const finish = (
      outcome: BaselineExecutionFinishedRecord["outcome"],
      status = foregroundStatus,
    ) => {
      const { timeout_ms: _timeout, type: _type, ...identity } = started;
      this.persist({
        ...identity,
        type: "baseline_execution_finished",
        elapsed_ms: Math.max(0, Date.now() - started.ts),
        outcome,
        cleanup: "not-guaranteed",
        ...(status === undefined ? {} : { foreground_status: status }),
        ts: Date.now(),
      });
    };
    const cancelTimer = armDeadline(deadline, () => {
      timedOut = true;
      interrupt();
    });
    if (options.signal?.aborted || this.closed) interrupt();
    try {
      const value = await Promise.race([task, aborted]);
      if (Date.now() >= deadline) {
        timedOut = true;
        interrupt();
        throw new Error("baseline deadline");
      }
      if (controller.signal.aborted) throw new Error("baseline cancellation");
      if (activeForeground > 0) {
        interrupt();
        throw new Error("baseline task returned with active foreground work");
      }
      finish("completed");
      return value;
    } catch (cause) {
      if (cause instanceof ToolExecutionError && cause.code === "tool_persistence_ambiguous")
        throw cause;
      timedOut ||=
        Date.now() >= deadline ||
        (cause instanceof SupervisedProcessError && cause.code === "supervised-process-timeout");
      const interrupted =
        activeForeground > 0 ||
        timedOut ||
        controller.signal.aborted ||
        (cause instanceof SupervisedProcessError &&
          (cause.cleanup === "unconfirmed" || cause.code === "supervised-process-aborted"));
      if (!interrupted) {
        finish("failed");
        throw new ToolExecutionError("tool_failed", "baseline tool execution failed", {
          cleanup: "not-guaranteed",
          executionId: started.execution_id,
          cause,
        });
      }
      interrupt();
      const foregroundSettlement =
        activeForeground === 0
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              resolveForeground = resolve;
            });
      let cancelSettlement = () => {};
      try {
        await Promise.race([
          Promise.all([task.catch(() => undefined), foregroundSettlement]),
          new Promise<void>((resolve) => {
            cancelSettlement = armDeadline(Date.now() + scope.graceMs * 2 + 2000, resolve);
          }),
        ]);
      } finally {
        cancelSettlement();
      }
      const processError =
        taskError instanceof BaselineProcessError
          ? taskError
          : cause instanceof BaselineProcessError
            ? cause
            : undefined;
      if (processError !== undefined) foregroundStatus = processError.foregroundStatus;
      else if (!invoked) foregroundStatus = "not-started";
      if (activeForeground > 0) foregroundStatus = "unobserved";
      timedOut ||= processError?.code === "supervised-process-timeout" || Date.now() >= deadline;
      const settled =
        taskSettled &&
        activeForeground === 0 &&
        (foregroundStatus === "closed" || foregroundStatus === "not-started");
      if (!settled) {
        finish("uncertain", foregroundStatus ?? "unobserved");
        const error = new ToolExecutionError(
          "tool_cleanup_unconfirmed",
          "baseline foreground/operation settlement was not observed; resume/replay is blocked. Inspect partial effects.",
          { cleanup: "not-guaranteed", executionId: started.execution_id, cause },
        );
        this.fatal(error);
        throw error;
      }
      const cancelled =
        timedOut ||
        options.signal?.aborted ||
        this.closed ||
        processError?.code === "supervised-process-aborted";
      if (!cancelled) {
        finish("failed");
        throw new ToolExecutionError("tool_failed", "baseline foreground execution failed", {
          cleanup: "not-guaranteed",
          executionId: started.execution_id,
          cause,
        });
      }
      finish(timedOut ? "timed_out" : "aborted");
      if (this.closed)
        throw new ToolExecutionError("tool_aborted", "baseline invocation was closed", {
          cleanup: "not-guaranteed",
          executionId: started.execution_id,
          cause,
        });
      const code =
        this.recoveryCount++ >= this.options.policy.max_recoverable_timeouts
          ? "tool_timeout_exhausted"
          : "tool_timeout";
      const error = new ToolExecutionError(
        code,
        "baseline foreground execution interrupted; descendant cleanup remains not-guaranteed. Inspect partial effects before an explicit retry.",
        { cleanup: "not-guaranteed", executionId: started.execution_id, cause },
      );
      if (code === "tool_timeout_exhausted") this.fatal(error);
      throw error;
    } finally {
      cancelTimer();
      options.signal?.removeEventListener("abort", interrupt);
      controller.signal.removeEventListener("abort", onOperationAbort);
      this.active.delete(controller);
      this.cancelling.delete(controller);
    }
  }
}
