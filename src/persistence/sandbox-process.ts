/** Identity-only namespace observations used by sandbox lifecycle records (#106 §6). */
import { type Static, Type } from "typebox";

const pid = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const namespace = (name: string) =>
  Type.String({ pattern: `^${name}:\\[[0-9]+\\]$`, maxLength: 64 });

/** Closed exact-process observation; command names and environment are never retained. */
export const sandboxProcessObservationSchema = Type.Object(
  {
    pid,
    startTime: Type.String({ pattern: "^(0|[1-9][0-9]*)$", maxLength: 64 }),
    nspid: Type.Array(pid, { minItems: 1, maxItems: 32 }),
    namespaces: Type.Object(
      {
        pid: namespace("pid"),
        mnt: namespace("mnt"),
        user: namespace("user"),
        net: namespace("net"),
        ipc: namespace("ipc"),
        uts: namespace("uts"),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

/** Persistable stat-bracketed PID and namespace evidence. */
export type SandboxProcessObservation = Readonly<Static<typeof sandboxProcessObservationSchema>>;
