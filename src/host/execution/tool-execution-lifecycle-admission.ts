import { Value } from "typebox/value";
import type {
  AnySandboxExecutionOwner,
  ControllerSandboxExecutionOwner,
  SandboxExecutionOwner,
} from "../../persistence/sandbox-execution.js";
import { sandboxExecutionOwnerSchema } from "../../persistence/sandbox-execution.js";
import type {
  AnyToolExecutionStartedRecord,
  ControllerExecutionOrigin,
  ToolExecutionRecord,
} from "../../persistence/tool-execution.js";
import { sameControllerExecutionOrigin } from "../../persistence/tool-execution-origin.js";
import type { ToolExecutionRunOptions, ToolExecutionScope } from "./tool-execution-contract.js";
import { ToolExecutionError } from "./tool-execution-contract.js";
import { controllerLifecycleOperation } from "./tool-execution-controller-support.js";
import type { SandboxToolExecutionAdapter } from "./tool-execution-lifecycle.js";

export interface PreparedSandboxLifecycle<T> {
  readonly owner: AnySandboxExecutionOwner;
  readonly operation: (scope: ToolExecutionScope) => Promise<T>;
  readonly terminalEvidence: () => ReturnType<SandboxToolExecutionAdapter<T>["terminalEvidence"]>;
}

type LifecycleCallbacks = {
  readonly started: (executionId: string) => AnyToolExecutionStartedRecord | undefined;
  readonly append: (record: ToolExecutionRecord) => void;
};

/** Validate immutable sandbox ownership before a lifecycle-backed tool admission. */
export function prepareSdkLifecycle<T>(
  sandbox: SandboxExecutionOwner,
  adapter: SandboxToolExecutionAdapter<T>,
  runOptions: ToolExecutionRunOptions,
  callbacks: LifecycleCallbacks,
): PreparedSandboxLifecycle<T> {
  if (
    runOptions.captureAdmission !== undefined ||
    !Value.Check(sandboxExecutionOwnerSchema, sandbox)
  ) {
    throw new ToolExecutionError(
      "tool_input_invalid",
      "sandbox execution requires valid ownership evidence",
    );
  }
  return prepare(adapter, structuredClone(sandbox), callbacks);
}

/** Validate controller provenance matches the controller-owned sandbox lifecycle. */
export function prepareControllerLifecycle<T>(
  origin: ControllerExecutionOrigin,
  sandbox: ControllerSandboxExecutionOwner,
  adapter: SandboxToolExecutionAdapter<T>,
  runOptions: ToolExecutionRunOptions,
  callbacks: LifecycleCallbacks,
): PreparedSandboxLifecycle<T> {
  if (
    runOptions.captureAdmission !== undefined ||
    !Value.Check(sandboxExecutionOwnerSchema, sandbox) ||
    sandbox.kind !== "controller_operation" ||
    !sameControllerExecutionOrigin(origin, sandbox.origin)
  ) {
    throw new ToolExecutionError(
      "tool_input_invalid",
      "controller sandbox execution requires matching pinned ownership evidence",
    );
  }
  return prepare(adapter, structuredClone(sandbox), callbacks);
}

function prepare<T>(
  adapter: SandboxToolExecutionAdapter<T>,
  owner: AnySandboxExecutionOwner,
  callbacks: LifecycleCallbacks,
): PreparedSandboxLifecycle<T> {
  return {
    owner,
    operation: controllerLifecycleOperation(adapter, callbacks.started, callbacks.append),
    terminalEvidence: () => adapter.terminalEvidence(),
  };
}
