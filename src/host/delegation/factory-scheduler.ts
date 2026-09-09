/** Host-owned scheduler construction for shared delegate tools. */

import {
  isToolExecutionRecord,
  type ToolExecutionRecord,
} from "../../persistence/tool-execution.js";
import type { DelegateSubmissionArgs } from "../../seam/schema.js";
import { assertNoUnfinishedToolExecutions } from "../execution/tool-execution-controller.js";
import { prepareDelegateSubmission } from "./admission.js";
import { isPoolCompleted } from "./child-result-mapping.js";
import { DelegationChildSafetyError } from "./child-safety-error.js";
import { buildSpawnCallback } from "./child-session.js";
import { runPreparedChild } from "./delegate-tool.js";
import type { DelegateToolFactoryOptions } from "./delegate-tool-factory.js";
import { appendCompleted, appendFailed } from "./factory-records.js";
import type { PoolChildResult } from "./pool.js";
import { DelegationScheduler } from "./scheduler.js";

/** Construct one scheduler with the factory's pinned preparation and child adapter. */
export function createDelegateScheduler(
  opts: DelegateToolFactoryOptions,
  logicalParentId: string,
): DelegationScheduler {
  const materializedPaths = new Map<string, readonly string[]>();
  const scheduler = new DelegationScheduler({
    identity: {
      runId: opts.runId,
      logicalParentId,
      parentRole: opts.parentRole,
      parentVisitIndex: opts.parentVisitIndex,
    },
    maxParallel: delegationMaxParallel(opts),
    maxChildren: Math.min(opts.remainingChildren, delegationMaxChildren(opts)),
    records: requiredRecords(opts),
    persistRecord: opts.persistRecord,
    prepareSubmission: async (input: DelegateSubmissionArgs, remainingChildren) => {
      const prepared = await prepareDelegateSubmission({
        args: input,
        policy: delegationPolicy(opts),
        profiles: opts.subagents,
        remainingChildren,
        runStateDir: opts.runStateDir,
        runId: opts.runId,
        parentRole: opts.parentRole,
        primaryCheckout: opts.primaryCheckout,
        systemPromptRoot: opts.systemPromptRoot,
        spawnAndRunChild: async () => {
          throw new Error("scheduler preparation cannot spawn directly");
        },
      });
      for (const task of prepared.tasks)
        materializedPaths.set(task.childId, prepared.materializedParentPaths);
      return prepared;
    },
    runTask: async (task, signal) => {
      const abort = (): void => {
        void opts.manager.abort(task.childId);
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        const result = await runPreparedChild({
          prepared: task,
          runId: opts.runId,
          parentRole: opts.parentRole,
          primaryCheckout: opts.primaryCheckout,
          parentMaterializedPaths:
            materializedPaths.get(task.childId) ?? missingMaterializedPaths(task.childId),
          systemPromptRoot: opts.systemPromptRoot,
          spawnAndRunChild: buildSpawnCallback(opts),
          isAdmissionClosed: () =>
            opts.manager.isClosed() || opts.manager.wasCancelled(task.childId) || signal.aborted,
        });
        try {
          assertNoUnfinishedToolExecutions(
            requiredRecords(opts)().filter(
              (record) => isToolExecutionRecord(record) && record.role_session_id === task.childId,
            ) as readonly ToolExecutionRecord[],
          );
        } catch (cause) {
          throw new DelegationChildSafetyError(result, cause);
        }
        return result;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
    onTerminal: (result) => persistTerminal(opts, result),
    ...(opts.onFatal === undefined ? {} : { onFatal: opts.onFatal }),
    ...(opts.isBudgetExhausted === undefined ? {} : { isBudgetExhausted: opts.isBudgetExhausted }),
  });
  return scheduler;
}

function persistTerminal(opts: DelegateToolFactoryOptions, result: PoolChildResult): void {
  if (isPoolCompleted(result)) appendCompleted(opts.persistRecord, opts.runId, result);
  else appendFailed(opts.persistRecord, opts.runId, result, true);
  try {
    opts.onTaskTerminal?.(result);
  } catch {
    // Notifications are advisory; durable terminal state remains authoritative.
  }
}

function delegationPolicy(opts: DelegateToolFactoryOptions) {
  if (opts.role.delegation === undefined)
    throw new Error(`role '${opts.role.name}' cannot receive delegate without delegation policy`);
  return opts.role.delegation;
}

function delegationMaxParallel(opts: DelegateToolFactoryOptions): number {
  return delegationPolicy(opts).max_parallel;
}
function delegationMaxChildren(opts: DelegateToolFactoryOptions): number {
  return delegationPolicy(opts).max_children_per_session;
}

function requiredRecords(
  opts: DelegateToolFactoryOptions,
): () => readonly import("../../persistence/log.js").PersistedRecord[] {
  if (opts.records === undefined)
    throw new Error("async delegation scheduler requires durable records");
  return opts.records;
}

function missingMaterializedPaths(childId: string): never {
  throw new Error(`prepared delegated child '${childId}' has no pinned parent projection`);
}
