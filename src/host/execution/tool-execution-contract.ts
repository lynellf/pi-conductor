/** Host execution controller contracts, including cleanup certainty (#76/#106). */
import type { ToolExecutionPolicy } from "../../manifest/execution-policy.js";
import type { ToolAdmissionEvidence } from "../../persistence/tool-admission.js";
import type { ToolExecutionRecord } from "../../persistence/tool-execution.js";
import type { ToolExecutionDiagnostic } from "../../persistence/tool-execution-diagnostic.js";

export type ToolExecutionErrorCode =
  | "tool_input_invalid"
  | "tool_timeout"
  | "tool_timeout_exhausted"
  | "tool_cleanup_unconfirmed"
  | "tool_aborted"
  | "tool_failed"
  | "tool_persistence_ambiguous"
  | "tool_closed"
  | "tool_resume_unknown_owner";

/** Structured controller failure surfaced at the model boundary. */
export class ToolExecutionError extends Error {
  readonly code: ToolExecutionErrorCode;
  readonly cleanup: "confirmed" | "unconfirmed" | "not-started";
  readonly executionId: string | undefined;
  readonly diagnostic: ToolExecutionDiagnostic | undefined;

  constructor(
    code: ToolExecutionErrorCode,
    message: string,
    options?: {
      readonly cleanup?: "confirmed" | "unconfirmed" | "not-started";
      readonly executionId?: string;
      readonly diagnostic?: ToolExecutionDiagnostic;
      readonly cause?: unknown;
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ToolExecutionError";
    this.code = code;
    this.cleanup = options?.cleanup ?? "not-started";
    this.executionId = options?.executionId;
    this.diagnostic = options?.diagnostic;
  }
}

export interface ToolExecutionScope {
  readonly executionId: string;
  readonly supervisionId: string;
  readonly signal: AbortSignal;
  readonly graceMs: number;
  remainingTimeoutMs(): number;
  assertOpen(): void;
}

export interface ToolExecutionRunOptions {
  readonly signal?: AbortSignal;
  /** Capture recovery evidence before persisting the start and admitting side effects (#103). */
  readonly captureAdmission?: () => Promise<ToolAdmissionEvidence>;
  /** A model-supplied deadline may shorten the pinned policy only. */
  readonly modelTimeoutSeconds?: number;
}

export interface ToolExecutionControllerOptions {
  readonly runId: string;
  readonly logicalSessionId: string;
  readonly roleSessionId: string;
  readonly policy: Readonly<Required<ToolExecutionPolicy>>;
  readonly persist: (record: ToolExecutionRecord) => void;
  readonly priorRecords?: readonly ToolExecutionRecord[];
  readonly onFatal?: (error: ToolExecutionError) => void;
  readonly idFactory?: () => string;
}
