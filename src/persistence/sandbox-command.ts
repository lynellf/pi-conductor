/** Durable command status and output evidence; normalized signals are never guessed (#106 §7). */
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type {
  AnySandboxExecutionOwner,
  AnyToolExecutionSandboxReadyRecord,
} from "./sandbox-execution.js";
import { sandboxOutputFinalRecordSchema } from "./sandbox-output.js";
import type { AnyToolExecutionFinishedRecord } from "./tool-execution.js";

/** Metadata-only terminal evidence from a settled or explicitly uncertain sandbox. */
export const sandboxExecutionTerminalSchema = Type.Object(
  {
    category: Type.Union([
      Type.Literal("setup_failed"),
      Type.Literal("command_status"),
      Type.Literal("authorization_ambiguous"),
      Type.Literal("output_incomplete"),
      Type.Literal("interrupted"),
      Type.Literal("cleanup_unconfirmed"),
    ]),
    normalized_status: Type.Union([Type.Integer({ minimum: 0, maximum: 255 }), Type.Null()]),
    signal: Type.Literal("unknown"),
    termination_requested: Type.Boolean(),
    cleanup: Type.Union([Type.Literal("confirmed"), Type.Literal("unconfirmed")]),
    output_ref: Type.Optional(
      Type.String({
        pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$",
      }),
    ),
    output: Type.Optional(sandboxOutputFinalRecordSchema),
  },
  { additionalProperties: false },
);

/** Command-result evidence derived from the only durable boundary schema. */
export type SandboxExecutionTerminal = Readonly<Static<typeof sandboxExecutionTerminalSchema>>;

/** Typed rejection for conflicting command or retained-output evidence. */
export class SandboxCommandRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxCommandRecordError";
  }
}

/** Reject guessed signals, contradictory capture claims, and mismatched output references. */
export function assertSandboxExecutionTerminal(
  value: unknown,
): asserts value is SandboxExecutionTerminal {
  if (!Value.Check(sandboxExecutionTerminalSchema, value))
    throw new SandboxCommandRecordError("invalid sandbox command terminal evidence");
  if ((value.cleanup === "unconfirmed") !== (value.category === "cleanup_unconfirmed"))
    throw new SandboxCommandRecordError("sandbox terminal cleanup and category disagree");
  if (value.output !== undefined && value.output.outputRef !== value.output_ref)
    throw new SandboxCommandRecordError("sandbox terminal output reference mismatch");
  if (
    value.category === "command_status" &&
    (value.normalized_status === null || value.output?.capture !== "complete")
  )
    throw new SandboxCommandRecordError(
      "command status requires complete retained output and observed status",
    );
  if (value.category === "setup_failed" && value.normalized_status !== null)
    throw new SandboxCommandRecordError("setup failure cannot claim command status");
}

/** Bind terminal evidence to the start owner and any durable authorization record. */
export function assertSandboxTerminalCorrelation(
  owner: AnySandboxExecutionOwner | undefined,
  ready: AnyToolExecutionSandboxReadyRecord | undefined,
  finished: AnyToolExecutionFinishedRecord,
): void {
  if ((owner === undefined) !== (finished.sandbox === undefined))
    throw new SandboxCommandRecordError(
      "sandbox terminal evidence must match the execution backend",
    );
  const terminal = finished.sandbox;
  if (terminal === undefined) return;
  assertSandboxExecutionTerminal(terminal);
  if (terminal.cleanup !== finished.cleanup)
    throw new SandboxCommandRecordError("sandbox terminal disagrees with controller cleanup");
  if (ready !== undefined && terminal.output_ref !== ready.output_ref)
    throw new SandboxCommandRecordError(
      "sandbox terminal does not retain its ready output reference",
    );
  if (ready !== undefined && terminal.category === "setup_failed")
    throw new SandboxCommandRecordError("setup failure cannot follow durable sandbox readiness");
  if (finished.outcome === "completed" && terminal.category !== "command_status")
    throw new SandboxCommandRecordError(
      "completed sandbox execution requires observed command status",
    );
  if (
    ready === undefined &&
    (terminal.category === "command_status" ||
      terminal.category === "authorization_ambiguous" ||
      terminal.normalized_status !== null)
  )
    throw new SandboxCommandRecordError("command evidence requires durable sandbox readiness");
}
