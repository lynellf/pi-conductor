/** Runtime validation for the host-owned v2 accepted-control envelope (§9). */

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { AcceptedControlV2, Role } from "../core/types.js";

const boundedRole = Type.String({ minLength: 1, maxLength: 128 });
const reportedContext = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: 4096 }),
    utf8_bytes: Type.Integer({ minimum: 1, maximum: 4096 }),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);
const task = Type.Object(
  {
    host_directive: Type.String({ minLength: 1, maxLength: 1024 }),
    reported_objective: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    reported_action: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    reported_context: Type.Optional(reportedContext),
  },
  { additionalProperties: false },
);
const hints = Type.Object(
  {
    summary: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    verification: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 16 }),
    ),
  },
  { additionalProperties: false },
);
export const acceptedControlV2Schema = Type.Object(
  {
    schema_version: Type.Literal(2),
    direction: Type.Union([Type.Literal("dispatch"), Type.Literal("return")]),
    recipient_role: boundedRole,
    task,
    reported_hints: hints,
    ignored_hint_fields: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 }),
    utf8_bytes: Type.Integer({ minimum: 1, maximum: 16 * 1024 }),
  },
  { additionalProperties: false },
);
type AcceptedControlShape = Static<typeof acceptedControlV2Schema>;

/** Reject malformed or tampered host-owned control before it reaches a prompt. */
export function assertAcceptedControlV2(
  value: unknown,
  expectedRecipient?: Role,
  expectedDirection?: AcceptedControlV2["direction"],
): asserts value is AcceptedControlV2 {
  if (!Value.Check(acceptedControlV2Schema, value)) {
    throw new AcceptedControlV2RecordError("accepted_control_v2_invalid_schema");
  }
  const control = value as AcceptedControlShape;
  if (expectedRecipient !== undefined && control.recipient_role !== expectedRecipient) {
    throw new AcceptedControlV2RecordError("accepted_control_v2_recipient_mismatch");
  }
  if (expectedDirection !== undefined && control.direction !== expectedDirection) {
    throw new AcceptedControlV2RecordError("accepted_control_v2_direction_mismatch");
  }
  if (
    !withinUtf8Bytes(control.recipient_role, 128) ||
    !withinUtf8Bytes(control.task.host_directive, 1024) ||
    (control.task.reported_objective !== undefined &&
      !withinUtf8Bytes(control.task.reported_objective, 2048)) ||
    (control.task.reported_action !== undefined &&
      !withinUtf8Bytes(control.task.reported_action, 2048)) ||
    !withinHintUtf8Bytes(control)
  ) {
    throw new AcceptedControlV2RecordError("accepted_control_v2_invalid_schema");
  }
  const context = control.task.reported_context;
  if (context !== undefined) {
    const contextBytes = new TextEncoder().encode(context.text).byteLength;
    if (context.utf8_bytes !== contextBytes || contextBytes > 4096) {
      throw new AcceptedControlV2RecordError("accepted_control_v2_invalid_context");
    }
  }
  const actualBytes = new TextEncoder().encode(JSON.stringify(control)).byteLength;
  if (actualBytes !== control.utf8_bytes || actualBytes > 16 * 1024) {
    throw new AcceptedControlV2RecordError("accepted_control_v2_invalid_size");
  }
}

/** Typed failure for an invalid persisted accepted-control record. */
export class AcceptedControlV2RecordError extends Error {
  constructor(readonly code: AcceptedControlV2RecordErrorCode) {
    super(`accepted_control v2 rejected: ${code}`);
    this.name = "AcceptedControlV2RecordError";
  }
}

export type AcceptedControlV2RecordErrorCode =
  | "accepted_control_v2_invalid_schema"
  | "accepted_control_v2_recipient_mismatch"
  | "accepted_control_v2_direction_mismatch"
  | "accepted_control_v2_invalid_context"
  | "accepted_control_v2_invalid_size";

function withinUtf8Bytes(value: string, maxBytes: number): boolean {
  return new TextEncoder().encode(value).byteLength <= maxBytes;
}

function withinHintUtf8Bytes(control: AcceptedControlShape): boolean {
  const { summary, reason, verification } = control.reported_hints;
  return (
    (summary === undefined || withinUtf8Bytes(summary, 2048)) &&
    (reason === undefined || withinUtf8Bytes(reason, 2048)) &&
    (verification === undefined || verification.every((item) => withinUtf8Bytes(item, 256))) &&
    control.ignored_hint_fields.every((field) => withinUtf8Bytes(field, 64))
  );
}
