/** Safe SDK-facing error conversion for supervised tool failures — §76. */

import { Value } from "typebox/value";
import type { ToolExecutionDiagnostic } from "../../persistence/tool-execution-diagnostic.js";
import { toolExecutionDiagnosticSchema } from "../../persistence/tool-execution-diagnostic.js";

export interface ToolExecutionModelErrorFields {
  readonly code: string;
  readonly cleanup: "confirmed" | "unconfirmed" | "not-started";
  readonly executionId?: string;
  readonly diagnostic?: ToolExecutionDiagnostic;
}

/** Error whose JSON message is safe for the model-facing SDK boundary. */
export class ToolExecutionModelError extends Error {
  readonly code: string;
  readonly cleanup: "confirmed" | "unconfirmed" | "not-started";
  readonly executionId?: string;

  constructor(fields: ToolExecutionModelErrorFields, diagnostic: string) {
    const message = JSON.stringify({
      code: fields.code,
      cleanup: fields.cleanup,
      ...(fields.executionId === undefined ? {} : { executionId: fields.executionId }),
      ...(fields.diagnostic === undefined ? {} : { diagnostic: fields.diagnostic }),
      message: safeDiagnostic(diagnostic),
    });
    super(message);
    this.name = "ToolExecutionModelError";
    this.code = fields.code;
    this.cleanup = fields.cleanup;
    if (fields.executionId !== undefined) this.executionId = fields.executionId;
  }
}

/** Convert a caught controller/worker error without carrying raw arguments or output. */
export function toToolExecutionModelError(error: unknown): ToolExecutionModelError {
  const candidate: Partial<ToolExecutionModelErrorFields> & {
    readonly cause?: unknown;
    readonly message?: unknown;
    readonly diagnostic?: unknown;
  } = typeof error === "object" && error !== null ? error : {};
  const code = typeof candidate.code === "string" ? candidate.code : "tool_failed";
  const cleanup =
    candidate.cleanup === "confirmed" ||
    candidate.cleanup === "unconfirmed" ||
    candidate.cleanup === "not-started"
      ? candidate.cleanup
      : "not-started";
  const executionId = typeof candidate.executionId === "string" ? candidate.executionId : undefined;
  const structuredDiagnostic = isSafeDiagnostic(candidate.diagnostic)
    ? candidate.diagnostic
    : undefined;
  const cause = candidate.cause;
  const textDiagnostic =
    code === "tool_failed" && cause instanceof Error
      ? cause.message
      : error instanceof Error
        ? error.message
        : String(error);
  const boundedDiagnostic = textDiagnostic.slice(0, 300);
  const guidance =
    code === "tool_timeout" ||
    code === "tool_timeout_exhausted" ||
    code === "tool_aborted" ||
    code === "tool_cleanup_unconfirmed" ||
    code === "tool_persistence_ambiguous"
      ? `${boundedDiagnostic}. The operation was not replayed; partial file effects may remain. Inspect the workspace before repair.`
      : textDiagnostic;
  return new ToolExecutionModelError(
    {
      code,
      cleanup,
      ...(executionId === undefined ? {} : { executionId }),
      ...(structuredDiagnostic === undefined ? {} : { diagnostic: structuredDiagnostic }),
    },
    guidance,
  );
}

function isSafeDiagnostic(value: unknown): value is ToolExecutionDiagnostic {
  return Value.Check(toolExecutionDiagnosticSchema, value);
}

function safeDiagnostic(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .slice(0, 512);
}
