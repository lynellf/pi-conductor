/** Model-facing sandbox command and retained-output tools — Issue #106 §7. */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { SandboxAdmissionRecord } from "../../../persistence/sandbox-admission.js";
import {
  assertSandboxExecutionTerminal,
  type SandboxExecutionTerminal,
} from "../../../persistence/sandbox-command.js";
import type { SandboxProjectMaterializationDescriptor } from "../../../persistence/sandbox-materialization.js";
import { type ToolExecutionController, ToolExecutionError } from "../tool-execution-controller.js";
import { createSandboxCommandRunner, type SandboxCommandResult } from "./command-runner.js";
import type { SandboxHostApproval } from "./host-approval.js";
import type { SandboxOperationGate } from "./operation-gate.js";
import { readSandboxExecutionOutput } from "./output-retrieval.js";

const bashParameters = Type.Object(
  {
    command: Type.String({ minLength: 1, maxLength: 1_048_576 }),
    timeout: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);
const outputParameters = Type.Object(
  {
    output_ref: Type.String({
      pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$",
    }),
    stream: Type.Union([Type.Literal("stdout"), Type.Literal("stderr")]),
    offset: Type.Integer({ minimum: 0 }),
    max_bytes: Type.Integer({ minimum: 1, maximum: 65_536 }),
  },
  { additionalProperties: false },
);

export interface SandboxCommandToolsOptions {
  readonly gate: SandboxOperationGate;
  readonly admission: SandboxAdmissionRecord;
  readonly project: SandboxProjectMaterializationDescriptor;
  readonly runStateDir: string;
  readonly hostApproval: SandboxHostApproval;
  readonly getController: () => ToolExecutionController | null;
  readonly childSignal: AbortSignal;
}

/** Build exactly the sandbox `bash` and retained-output tools for one child. */
export function createSandboxCommandTools(
  supplied: SandboxCommandToolsOptions,
): readonly [ToolDefinition, ToolDefinition] {
  const options = {
    ...supplied,
    admission: structuredClone(supplied.admission),
    project: structuredClone(supplied.project),
    hostApproval: structuredClone(supplied.hostApproval),
  };
  assertOwner(options);
  const bash = defineTool<typeof bashParameters, Record<string, unknown>>({
    name: "bash",
    label: "bash",
    description: "Run one foreground command in the admitted sandbox.",
    parameters: bashParameters,
    execute: async (toolCallId, input: Static<typeof bashParameters>, signal) => {
      if (!Value.Check(bashParameters, input))
        return errorResult("invalid sandbox command arguments");
      const controller = options.getController();
      if (controller === null) return errorResult("sandbox execution controller is unavailable");
      if (input.command.includes("\0")) return errorResult("sandbox command must be NUL-free");
      const combined = combineSignals(options.childSignal, signal);
      let terminalEvidence: (() => SandboxExecutionTerminal) | undefined;
      try {
        const result = await options.gate.run(combined.signal, async (gateSignal) => {
          const runner = createSandboxCommandRunner({
            binaryPath: options.hostApproval.binaryPath,
            approvedBuilds: options.hostApproval.approvedBuilds,
            ...(options.hostApproval.getcapPath === undefined
              ? {}
              : { getcapPath: options.hostApproval.getcapPath }),
            bootstrapApproval: options.hostApproval.bootstrapApproval,
            runStateDir: options.runStateDir,
            admission: options.admission,
            project: options.project,
            command: input.command,
          });
          terminalEvidence = runner.terminalEvidence;
          let value: SandboxCommandResult;
          try {
            value = await controller.runLifecycle(
              "bash",
              toolCallId,
              { child_id: options.admission.childId, descriptor: options.admission.sandbox },
              runner,
              {
                signal: gateSignal,
                ...(input.timeout === undefined ? {} : { modelTimeoutSeconds: input.timeout }),
              },
            );
          } catch (cause) {
            if (
              (cause instanceof ToolExecutionError &&
                (cause.cleanup === "unconfirmed" || cause.code === "tool_persistence_ambiguous")) ||
              runner.terminalEvidence().cleanup === "unconfirmed"
            )
              options.gate.seal(cause);
            throw cause;
          }
          gateSignal.throwIfAborted();
          return value;
        });
        return {
          content: [{ type: "text", text: JSON.stringify(formatCommandResult(result)) }],
          details: formatCommandResult(result),
          terminate: false,
        };
      } catch (cause) {
        return errorResult(safeError(cause), terminalEvidence?.(), cause);
      } finally {
        combined.dispose();
      }
    },
  });
  const output = defineTool<typeof outputParameters, Record<string, unknown>>({
    name: "read_execution_output",
    label: "read_execution_output",
    description: "Read a bounded chunk of your own retained command output.",
    parameters: outputParameters,
    execute: async (_toolCallId, input: Static<typeof outputParameters>, signal) => {
      if (!Value.Check(outputParameters, input))
        return errorResult("invalid output read arguments");
      const combined = combineSignals(options.childSignal, signal);
      try {
        const chunk = await options.gate.run(combined.signal, async (gateSignal) => {
          const value = await readSandboxExecutionOutput({
            runStateDir: options.runStateDir,
            expectedRunId: options.admission.runId,
            expectedChildId: options.admission.childId,
            outputRef: input.output_ref,
            stream: input.stream,
            offset: input.offset,
            maxBytes: input.max_bytes,
          });
          gateSignal.throwIfAborted();
          return value;
        });
        return {
          content: [{ type: "text", text: JSON.stringify(chunk) }],
          details: { ...chunk },
          terminate: false,
        };
      } catch (cause) {
        return errorResult(safeError(cause));
      } finally {
        combined.dispose();
      }
    },
  });
  return [bash, output];
}

function assertOwner(options: SandboxCommandToolsOptions): void {
  if (
    options.gate.owner.runId !== options.admission.runId ||
    options.gate.owner.childId !== options.admission.childId ||
    options.project.runId !== options.admission.runId ||
    options.project.childId !== options.admission.childId
  )
    throw new Error("sandbox command tools have inconsistent child ownership");
}

function formatCommandResult(result: SandboxCommandResult) {
  return {
    status: result.normalizedStatus,
    signal: result.signal,
    execution_id: result.executionId,
    output_ref: result.output.outputRef,
    capture: result.output.capture,
    stdout_bytes: result.output.stdout.byteCount,
    stderr_bytes: result.output.stderr.byteCount,
    previews: result.previews,
  };
}

function errorResult(message: string, terminal?: SandboxExecutionTerminal, cause?: unknown) {
  let safeTerminal: SandboxExecutionTerminal | undefined;
  if (terminal !== undefined) {
    try {
      assertSandboxExecutionTerminal(terminal);
      safeTerminal = structuredClone(terminal);
    } catch {
      // The controller already closes an invalid backend; do not expose arbitrary data.
    }
  }
  const payload = {
    error: message.slice(0, 512),
    ...(cause instanceof ToolExecutionError
      ? {
          code: cause.code,
          cleanup: cause.cleanup,
          ...(cause.executionId === undefined ? {} : { execution_id: cause.executionId }),
        }
      : {}),
    ...(safeTerminal === undefined ? {} : { terminal: safeTerminal }),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    details: payload,
    isError: true,
    terminate: false,
  };
}

function safeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message.slice(0, 512);
  return "sandbox command failed";
}

function combineSignals(
  child: AbortSignal,
  tool: AbortSignal | undefined,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  child.addEventListener("abort", abort, { once: true });
  tool?.addEventListener("abort", abort, { once: true });
  if (child.aborted || tool?.aborted) controller.abort();
  return {
    signal: controller.signal,
    dispose: () => {
      child.removeEventListener("abort", abort);
      tool?.removeEventListener("abort", abort);
    },
  };
}
