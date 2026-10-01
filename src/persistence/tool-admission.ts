/** Identity-only, pre-launch observation evidence for issue #103 / execution controls §76. */
import { type Static, Type } from "typebox";

const ticks = Type.String({ pattern: "^(0|[1-9][0-9]*)$", maxLength: 64 });
const namespace = (kind: string) =>
  Type.String({ pattern: `^${kind}:\\[[0-9]+\\]$`, maxLength: 64 });

/** Versioned proof context; start ticks are comparable only within this original origin. */
export const linuxToolAdmissionSchema = Type.Object(
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

/** Original Darwin origin and strict Mach-tick boundary; no fabricated Linux namespaces (#165). */
export const macToolAdmissionSchema = Type.Object(
  {
    schema_version: Type.Literal(2),
    platform: Type.Literal("darwin"),
    boot_id: Type.String({ pattern: "^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$" }),
    observer_uid: Type.Integer({ minimum: 0, maximum: 4294967295 }),
    preexisting_before: ticks,
    preexisting_sessions: Type.Array(
      Type.Object(
        {
          pid: Type.Integer({ minimum: 1, maximum: 2147483647 }),
          start_time: ticks,
          start_time_kind: Type.Union([Type.Literal("mach"), Type.Literal("wallclock")]),
          process_group_id: Type.Integer({ minimum: 1, maximum: 2147483647 }),
          session_id: Type.Integer({ minimum: 1, maximum: 2147483647 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 16384 },
    ),
  },
  { additionalProperties: false },
);

/** Closed union preserving the historical Linux v1 shape unchanged. */
export const toolAdmissionSchema = Type.Union([linuxToolAdmissionSchema, macToolAdmissionSchema]);

/** Durable admission evidence bound to its containing execution start record. */
export type ToolAdmissionEvidence = Readonly<Static<typeof toolAdmissionSchema>>;
