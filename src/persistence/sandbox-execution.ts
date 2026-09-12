/** Durable sandbox execution readiness evidence — Issue #106 §6. */

import { posix } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  type SandboxProcessObservation,
  sandboxProcessObservationSchema,
} from "./sandbox-process.js";
import { preparedRuntimeIdentitySchema } from "./sandbox-runtime.js";
import { subagentSandboxDescriptorSchema } from "./subagent-sandbox.js";

const id = Type.String({ minLength: 1 });
const safePid = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const safeNonNegative = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const ticks = Type.String({ pattern: "^(0|[1-9][0-9]*)$", maxLength: 64 });
const uuid = Type.String({ pattern: "^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$" });
const namespace = (name: string) =>
  Type.String({ pattern: `^${name}:\\[[0-9]+\\]$`, maxLength: 64 });

/** Owner binding for a sandbox-enabled delegated child start. */
export const sandboxExecutionOwnerSchema = Type.Object(
  { child_id: id, descriptor: subagentSandboxDescriptorSchema },
  { additionalProperties: false },
);

/** Host origin used to interpret process start ticks after observer restart. */
export const sandboxExecutionHostObserverSchema = Type.Object(
  {
    process: sandboxProcessObservationSchema,
    time_namespace: namespace("time"),
  },
  { additionalProperties: false },
);

const launcherSchema = Type.Object(
  { pid: safePid, start_time: ticks },
  { additionalProperties: false },
);

/** Approved executable identity retained with sandbox readiness evidence. */
export const verifiedSandboxBinarySchema = Type.Object(
  {
    identity: preparedRuntimeIdentitySchema,
    digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    path: Type.String({ minLength: 1, maxLength: 4096 }),
    approval_id: id,
  },
  { additionalProperties: false },
);

/** Exact correlated READY record; metadata contains no command, environment, or output bytes. */
export const toolExecutionSandboxReadySchema = Type.Object(
  {
    type: Type.Literal("tool_execution_sandbox_ready"),
    schema_version: Type.Literal(1),
    run_id: id,
    execution_id: id,
    supervision_id: id,
    logical_session_id: id,
    role_session_id: id,
    tool_call_id: id,
    tool_name: id,
    sandbox: sandboxExecutionOwnerSchema,
    boot_id: uuid,
    host_observer: sandboxExecutionHostObserverSchema,
    launcher: launcherSchema,
    early_init: sandboxProcessObservationSchema,
    final_init: sandboxProcessObservationSchema,
    startup_pid_namespace: safeNonNegative,
    verified_binary: verifiedSandboxBinarySchema,
    output_ref: uuid,
    ts: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** Child and immutable descriptor binding for a sandbox execution. */
export type SandboxExecutionOwner = Readonly<Static<typeof sandboxExecutionOwnerSchema>>;
/** Host process and time namespace identity retained in READY evidence. */
export type SandboxExecutionHostObserver = Readonly<
  Static<typeof sandboxExecutionHostObserverSchema>
>;
/** Approved Bubblewrap executable identity retained in READY evidence. */
export type VerifiedSandboxBinary = Readonly<Static<typeof verifiedSandboxBinarySchema>>;
/** Complete durable READY record emitted after sandbox verification. */
export type ToolExecutionSandboxReadyRecord = Readonly<
  Static<typeof toolExecutionSandboxReadySchema>
>;
/** READY fields supplied by the sandbox lifecycle owner before correlation metadata. */
export type SandboxReadyEvidence = Omit<
  ToolExecutionSandboxReadyRecord,
  | "type"
  | "schema_version"
  | "run_id"
  | "execution_id"
  | "supervision_id"
  | "logical_session_id"
  | "role_session_id"
  | "tool_call_id"
  | "tool_name"
  | "ts"
>;

/** Typed rejection for malformed or inconsistent sandbox lifecycle evidence. */
export class SandboxExecutionRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxExecutionRecordError";
  }
}

/** Validate one READY record's closed shape and safe integer constraints. */
export function assertToolExecutionSandboxReadyRecord(
  value: unknown,
): asserts value is ToolExecutionSandboxReadyRecord {
  if (!Value.Check(toolExecutionSandboxReadySchema, value))
    throw new SandboxExecutionRecordError("invalid tool execution sandbox ready record");
  const record = value as ToolExecutionSandboxReadyRecord;
  if (!Number.isFinite(record.ts))
    throw new SandboxExecutionRecordError("sandbox ready timestamp must be finite");
  if (record.startup_pid_namespace < 1)
    throw new SandboxExecutionRecordError("startup PID namespace must be positive");
  const binary = record.verified_binary;
  if (!Number.isFinite(binary.identity.mtimeMs) || !Number.isFinite(binary.identity.ctimeMs))
    throw new SandboxExecutionRecordError("verified sandbox binary timestamps must be finite");
  if (
    binary.identity.uid !== 0 ||
    (binary.identity.mode & 0o170000) !== 0o100000 ||
    (binary.identity.mode & 0o6000) !== 0 ||
    (binary.identity.mode & 0o022) !== 0 ||
    (binary.identity.mode & 0o001) === 0 ||
    !binary.path.startsWith("/") ||
    binary.path === "/" ||
    binary.path.includes("\0") ||
    binary.path !== posix.normalize(binary.path)
  )
    throw new SandboxExecutionRecordError(
      "verified sandbox binary is not an approved canonical regular file",
    );
  assertSandboxNamespaceLifecycle(
    record.early_init,
    record.final_init,
    record.startup_pid_namespace,
    record.host_observer.process,
  );
}

/** Validate the exact early-to-final PID namespace identity transition. */
export function assertSandboxNamespaceLifecycle(
  early: SandboxProcessObservation,
  final: SandboxProcessObservation,
  startupPidNamespace: number,
  host: SandboxProcessObservation,
): void {
  for (const observation of [early, final])
    if (
      !Value.Check(sandboxProcessObservationSchema, observation) ||
      observation.nspid[0] !== observation.pid
    )
      throw new SandboxExecutionRecordError("invalid sandbox namespace observation");
  if (!Number.isSafeInteger(startupPidNamespace) || startupPidNamespace < 1)
    throw new SandboxExecutionRecordError("invalid startup PID namespace");
  if (
    early.pid !== final.pid ||
    early.startTime !== final.startTime ||
    early.namespaces.pid !== `pid:[${startupPidNamespace}]` ||
    final.namespaces.pid !== early.namespaces.pid ||
    final.nspid.at(-1) !== 1
  )
    throw new SandboxExecutionRecordError("sandbox final namespace-init identity mismatch");
  if (!Value.Check(sandboxProcessObservationSchema, host) || host.nspid[0] !== host.pid)
    throw new SandboxExecutionRecordError("invalid host namespace observation");
  if (final.nspid.length !== host.nspid.length + 1)
    throw new SandboxExecutionRecordError("sandbox PID namespace depth mismatch");
  for (const name of ["pid", "mnt", "user", "net", "ipc", "uts"] as const)
    if (final.namespaces[name] === host.namespaces[name])
      throw new SandboxExecutionRecordError(`sandbox final ${name} namespace is not isolated`);
}
