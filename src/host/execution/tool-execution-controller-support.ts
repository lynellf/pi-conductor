/** Record construction and lifecycle glue for the physical execution controller. */

import type {
  AnySandboxExecutionOwner,
  ControllerSandboxExecutionOwner,
  SandboxExecutionOwner,
} from "../../persistence/sandbox-execution.js";
import type { ToolAdmissionEvidence } from "../../persistence/tool-admission.js";
import type {
  AnyToolExecutionStartedRecord,
  ControllerExecutionOrigin,
  ToolExecutionFinishedRecord,
  ToolExecutionRecord,
} from "../../persistence/tool-execution.js";
import { SupervisedProcessError } from "./supervised-process.js";
import { ToolExecutionError, type ToolExecutionScope } from "./tool-execution-contract.js";
import {
  executeToolLifecycle,
  persistSandboxReadiness,
  type SandboxToolExecutionAdapter,
} from "./tool-execution-lifecycle.js";

export type ExecutionInvocation =
  | { readonly kind: "sdk"; readonly toolName: string; readonly toolCallId: string }
  | { readonly kind: "controller"; readonly origin: ControllerExecutionOrigin };

/** Construct one closed start variant without mixing SDK and controller identities. */
export function buildExecutionStart(input: {
  readonly identity: ExecutionInvocation;
  readonly runId: string;
  readonly logicalSessionId: string;
  readonly roleSessionId: string;
  readonly executionId: string;
  readonly supervisionId: string;
  readonly timeoutMs: number;
  readonly recoveryCount: number;
  readonly startedAt: number;
  readonly admission?: ToolAdmissionEvidence;
  readonly sandbox?: AnySandboxExecutionOwner;
}): AnyToolExecutionStartedRecord {
  const common = {
    type: "tool_execution_started" as const,
    run_id: input.runId,
    execution_id: input.executionId,
    supervision_id: input.supervisionId,
    timeout_ms: input.timeoutMs,
    recovery_count: input.recoveryCount,
    ts: input.startedAt,
  };
  if (input.identity.kind === "sdk")
    return {
      ...common,
      schema_version: 1,
      logical_session_id: input.logicalSessionId,
      role_session_id: input.roleSessionId,
      tool_call_id: input.identity.toolCallId,
      tool_name: input.identity.toolName,
      ...(input.admission === undefined ? {} : { admission: input.admission }),
      ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox as SandboxExecutionOwner }),
    };
  return {
    ...common,
    schema_version: 2,
    origin: structuredClone(input.identity.origin),
    ...(input.sandbox === undefined
      ? {}
      : { sandbox: input.sandbox as ControllerSandboxExecutionOwner }),
  };
}

/** Adapt verified backend phases to the controller's attempt callback. */
export function controllerLifecycleOperation<T>(
  adapter: SandboxToolExecutionAdapter<T>,
  findStarted: (executionId: string) => AnyToolExecutionStartedRecord | undefined,
  append: (record: ToolExecutionRecord) => void,
): (scope: ToolExecutionScope) => Promise<T> {
  return (scope) =>
    executeToolLifecycle(adapter, scope, (evidence) => {
      const started = findStarted(scope.executionId);
      if (started === undefined) throw new Error("sandbox execution start is missing");
      persistSandboxReadiness(started, evidence, append);
    });
}

/** Count confirmed timeouts in the stable SDK session or pinned controller scope. */
export function executionTimeoutCount(
  records: readonly ToolExecutionRecord[],
  runId: string,
  scope:
    | { readonly kind: "sdk"; readonly logicalSessionId: string }
    | { readonly kind: "controller"; readonly origin: ControllerExecutionOrigin },
): number {
  return records.filter((record) => {
    if (
      record.type !== "tool_execution_finished" ||
      record.outcome !== "timed_out" ||
      record.run_id !== runId
    )
      return false;
    if (scope.kind === "sdk")
      return record.schema_version === 1 && record.logical_session_id === scope.logicalSessionId;
    return (
      record.schema_version === 2 &&
      record.origin.controller_id === scope.origin.controller_id &&
      record.origin.definition_digest === scope.origin.definition_digest
    );
  }).length;
}

export function diagnosticFrom(cause: unknown): ToolExecutionFinishedRecord["diagnostic"] {
  return cause instanceof SupervisedProcessError ? cause.diagnostic : undefined;
}

export function isSupervisedTimeout(error: unknown): boolean {
  return error instanceof SupervisedProcessError && error.code === "supervised-process-timeout";
}

export function isSupervisedAbort(error: unknown): boolean {
  return error instanceof SupervisedProcessError && error.code === "supervised-process-aborted";
}

export function safeMilliseconds(seconds: number): number {
  const milliseconds = seconds * 1_000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1)
    throw new ToolExecutionError(
      "tool_input_invalid",
      "tool deadline cannot be represented safely",
    );
  return milliseconds;
}

export function effectiveTimeoutSeconds(pinned: number, requested: number | undefined): number {
  if (requested === undefined) return pinned;
  if (!Number.isInteger(requested) || !Number.isFinite(requested))
    throw new ToolExecutionError("tool_input_invalid", "model timeout must be a finite integer");
  if (requested <= 0 || requested > pinned)
    throw new ToolExecutionError(
      "tool_input_invalid",
      "model timeout must be positive and no greater than the pinned deadline",
    );
  return requested;
}
