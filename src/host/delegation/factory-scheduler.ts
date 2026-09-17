/** Host-owned scheduler construction for shared delegate tools. */

import {
  isToolExecutionRecord,
  type ToolExecutionRecord,
} from "../../persistence/tool-execution.js";
import type { DelegateSubmissionArgs } from "../../seam/schema.js";
import { assertNoUnfinishedToolExecutions } from "../execution/tool-execution-controller.js";
import type { HostRejection } from "../host-rejection.js";
import { prepareDelegateSubmission } from "./admission.js";
import { isPoolCompleted } from "./child-result-mapping.js";
import { DelegationChildSafetyError } from "./child-safety-error.js";
import { buildSpawnCallback } from "./child-session.js";
import { runPreparedChild } from "./delegate-tool.js";
import type {
  DelegateChildFactoryOptions,
  DelegateToolFactoryOptions,
} from "./delegate-tool-factory.js";
import { appendCompleted, appendFailed } from "./factory-records.js";
import type { PoolChildResult } from "./pool.js";
import { DelegationScheduler, type DelegationSchedulerOrigin } from "./scheduler.js";

/** Preserves the exact host terminal observed after asynchronous preparation. */
export class HostDelegationRejectedError extends Error {
  constructor(readonly rejection: HostRejection) {
    super("delegation rejected by terminal parent");
    this.name = "HostDelegationRejectedError";
  }
}

/** Dependencies for host-native scheduler admission without an SDK delegate tool. */
export interface NativeDelegationSchedulerFactoryOptions extends DelegateChildFactoryOptions {
  readonly delegationPolicy: import("../../manifest/types.js").DelegationPolicy;
}

/** Construct one scheduler with the factory's pinned preparation and child adapter. */
export function createDelegateScheduler(
  opts: DelegateToolFactoryOptions,
  logicalParentId: string,
): DelegationScheduler {
  return createNativeDelegateScheduler(
    { ...opts, delegationPolicy: delegationPolicy(opts) },
    logicalParentId,
  );
}

/** Construct controller-native scheduler admission with explicit policy and provenance. */
export function createControllerDelegateScheduler(
  opts: NativeDelegationSchedulerFactoryOptions,
  logicalParentId: string,
  origin: Extract<DelegationSchedulerOrigin, { readonly kind: "controller" }>,
): DelegationScheduler {
  return createNativeDelegateScheduler(opts, logicalParentId, origin);
}

function createNativeDelegateScheduler(
  opts: NativeDelegationSchedulerFactoryOptions,
  logicalParentId: string,
  origin?: DelegationSchedulerOrigin,
): DelegationScheduler {
  const materializedPaths = new Map<string, readonly string[]>();
  const scheduler = new DelegationScheduler({
    identity: {
      runId: opts.runId,
      logicalParentId,
      parentRole: opts.parentRole,
      parentVisitIndex: opts.parentVisitIndex,
      ...(origin === undefined ? {} : { origin }),
    },
    maxParallel: opts.delegationPolicy.max_parallel,
    maxChildren: Math.min(opts.remainingChildren, opts.delegationPolicy.max_children_per_session),
    records: requiredRecords(opts),
    persistRecord: opts.persistRecord,
    prepareSubmission: async (
      input: DelegateSubmissionArgs,
      remainingChildren,
      sourceWorkspaceRef,
    ) => {
      const prepared = await prepareDelegateSubmission({
        args: input,
        policy: opts.delegationPolicy,
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
        ...(opts.hostArtifactResolver === undefined
          ? {}
          : { hostArtifactResolver: opts.hostArtifactResolver }),
        ...(opts.resolveDelegatedSource === undefined
          ? {}
          : { resolveDelegatedSource: opts.resolveDelegatedSource }),
        ...(sourceWorkspaceRef === undefined ? {} : { sourceWorkspaceRef }),
        ...(opts.sandboxAdmission === undefined ? {} : { sandboxAdmission: opts.sandboxAdmission }),
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
        const launchTask = await revalidateSourceAtLaunch(opts, task);
        if (task.sandbox !== undefined) {
          if (opts.sandboxAdmission === undefined)
            throw new Error("sandbox admission is unavailable before child creation");
          await opts.sandboxAdmission.verify({
            childId: launchTask.childId,
            sandbox: task.sandbox,
          });
        }
        const result = await runPreparedChild({
          prepared: launchTask,
          runId: opts.runId,
          parentRole: opts.parentRole,
          primaryCheckout: opts.primaryCheckout,
          parentMaterializedPaths:
            materializedPaths.get(task.childId) ?? missingMaterializedPaths(task.childId),
          systemPromptRoot: opts.systemPromptRoot,
          spawnAndRunChild: buildSpawnCallback(opts),
          signal,
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
        if (opts.captureTaskOutputs === undefined) return result;
        try {
          const outputCapture = await opts.captureTaskOutputs(result);
          return outputCapture === undefined ? result : { ...result, outputCapture };
        } catch {
          // Preserve authoritative usage and lifecycle settlement when evidence capture fails.
          return { ...result, outputCaptureFailure: "child-output-capture-failed" };
        }
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
    onTerminal: (result) => persistTerminal(opts, result),
    ...(opts.onFatal === undefined ? {} : { onFatal: opts.onFatal }),
    ...(opts.isBudgetExhausted === undefined ? {} : { isBudgetExhausted: opts.isBudgetExhausted }),
    ...(opts.getHostRejection === undefined
      ? {}
      : {
          assertAdmissionOpen: () => {
            const rejection = opts.getHostRejection?.() ?? false;
            if (rejection !== false) throw new HostDelegationRejectedError(rejection);
          },
        }),
  });
  return scheduler;
}

async function revalidateSourceAtLaunch(
  opts: NativeDelegationSchedulerFactoryOptions,
  task: import("./admission.js").PreparedDelegateChild,
): Promise<import("./admission.js").PreparedDelegateChild> {
  const pinned = task.resolvedSourceWorkspace;
  if (pinned === undefined) return task;
  if (opts.resolveDelegatedSource === undefined)
    throw new Error("queued source child has no launch-time resolver");
  const current = await opts.resolveDelegatedSource(pinned.ref, task.profile.name);
  if (
    current.checkoutPath === null ||
    current.ref !== pinned.ref ||
    current.sourceId !== pinned.sourceId ||
    current.headCommit !== pinned.headCommit ||
    current.treeId !== pinned.treeId ||
    current.inventoryDigest !== pinned.inventoryDigest ||
    current.policyDigest !== pinned.policyDigest ||
    JSON.stringify(current.audience) !== JSON.stringify(pinned.audience)
  )
    throw new Error("queued source workspace changed or access was revoked");
  return { ...task, resolvedSourceWorkspace: current };
}

function persistTerminal(opts: DelegateChildFactoryOptions, result: PoolChildResult): void {
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

function requiredRecords(
  opts: DelegateChildFactoryOptions,
): () => readonly import("../../persistence/log.js").PersistedRecord[] {
  if (opts.records === undefined)
    throw new Error("async delegation scheduler requires durable records");
  return opts.records;
}

function missingMaterializedPaths(childId: string): never {
  throw new Error(`prepared delegated child '${childId}' has no pinned parent projection`);
}
