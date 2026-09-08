/**
 * Parent-owned delegate tool and standalone child-session adapter — delegation
 * lite §§4, 6–7 / Issue #57 §§6–8. Child settlement, record append, and
 * cancellation share one lifecycle boundary; no child calls the reducer.
 */

import type { ModelRegistry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";

import type { Role } from "../../core/types.js";
import {
  assertDelegationMode,
  delegateModeDescription,
  resolveDelegationMode,
} from "../../manifest/delegation-mode.js";
import type { DelegationPolicy, RoleConfig, SubagentProfile } from "../../manifest/types.js";
import type { PersistedRecord } from "../../persistence/log.js";
import {
  type DelegateArgs,
  type DelegateControlArgs,
  type DelegateSubmissionArgs,
  delegateArgsSchema,
  delegateArgsSchemaForMode,
} from "../../seam/schema.js";
import type { DisplaySink } from "../display-sink.js";
import { mapPoolResult } from "./child-result-mapping.js";
import { buildSpawnCallback } from "./child-session.js";
import { DelegateToolError, executeDelegate } from "./delegate-tool.js";
import { appendCompleted, appendFailed, errorMessage } from "./factory-records.js";
import type { DelegationManager } from "./manager.js";
import type { PoolChildResult } from "./pool.js";
import type { DelegationScheduler } from "./scheduler.js";

/** Dependencies for a parent role's delegate tool. */
export interface DelegateToolFactoryOptions {
  readonly role: RoleConfig;
  readonly subagents: readonly SubagentProfile[];
  readonly remainingChildren: number;
  readonly runId: string;
  readonly parentRole: Role;
  readonly parentVisitIndex: number;
  readonly primaryCheckout: string;
  readonly runStateDir: string;
  readonly persistRecord: (record: PersistedRecord) => void;
  readonly agentDir: string;
  readonly systemPromptRoot: string;
  readonly modelRegistry: ModelRegistry;
  readonly resolveChildModel?: (model: string) => ReturnType<ModelRegistry["find"]>;
  readonly displaySink?: DisplaySink;
  readonly sessionDir: string;
  readonly manager: DelegationManager;
  readonly records?: () => readonly PersistedRecord[];
  readonly onFatal?: (cause: unknown) => void;
  readonly isBudgetExhausted?: () => boolean;
  /** Advisory notification after the durable child terminal is appended. */
  readonly onTaskTerminal?: (result: PoolChildResult) => void;
  /** Optional #77 scheduler supplied by the host-owned lifecycle. */
  readonly scheduler?: DelegationScheduler;
  /** Trusted resolved mode from the run snapshot; omitted means resolve policy. */
  readonly delegationMode?: import("../../manifest/types.js").DelegationMode;
  /** Explicit durable provenance for pre-#86 snapshots without a mode field. */
  readonly legacyDelegationMode?: boolean;
}

/** Create a parent-only delegate tool; it never creates an FSM event. */
export function createDelegateTool(opts: DelegateToolFactoryOptions): ToolDefinition {
  const policy = delegationPolicy(opts.role);
  const configuredMode =
    opts.legacyDelegationMode === true
      ? undefined
      : (opts.delegationMode ?? resolveDelegationMode(policy));
  const parameters =
    configuredMode === undefined ? delegateArgsSchema : delegateArgsSchemaForMode(configuredMode);
  let remaining = Math.min(opts.remainingChildren, policy.max_children_per_session);
  let executionTail = Promise.resolve();

  return defineTool<typeof delegateArgsSchema, Record<string, unknown>>({
    name: "delegate",
    label: "delegate",
    description:
      configuredMode === undefined
        ? "Submit independent coding tasks in isolated Git worktrees. Use blocking or nonblocking mode; controls retrieve or cancel accepted child handles."
        : `Submit independent coding tasks in isolated Git worktrees. ${delegateModeDescription(configuredMode)} Controls retrieve or cancel accepted child handles.`,
    parameters: parameters as typeof delegateArgsSchema,
    async execute(_toolCallId, args, signal) {
      if (!isSubmission(args)) {
        if (opts.scheduler === undefined) throw new Error("delegation controls are unavailable");
        const statuses = await executeControl(
          opts.scheduler,
          args.operation,
          args.child_ids,
          signal,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(statuses) }],
          details: { operation: args.operation },
          terminate: false,
        };
      }
      const effectiveMode = configuredMode ?? args.mode ?? "blocking";
      if (configuredMode !== undefined && args.mode !== undefined && args.mode !== configuredMode) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "delegate_failed",
                code: "delegation_mode_mismatch",
                message: `delegate mode mismatch: manifest configures ${configuredMode}; omit mode or use mode: ${configuredMode}`,
              }),
            },
          ],
          details: {
            remainingChildren: opts.scheduler?.remainingChildren() ?? remaining,
            code: "delegation_mode_mismatch",
          },
          isError: true,
          terminate: false,
        };
      }
      const abortChildren = (): void => {
        void opts.manager.abortAll();
      };
      signal?.addEventListener("abort", abortChildren, { once: true });
      const previousExecution = executionTail;
      let finishExecution: () => void = () => {};
      executionTail = new Promise<void>((resolve) => {
        finishExecution = resolve;
      });
      try {
        if (configuredMode !== undefined) assertDelegationMode(configuredMode, args.mode);
        if (effectiveMode === "nonblocking" && opts.scheduler === undefined) {
          throw new Error("nonblocking delegation requires the shared scheduler");
        }
        await previousExecution;
        if (opts.scheduler !== undefined) {
          const scheduler = opts.scheduler;
          const childIds = await scheduler.submit(_toolCallId, args);
          if (effectiveMode === "nonblocking")
            return {
              content: [{ type: "text", text: JSON.stringify({ child_ids: childIds }) }],
              details: { remainingChildren: scheduler.remainingChildren() },
              terminate: false,
            };
          const results = await Promise.all(
            childIds.map((childId) => scheduler.wait(childId, signal)),
          );
          if (opts.manager.isClosed()) {
            throw new Error("delegation unavailable: parent session is closed");
          }
          return {
            content: [
              { type: "text", text: JSON.stringify({ results: results.map(mapPoolResult) }) },
            ],
            details: { remainingChildren: scheduler.remainingChildren() },
            terminate: false,
          };
        }
        const result = await executeDelegate({
          args,
          policy,
          profiles: opts.subagents,
          remainingChildren: remaining,
          runStateDir: opts.runStateDir,
          runId: opts.runId,
          parentRole: opts.parentRole,
          primaryCheckout: opts.primaryCheckout,
          systemPromptRoot: opts.systemPromptRoot,
          spawnAndRunChild: buildSpawnCallback(opts),
          isAdmissionClosed: () => opts.manager.isClosed(),
          onChildStarted: () => {},
          onChildCompleted: (child) => appendCompleted(opts.persistRecord, opts.runId, child),
          onChildFailed: (child) => appendFailed(opts.persistRecord, opts.runId, child),
        });
        remaining -= args.tasks.length;
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: { remainingChildren: remaining },
          terminate: false,
        };
      } catch (cause) {
        const error = cause instanceof DelegateToolError ? cause : undefined;
        const code = error?.code ?? "delegate_execution_failed";
        if (error?.code === "batch_validation_failed") {
          opts.persistRecord({
            type: "delegation_validation_rejected",
            run_id: opts.runId,
            parent_role: opts.parentRole,
            parent_visit_index: opts.parentVisitIndex,
            task_ids: Object.freeze(isSubmission(args) ? args.tasks.map((task) => task.id) : []),
            code,
            errors: Object.freeze(error.errors.map((item) => Object.freeze({ ...item }))),
            ts: Date.now(),
          });
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "delegate_failed",
                code,
                message: errorMessage(cause),
              }),
            },
          ],
          details: {
            remainingChildren: opts.scheduler?.remainingChildren() ?? remaining,
            code,
            ...(error === undefined ? {} : { errors: error.errors }),
          },
          isError: true,
          terminate: false,
        };
      } finally {
        signal?.removeEventListener("abort", abortChildren);
        finishExecution();
      }
    },
  });
}

function delegationPolicy(role: RoleConfig): DelegationPolicy {
  if (role.delegation === undefined) {
    throw new Error(`role '${role.name}' cannot receive delegate without delegation policy`);
  }
  return role.delegation;
}

function isSubmission(args: DelegateArgs): args is DelegateSubmissionArgs {
  return "tasks" in args;
}

async function executeControl(
  scheduler: DelegationScheduler,
  operation: DelegateControlArgs["operation"],
  childIds: readonly string[],
  signal: AbortSignal | undefined,
): Promise<unknown> {
  if (operation === "status" || operation === "result")
    return scheduler.status(childIds).map(mapSchedulerStatus);
  if (operation === "cancel") {
    await scheduler.cancel(childIds);
    return scheduler.status(childIds).map(mapSchedulerStatus);
  }
  return {
    results: (await Promise.all(childIds.map((childId) => scheduler.wait(childId, signal)))).map(
      mapPoolResult,
    ),
  };
}

function mapSchedulerStatus(status: ReturnType<DelegationScheduler["status"]>[number]) {
  return {
    child_id: status.childId,
    task_id: status.taskId,
    submission_id: status.submissionId,
    status: status.status,
    ...(status.result === undefined ? {} : { result: mapPoolResult(status.result) }),
  };
}
