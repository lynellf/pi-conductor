/** Identity-only, pre-launch observation evidence for issue #103 / execution controls §76. */
import { type Static, Type } from "typebox";

const ticks = Type.String({ pattern: "^(0|[1-9][0-9]*)$", maxLength: 64 });
const namespace = (kind: string) =>
  Type.String({ pattern: `^${kind}:\\[[0-9]+\\]$`, maxLength: 64 });

/** Versioned proof context; start ticks are comparable only within this original origin. */
export const toolAdmissionSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    boot_id: Type.String({ pattern: "^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$" }),
    pid_namespace: namespace("pid"),
    time_namespace: namespace("time"),
    network_namespace: namespace("net"),
    init_start_time: ticks,
    preexisting_before: ticks,
  },
  { additionalProperties: false },
);

/** Durable admission evidence bound to its containing execution start record. */
export type ToolAdmissionEvidence = Readonly<Static<typeof toolAdmissionSchema>>;
