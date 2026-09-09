/**
 * Shared asynchronous delegation scheduler — open-issue #77.
 *
 * Admission, durable replay, queue draining, and settlement stay together because
 * each transition shares the same poison/cleanup barrier; this intentionally stays
 * just under the repository's 500-line coherent-module exception.
 */

import {
  acceptedDelegationResults,
  type DelegationSubmissionAcceptedRecord,
  delegationSubmissionId,
  spentDelegationSlots,
} from "../../persistence/delegation-task.js";
import type { PersistedRecord } from "../../persistence/log.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import type { DelegateSubmissionArgs } from "../../seam/schema.js";
import type { PreparedDelegateChild, PreparedDelegateSubmission } from "./admission.js";
import { DelegationChildSafetyError, failedSafetyResult } from "./child-safety-error.js";
import type { PoolChildResult } from "./pool.js";
import { cancelledResult, resultState, terminalToPoolResult } from "./scheduler-results.js";

export interface DelegationSchedulerIdentity {
  readonly runId: string;
  readonly logicalParentId: string;
  readonly parentRole: string;
  readonly parentVisitIndex: number;
}

export type DelegationTaskState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface DelegationTaskStatus {
  readonly childId: string;
  readonly taskId: string;
  readonly submissionId: string;
  readonly status: DelegationTaskState;
  readonly result?: PoolChildResult;
}

export interface DelegationSchedulerOptions {
  readonly identity: DelegationSchedulerIdentity;
  readonly maxParallel: number;
  readonly maxChildren: number;
  readonly records: () => readonly PersistedRecord[];
  readonly persistRecord: (record: PersistedRecord) => void;
  readonly prepareSubmission: (
    input: DelegateSubmissionArgs,
    remainingChildren: number,
  ) => Promise<PreparedDelegateSubmission>;
  readonly runTask: (task: PreparedDelegateChild, signal: AbortSignal) => Promise<PoolChildResult>;
  readonly onTerminal: (result: PoolChildResult) => void;
  readonly onFatal?: (cause: unknown) => void;
  readonly isBudgetExhausted?: () => boolean;
}

interface TaskState {
  readonly task: PreparedDelegateChild | null;
  readonly childId: string;
  readonly taskId: string;
  readonly submissionId: string;
  status: DelegationTaskState;
  result?: PoolChildResult;
  fatalError?: unknown;
  controller?: AbortController | undefined;
  runPromise?: Promise<void>;
  waiters: Array<{
    readonly resolve: (result: PoolChildResult) => void;
    readonly reject: (cause: unknown) => void;
  }>;
}

interface SubmissionState {
  readonly submissionId: string;
  readonly fingerprint: string;
  readonly tasks: readonly TaskState[];
}

/** One admission queue shared by every submission from one parent invocation. */
export class DelegationScheduler {
  private readonly submissions = new Map<string, SubmissionState>();
  private readonly tasks = new Map<string, TaskState>();
  private readonly queue: TaskState[] = [];
  private running = 0;
  private poisoned = false;
  private permanentlyClosed = false;
  private settling: Promise<void> | null = null;
  private admissionTail: Promise<void> = Promise.resolve();
  private terminalFailure: unknown;

  constructor(private readonly options: DelegationSchedulerOptions) {
    if (!Number.isSafeInteger(options.maxParallel) || options.maxParallel < 1)
      throw new Error("delegation scheduler maxParallel must be positive");
    if (!Number.isSafeInteger(options.maxChildren) || options.maxChildren < 0)
      throw new Error("delegation scheduler maxChildren must be non-negative");
    this.replay(options.records());
    if ([...this.tasks.values()].some((task) => task.result === undefined)) {
      this.poisoned = true;
      throw new Error("delegation scheduler requires durable reconciliation before resume");
    }
  }

  isClosed(): boolean {
    return this.poisoned || this.permanentlyClosed;
  }
  isBudgetExhausted(): boolean {
    return this.options.isBudgetExhausted?.() === true;
  }

