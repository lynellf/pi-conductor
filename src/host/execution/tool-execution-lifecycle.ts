/** Prepare, durably authorize, and settle one host-owned execution (#106 §6). */

import type {
  SandboxReadyEvidence,
  ToolExecutionSandboxReadyRecord,
} from "../../persistence/sandbox-execution.js";
import {
  reconstructToolExecutionTimeline,
  type ToolExecutionStartedRecord,
} from "../../persistence/tool-execution.js";
import { ToolExecutionError, type ToolExecutionScope } from "./tool-execution-contract.js";

/** A backend owns physical setup and cleanup; the controller owns authorization. */
export interface ToolExecutionLifecycleAdapter<T, Ready> {
  prepare(scope: ToolExecutionScope): Promise<Ready>;
  authorize(): Promise<void>;
  /** Resolve only after status EOF, output persistence, verified init settlement, and launcher close. */
  settle(): Promise<T>;
  /** Latch closure before awaiting setup; settle all late resources, output, and owned processes. */
  terminate(reason: "cancelled" | "failed", graceMs: number): Promise<"confirmed" | "unconfirmed">;
}

/** Author the correlation fields and validate namespace/authority evidence before append. */
export function persistSandboxReadiness(
  started: ToolExecutionStartedRecord,
  evidence: SandboxReadyEvidence,
  append: (record: ToolExecutionSandboxReadyRecord) => void,
): void {
  const record: ToolExecutionSandboxReadyRecord = {
    ...structuredClone(evidence),
    type: "tool_execution_sandbox_ready",
    schema_version: 1,
    run_id: started.run_id,
    execution_id: started.execution_id,
    supervision_id: started.supervision_id,
    logical_session_id: started.logical_session_id,
    role_session_id: started.role_session_id,
    tool_call_id: started.tool_call_id,
    tool_name: started.tool_name,
    ts: Date.now(),
  };
  reconstructToolExecutionTimeline([started, record]);
  append(record);
}

/** Keep the controller's operation pending until physical cleanup has settled. */
export async function executeToolLifecycle<T, Ready>(
  adapter: ToolExecutionLifecycleAdapter<T, Ready>,
  scope: ToolExecutionScope,
  persistReady: (ready: Ready) => void,
): Promise<T> {
  let termination: Promise<"confirmed" | "unconfirmed"> | undefined;
  const stop = (reason: "cancelled" | "failed") => {
    if (termination !== undefined) return termination;
    let resolve!: (
      value: "confirmed" | "unconfirmed" | PromiseLike<"confirmed" | "unconfirmed">,
    ) => void;
    let reject!: (cause: unknown) => void;
    termination = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void termination.catch(() => undefined);
    // Publish the promise before a potentially reentrant call, but latch backend
    // cancellation synchronously so authorize cannot release after this event.
    try {
      resolve(adapter.terminate(reason, scope.graceMs));
    } catch (cause) {
      reject(cause);
    }
    return termination;
  };
  let rejectAbort!: (cause: unknown) => void;
  const abortCause = new Error("execution cancellation requested");
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  void aborted.catch(() => undefined);
  const onAbort = () => {
    void stop("cancelled");
    rejectAbort(abortCause);
  };
  scope.signal.addEventListener("abort", onAbort, { once: true });
  if (scope.signal.aborted) onAbort();
  try {
    scope.assertOpen();
    const ready = await Promise.race([adapter.prepare(scope), aborted]);
    scope.assertOpen();
    persistReady(ready);
    scope.assertOpen();
    await Promise.race([adapter.authorize(), aborted]);
    scope.assertOpen();
    const result = await Promise.race([adapter.settle(), aborted]);
    scope.assertOpen();
    return result;
  } catch (cause) {
    let cleanup: "confirmed" | "unconfirmed";
    try {
      cleanup = await stop(scope.signal.aborted ? "cancelled" : "failed");
    } catch (error) {
      if (cause instanceof ToolExecutionError && cause.code === "tool_persistence_ambiguous")
        throw cause;
      throw new ToolExecutionError(
        "tool_cleanup_unconfirmed",
        "execution cleanup observation failed",
        {
          cleanup: "unconfirmed",
          executionId: scope.executionId,
          cause: error,
        },
      );
    }
    if (cleanup !== "confirmed") {
      if (cause instanceof ToolExecutionError && cause.code === "tool_persistence_ambiguous")
        throw cause;
      throw new ToolExecutionError(
        "tool_cleanup_unconfirmed",
        "execution cleanup remains unconfirmed",
        {
          cleanup: "unconfirmed",
          executionId: scope.executionId,
          cause,
        },
      );
    }
    if (cause === abortCause)
      throw new ToolExecutionError("tool_aborted", "tool execution was aborted", {
        cleanup: "confirmed",
        executionId: scope.executionId,
      });
    // In particular, never replace an ambiguous ready append with a successful result.
    throw cause;
  } finally {
    scope.signal.removeEventListener("abort", onAbort);
  }
}
