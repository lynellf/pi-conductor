/** Retained non-secret sandbox authority, separate from lifecycle records (#106 §3). */
import { type Static, Type } from "typebox";

const paths = Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true });
const workspaceSnapshot = Type.Object(
  {
    mode: Type.Literal("snapshot"),
    paths: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: 64,
      uniqueItems: true,
    }),
    max_files: Type.Integer({ minimum: 1, maximum: 10_000 }),
  },
  { additionalProperties: false },
);
const environment = Type.Object(
  {
    PATH: Type.Optional(Type.String()),
    LANG: Type.Optional(Type.String()),
    LC_ALL: Type.Optional(Type.String()),
    TERM: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Closed persisted policy including exact selection and complete tracked authority. */
export const pinnedSandboxPolicySchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    execution: Type.Object(
      {
        backend: Type.Literal("bubblewrap"),
        runtime_root: Type.String({ minLength: 1 }),
        writable_paths: paths,
        network: Type.Literal("none"),
        environment,
        max_output_bytes: Type.Integer({ minimum: 1, maximum: 67108864 }),
      },
      { additionalProperties: false },
    ),
    toolExecution: Type.Object(
      {
        timeout_seconds: Type.Integer({ minimum: 1, maximum: 3600 }),
        termination_grace_seconds: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
        max_recoverable_timeouts: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      },
      { additionalProperties: false },
    ),
    selectedPaths: paths,
    trackedPaths: paths,
    projectionRoots: Type.Optional(paths),
    workspaceSnapshot: Type.Optional(workspaceSnapshot),
    writableRoots: Type.Array(
      Type.Object(
        {
          path: Type.String({ minLength: 1 }),
          kind: Type.Union([Type.Literal("file"), Type.Literal("directory")]),
        },
        { additionalProperties: false },
      ),
    ),
    digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  },
  { additionalProperties: false },
);

/** Policy metadata whose digest is repeated in accepted/start descriptors. */
export type PinnedSandboxPolicy = Readonly<Static<typeof pinnedSandboxPolicySchema>>;