  /** Atomically persist acceptance before putting children on the queue. */
  submit(toolCallId: string, input: DelegateSubmissionArgs): Promise<readonly string[]> {
    const frozenInput = structuredClone(input);
    const operation = this.admissionTail.then(() => this.submitOne(toolCallId, frozenInput));
    this.admissionTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async submitOne(
    toolCallId: string,
    input: DelegateSubmissionArgs,
  ): Promise<readonly string[]> {
    const submissionId = delegationSubmissionId(
      this.options.identity.runId,
      this.options.identity.logicalParentId,
      toolCallId,
    );
    const fingerprint = sha256Canonical(input);
    const prior = this.submissions.get(submissionId);
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint)
        throw new Error("delegation submission identity was reused with different inputs");
      return prior.tasks.map((task) => task.childId);
    }
    if (this.isClosed() || this.isBudgetExhausted())
      throw new Error("delegation admission is closed");
    const prepared = await this.options.prepareSubmission(
      input,
      this.options.maxChildren -
        spentDelegationSlots(this.options.records(), this.options.identity.logicalParentId),
    );
    const tasks = prepared.tasks;
    if (this.isClosed() || this.isBudgetExhausted())
      throw new Error("delegation admission is closed");
    if (tasks.length === 0) throw new Error("delegation submission requires a task");
    const spent = spentDelegationSlots(
      this.options.records(),
      this.options.identity.logicalParentId,
    );
    if (spent + tasks.length > this.options.maxChildren)
      throw new Error("delegation admission allowance exhausted");
    const accepted: DelegationSubmissionAcceptedRecord = {
      type: "delegation_submission_accepted",
      schema_version: 1,
      run_id: this.options.identity.runId,
      submission_id: submissionId,
      logical_parent_id: this.options.identity.logicalParentId,
      parent_role: this.options.identity.parentRole,
      parent_visit_index: this.options.identity.parentVisitIndex,
      tool_call_id: toolCallId,
      input_fingerprint: fingerprint,
      children: tasks.map((task) => ({
        child_id: task.childId,
        task_id: task.taskId,
        subagent: task.profile.name,
        model:
          task.profile.models[0]?.model ??
          (() => {
            throw new Error(`subagent '${task.profile.name}' has no model`);
          })(),
        branch: task.branch,
        worktree_path: task.worktreePath,
        base_commit: task.baseCommit,
        task_fingerprint: task.taskFingerprint,
        profile_fingerprint: task.profileFingerprint,
        context_fingerprint: task.contextFingerprint,
        prompt_fingerprint: task.promptFingerprint,
        projection_fingerprint: task.projectionFingerprint,
      })),
      ts: Date.now(),
    };
    try {
      this.options.persistRecord(accepted);
    } catch (cause) {
      this.fail(cause);
      throw cause;
    }
    const states = tasks.map((task) => {
      const state: TaskState = {
        task,
        childId: task.childId,
        taskId: task.taskId,
        submissionId,
        status: "queued",
        waiters: [],
      };
      this.tasks.set(state.childId, state);
      this.queue.push(state);
      return state;
    });
    this.submissions.set(submissionId, { submissionId, fingerprint, tasks: states });
    this.drain();
    return states.map((task) => task.childId);
  }

  status(childIds?: readonly string[]): readonly DelegationTaskStatus[] {
    const states =
      childIds === undefined
        ? [...this.tasks.values()]
        : childIds.map((id) => {
            const state = this.tasks.get(id);
            if (state === undefined) throw new Error(`unknown delegated child '${id}'`);
            return state;
          });
    return states.map((state) => ({
      childId: state.childId,
      taskId: state.taskId,
      submissionId: state.submissionId,
      status: state.status,
      ...(state.result === undefined ? {} : { result: state.result }),
    }));
  }

  /** Stable handles that still require settlement before parent transition. */
  pendingChildIds(): readonly string[] {
    return [...this.tasks.values()]
      .filter((state) => state.result === undefined && state.fatalError === undefined)
      .map((state) => state.childId);
  }

  /** Remaining admission after all accepted submissions in this invocation. */
  remainingChildren(): number {
    return Math.max(
      0,
      this.options.maxChildren -
        spentDelegationSlots(this.options.records(), this.options.identity.logicalParentId),
    );
  }

  wait(childId: string, signal?: AbortSignal): Promise<PoolChildResult> {
    const state = this.tasks.get(childId);
    if (state === undefined)
      return Promise.reject(new Error(`unknown delegated child '${childId}'`));
    if (state.result !== undefined) return Promise.resolve(state.result);
    if (state.fatalError !== undefined) return Promise.reject(state.fatalError);
    if (signal?.aborted === true) return Promise.reject(new Error("delegation wait interrupted"));
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        signal?.removeEventListener("abort", abort);
        reject(new Error("delegation wait interrupted"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      state.waiters.push({
        resolve: (result) => {
          signal?.removeEventListener("abort", abort);
          resolve(result);
        },
        reject,
      });
    });
  }

  async cancel(childIds: readonly string[]): Promise<void> {
    for (const childId of childIds) {
      const state = this.tasks.get(childId);
      if (state === undefined) throw new Error(`unknown delegated child '${childId}'`);
      if (state.result !== undefined) continue;
      if (state.status === "queued") {
        try {
          await this.finish(state, cancelledResult(state));
        } catch (cause) {
          this.fail(cause, state);
          throw cause;
        }
      } else state.controller?.abort();
    }
    await Promise.all(
      childIds.flatMap((id) => {
        const state = this.tasks.get(id);
        return state?.runPromise === undefined ? [] : [state.runPromise];
      }),
    );
    this.drain();
  }

  async close(reason = "delegation admission closed"): Promise<void> {
    if (this.settling !== null) return this.settling;
    this.permanentlyClosed = true;
    this.settling = (async () => {
      await this.admissionTail.catch(() => undefined);
      const queued = this.queue.splice(0);
      for (const state of queued) {
        if (state.result !== undefined || state.fatalError !== undefined) continue;
        try {
          await this.finish(state, cancelledResult(state, reason));
        } catch (cause) {
          this.fail(cause, state);
        }
      }
      for (const state of this.tasks.values()) state.controller?.abort();
      await Promise.all(
        [...this.tasks.values()].flatMap((state) =>
          state.runPromise === undefined ? [] : [state.runPromise],
        ),
      );
      // A child safety failure is retained by the coordinator as a run
      // blocker, but all SDK child promises are known settled by this point.
      // Let the parent lifecycle record its own failure and release the run
      // lease. Unknown ownership and persistence failures still propagate.
      if (
        this.terminalFailure !== undefined &&
        (!this.allTasksSettled() || !(this.terminalFailure instanceof DelegationChildSafetyError))
      )
        throw this.terminalFailure;
    })();
    return this.settling;
  }

  private drain(): void {
    if (this.isClosed() || this.isBudgetExhausted()) {
      if (this.isBudgetExhausted())
        void this.close("delegation budget exhausted").catch(() => undefined);
      return;
    }
    while (this.running < this.options.maxParallel) {
      const state = this.queue.shift();
      if (state === undefined) return;
      if (state.result !== undefined || state.status !== "queued") continue;
      state.status = "running";
      state.controller = new AbortController();
      this.running += 1;
      state.runPromise = this.run(state);
    }
  }

  private async run(state: TaskState): Promise<void> {
    let result: PoolChildResult;
    try {
      if (state.task === null) throw new Error("accepted delegated task has no prepared input");
      result = await this.options.runTask(
        state.task,
        state.controller?.signal ?? new AbortController().signal,
      );
    } catch (cause) {
      if (cause instanceof DelegationChildSafetyError) {
        // The factory raises this only after the SDK child has returned and
        // disposed. Poison before resolving waiters so no follow-up admission
        // can race the unresolved cleanup barrier.
        this.fail(cause);
        try {
          await this.finish(state, failedSafetyResult(cause));
        } catch (terminalCause) {
          this.fail(terminalCause, state);
        }
      } else {
        // Other throws may mean the child never started or its ownership is
        // ambiguous. Preserve the existing unknown-ownership behavior.
        this.fail(cause, state);
      }
      this.running -= 1;
      state.controller = undefined;
      setTimeout(
        () => void this.close("delegation child execution is ambiguous").catch(() => undefined),
        0,
      );
      return;
    }
    try {
      await this.finish(state, result);
    } catch (cause) {
      this.fail(cause, state);
    } finally {
      this.running -= 1;
      state.controller = undefined;
      if (this.isBudgetExhausted())
        setTimeout(() => void this.close("delegation budget exhausted").catch(() => undefined), 0);
      else if (!this.isClosed()) this.drain();
    }
  }

  private async finish(state: TaskState, result: PoolChildResult): Promise<void> {
    if (state.result !== undefined) return;
    this.options.onTerminal(result);
    state.result = result;
    state.status =
      result.status === "completed" || result.status === "no_changes"
        ? "completed"
        : result.status === "blocked"
          ? "failed"
          : result.status;
    for (const waiter of state.waiters.splice(0)) waiter.resolve(result);
  }

  private fail(cause: unknown, state?: TaskState): void {
    const failure = cause instanceof Error ? cause : new Error(String(cause));
    this.poisoned = true;
    this.permanentlyClosed = true;
    if (
      this.terminalFailure === undefined ||
      (this.terminalFailure instanceof DelegationChildSafetyError &&
        !(cause instanceof DelegationChildSafetyError))
    )
      this.terminalFailure = failure;
    if (state !== undefined) {
      state.fatalError = failure;
      for (const waiter of state.waiters.splice(0)) waiter.reject(failure);
    }
    try {
      this.options.onFatal?.(failure);
    } catch {
      // Notification failure cannot prevent owned cleanup and closure.
    }
    setTimeout(
      () => void this.close("delegation persistence is ambiguous").catch(() => undefined),
      0,
    );
  }

  private allTasksSettled(): boolean {
    return [...this.tasks.values()].every(
      (task) => task.result !== undefined && task.fatalError === undefined,
    );
  }

  private replay(records: readonly PersistedRecord[]): void {
    const accepted = records.filter(
      (record): record is DelegationSubmissionAcceptedRecord =>
        record.type === "delegation_submission_accepted",
    );
    const terminals = new Map(
      acceptedDelegationResults(records).map((record) => [record.child_id, record] as const),
    );
    for (const submission of accepted) {
      if (
        submission.run_id !== this.options.identity.runId ||
        submission.parent_role !== this.options.identity.parentRole
      )
        continue;
      const states = submission.children.map((child) => {
        const terminal = terminals.get(child.child_id);
        const result = terminal === undefined ? undefined : terminalToPoolResult(terminal);
        const state: TaskState = {
          task: null,
          childId: child.child_id,
          taskId: child.task_id,
          submissionId: submission.submission_id,
          status: result === undefined ? "interrupted" : resultState(result),
          ...(result === undefined ? {} : { result }),
          waiters: [],
        };
        this.tasks.set(state.childId, state);
        return state;
      });
      this.submissions.set(submission.submission_id, {
        submissionId: submission.submission_id,
        fingerprint: submission.input_fingerprint,
        tasks: states,
      });
    }
  }
}
