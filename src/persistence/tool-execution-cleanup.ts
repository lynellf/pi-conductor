/** Backend-specific operator cleanup attestations; absence is never automatic proof (#106 §6). */
import { type Static, Type } from "typebox";
import {
  type AnySandboxExecutionOwner,
  type AnyToolExecutionSandboxReadyRecord,
  type SandboxExecutionHostObserver,
  sandboxExecutionHostObserverSchema,
  sandboxExecutionOwnerSchema,
} from "./sandbox-execution.js";
import {
  type SandboxProcessObservation,
  sandboxProcessObservationSchema,
} from "./sandbox-process.js";
import { controllerExecutionOriginSchema } from "./tool-execution-origin.js";
import { sha256Canonical } from "./trajectory-records.js";

const id = Type.String({ minLength: 1 });
const absent = Type.Union([
  Type.Literal("missing"),
  Type.Literal("reused"),
  Type.Literal("settled"),
]);
const v1Fields = {
  type: Type.Literal("tool_execution_cleanup_confirmed"),
  schema_version: Type.Literal(1),
  run_id: id,
  execution_id: id,
  supervision_id: id,
  logical_session_id: id,
  role_session_id: id,
  tool_call_id: id,
  tool_name: id,
  origin: Type.Optional(Type.Never()),
  cleanup: Type.Literal("confirmed"),
  operator_note: Type.String({ minLength: 1, maxLength: 1000 }),
  operator: Type.String({ minLength: 1, maxLength: 256 }),
  ts: Type.Number({ minimum: 0 }),
};
const v2Fields = {
  type: Type.Literal("tool_execution_cleanup_confirmed"),
  schema_version: Type.Literal(2),
  run_id: id,
  execution_id: id,
  supervision_id: id,
  origin: controllerExecutionOriginSchema,
  start_record_digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  partial_effects: Type.Union([
    Type.Literal("none_observed"),
    Type.Literal("inspected_unpublished"),
    Type.Literal("immutable_publication_verified"),
  ]),
  logical_session_id: Type.Optional(Type.Never()),
  role_session_id: Type.Optional(Type.Never()),
  tool_call_id: Type.Optional(Type.Never()),
  tool_name: Type.Optional(Type.Never()),
  cleanup: Type.Literal("confirmed"),
  operator_note: Type.String({ minLength: 1, maxLength: 1000 }),
  operator: Type.String({ minLength: 1, maxLength: 256 }),
  ts: Type.Number({ minimum: 0 }),
};

/** Read-only origin and exact identities accompanying explicit original-host attestation. */
export const sandboxCleanupEvidenceSchema = Type.Object(
  {
    owner: sandboxExecutionOwnerSchema,
    boot_id: Type.String({ pattern: "^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$" }),
    observer: sandboxExecutionHostObserverSchema,
    final_init: sandboxProcessObservationSchema,
    launcher: Type.Object(
      {
        pid: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
        start_time: Type.String({ pattern: "^(0|[1-9][0-9]*)$", maxLength: 64 }),
      },
      { additionalProperties: false },
    ),
    init_observation: absent,
    launcher_observation: absent,
    output_ref: Type.String({
      pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$",
    }),
  },
  { additionalProperties: false },
);

/** Exact legacy or sandbox verification record, with no cross-backend fallback. */
const cleanupVerification = Type.Union([
  Type.Object(
    { ...v1Fields, verification: Type.Literal("operator_confirmed_owner_marker_absent") },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...v1Fields,
      verification: Type.Literal("operator_confirmed_sandbox_cleanup"),
      sandbox: sandboxCleanupEvidenceSchema,
    },
    { additionalProperties: false },
  ),
]);
const controllerCleanupVerification = Type.Union([
  Type.Object(
    { ...v2Fields, verification: Type.Literal("operator_confirmed_owner_marker_absent") },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...v2Fields,
      verification: Type.Literal("operator_confirmed_sandbox_cleanup"),
      sandbox: sandboxCleanupEvidenceSchema,
    },
    { additionalProperties: false },
  ),
]);
export const toolExecutionCleanupConfirmedSchema = Type.Union([
  cleanupVerification,
  controllerCleanupVerification,
]);

/** Strict cleanup attestation derived from its durable schema. */
export type ToolExecutionCleanupConfirmedRecord = Readonly<Static<typeof cleanupVerification>>;
export type ControllerExecutionCleanupConfirmedRecord = Readonly<
  Static<typeof controllerCleanupVerification>
>;
export type AnyToolExecutionCleanupConfirmedRecord =
  | ToolExecutionCleanupConfirmedRecord
  | ControllerExecutionCleanupConfirmedRecord;
/** Strict origin/identity evidence, without a command result or namespace-death inference. */
export type SandboxCleanupEvidence = Readonly<Static<typeof sandboxCleanupEvidenceSchema>>;

/** Compare namespace origin across host-observer restarts; observer PID may change. */
export function sameSandboxObserverOrigin(
  left: SandboxExecutionHostObserver,
  right: SandboxExecutionHostObserver,
): boolean {
  return (
    left.time_namespace === right.time_namespace &&
    sameNamespaces(left.process, right.process) &&
    left.process.nspid.length === right.process.nspid.length &&
    right.process.nspid[0] === right.process.pid
  );
}

/** Compare the complete recorded init identity without observing the operating system. */
export function sameSandboxProcessObservation(
  left: SandboxProcessObservation,
  right: SandboxProcessObservation,
): boolean {
  return (
    left.pid === right.pid &&
    left.startTime === right.startTime &&
    sameNamespaces(left, right) &&
    left.nspid.length === right.nspid.length &&
    left.nspid.every((pid, index) => pid === right.nspid[index])
  );
}

/** Reject a confirmation whose backend, origin, init, or output differs from durable READY. */
export function assertToolCleanupBackend(
  record: AnyToolExecutionCleanupConfirmedRecord,
  owner: AnySandboxExecutionOwner | undefined,
  ready: AnyToolExecutionSandboxReadyRecord | undefined,
): void {
  if (record.verification === "operator_confirmed_owner_marker_absent") {
    if (owner !== undefined)
      throw new Error("sandbox cleanup requires backend-specific verification");
    return;
  }
  if (owner === undefined || ready === undefined)
    throw new Error("sandbox cleanup requires a sandbox start and durable READY");
  const evidence = record.sandbox;
  if (
    sha256Canonical(evidence.owner) !== sha256Canonical(owner) ||
    evidence.boot_id !== ready.boot_id ||
    !sameSandboxObserverOrigin(ready.host_observer, evidence.observer) ||
    !sameSandboxProcessObservation(ready.final_init, evidence.final_init) ||
    evidence.launcher.pid !== ready.launcher.pid ||
    evidence.launcher.start_time !== ready.launcher.start_time ||
    evidence.output_ref !== ready.output_ref
  )
    throw new Error("sandbox cleanup evidence mismatches durable READY");
}

function sameNamespaces(
  left: SandboxProcessObservation,
  right: SandboxProcessObservation,
): boolean {
  return (["pid", "mnt", "user", "net", "ipc", "uts"] as const).every(
    (name) => left.namespaces[name] === right.namespaces[name],
  );
}
