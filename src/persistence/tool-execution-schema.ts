/** Closed v1 SDK and v2 controller executable-record schemas. */

import { type Static, Type } from "typebox";
import { sandboxExecutionTerminalSchema } from "./sandbox-command.js";
import { controllerSandboxExecutionOwnerSchema } from "./sandbox-execution.js";
import { subagentSandboxDescriptorSchema } from "./subagent-sandbox.js";
import { toolAdmissionSchema } from "./tool-admission.js";
import { toolExecutionDiagnosticSchema } from "./tool-execution-diagnostic.js";
import { controllerExecutionOriginSchema } from "./tool-execution-origin.js";

const id = Type.String({ minLength: 1 });
const nonNegativeInteger = Type.Integer({ minimum: 0 });

/** TypeBox schema for the exact JSON shape retained at process execution start. */
export const toolExecutionStartedV1Schema = Type.Object(
  {
    type: Type.Literal("tool_execution_started"),
    schema_version: Type.Literal(1),
    run_id: id,
    execution_id: id,
    supervision_id: id,
    logical_session_id: id,
    role_session_id: id,
    tool_call_id: id,
    tool_name: id,
    origin: Type.Optional(Type.Never()),
    timeout_ms: Type.Integer({ minimum: 1 }),
    recovery_count: nonNegativeInteger,
    admission: Type.Optional(toolAdmissionSchema),
    sandbox: Type.Optional(
      Type.Object(
        { child_id: id, descriptor: subagentSandboxDescriptorSchema },
        { additionalProperties: false },
      ),
    ),
    ts: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** TypeBox schema for the exact JSON shape retained at process execution terminal. */
export const toolExecutionFinishedV1Schema = Type.Object(
  {
    type: Type.Literal("tool_execution_finished"),
    schema_version: Type.Literal(1),
    run_id: id,
    execution_id: id,
    supervision_id: id,
    logical_session_id: id,
    role_session_id: id,
    tool_call_id: id,
    tool_name: id,
    origin: Type.Optional(Type.Never()),
    elapsed_ms: Type.Number({ minimum: 0 }),
    recovery_count: nonNegativeInteger,
    outcome: Type.Union([
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("timed_out"),
      Type.Literal("aborted"),
      Type.Literal("cleanup_unconfirmed"),
      Type.Literal("interrupted"),
    ]),
    cleanup: Type.Union([Type.Literal("confirmed"), Type.Literal("unconfirmed")]),
    diagnostic: Type.Optional(toolExecutionDiagnosticSchema),
    sandbox: Type.Optional(sandboxExecutionTerminalSchema),
    ts: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** Controller-origin execution start without fabricated SDK session or tool-call identity. */
export const toolExecutionStartedV2Schema = Type.Object(
  {
    type: Type.Literal("tool_execution_started"),
    schema_version: Type.Literal(2),
    run_id: id,
    execution_id: id,
    supervision_id: id,
    origin: controllerExecutionOriginSchema,
    logical_session_id: Type.Optional(Type.Never()),
    role_session_id: Type.Optional(Type.Never()),
    tool_call_id: Type.Optional(Type.Never()),
    tool_name: Type.Optional(Type.Never()),
    admission: Type.Optional(Type.Never()),
    timeout_ms: Type.Integer({ minimum: 1 }),
    recovery_count: nonNegativeInteger,
    sandbox: Type.Optional(controllerSandboxExecutionOwnerSchema),
    ts: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** Controller-origin terminal correlated by its complete non-SDK provenance. */
export const toolExecutionFinishedV2Schema = Type.Object(
  {
    type: Type.Literal("tool_execution_finished"),
    schema_version: Type.Literal(2),
    run_id: id,
    execution_id: id,
    supervision_id: id,
    origin: controllerExecutionOriginSchema,
    logical_session_id: Type.Optional(Type.Never()),
    role_session_id: Type.Optional(Type.Never()),
    tool_call_id: Type.Optional(Type.Never()),
    tool_name: Type.Optional(Type.Never()),
    elapsed_ms: Type.Number({ minimum: 0 }),
    recovery_count: nonNegativeInteger,
    outcome: toolExecutionFinishedV1Schema.properties.outcome,
    cleanup: toolExecutionFinishedV1Schema.properties.cleanup,
    diagnostic: Type.Optional(toolExecutionDiagnosticSchema),
    sandbox: Type.Optional(sandboxExecutionTerminalSchema),
    ts: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const toolExecutionStartedSchema = Type.Union([
  toolExecutionStartedV1Schema,
  toolExecutionStartedV2Schema,
]);
export const toolExecutionFinishedSchema = Type.Union([
  toolExecutionFinishedV1Schema,
  toolExecutionFinishedV2Schema,
]);

/** Durable identity and deadline captured before an executable tool starts. */
export type ToolExecutionStartedV1Record = Readonly<Static<typeof toolExecutionStartedV1Schema>>;
export type ToolExecutionStartedV2Record = Readonly<Static<typeof toolExecutionStartedV2Schema>>;
export type ToolExecutionStartedRecord = ToolExecutionStartedV1Record;
export type ControllerToolExecutionStartedRecord = ToolExecutionStartedV2Record;
export type AnyToolExecutionStartedRecord =
  | ToolExecutionStartedRecord
  | ControllerToolExecutionStartedRecord;
/** Durable terminal result correlated with one started executable tool. */
export type ToolExecutionFinishedV1Record = Readonly<Static<typeof toolExecutionFinishedV1Schema>>;
export type ToolExecutionFinishedV2Record = Readonly<Static<typeof toolExecutionFinishedV2Schema>>;
export type ToolExecutionFinishedRecord = ToolExecutionFinishedV1Record;
export type ControllerToolExecutionFinishedRecord = ToolExecutionFinishedV2Record;
export type AnyToolExecutionFinishedRecord =
  | ToolExecutionFinishedRecord
  | ControllerToolExecutionFinishedRecord;
