/** Closed schemas for versioned delegated-task acceptance records. */

import { type Static, Type } from "typebox";
import { delegateSubmissionArgsSchema } from "../seam/schema.js";
import { subagentSandboxDescriptorSchema } from "./subagent-sandbox.js";

const id = Type.String({ minLength: 1 });
const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const nonNegativeInteger = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const projectionFingerprint = Type.Object(
  {
    kind: Type.Union([Type.Literal("exact"), Type.Literal("full_materialized")]),
    path_count: nonNegativeInteger,
    sha256,
  },
  { additionalProperties: false },
);
const child = Type.Object(
  {
    child_id: id,
    task_id: id,
    subagent: id,
    model: id,
    branch: id,
    worktree_path: id,
    base_commit: id,
    task_fingerprint: sha256,
    profile_fingerprint: sha256,
    context_fingerprint: sha256,
    prompt_fingerprint: sha256,
    projection_fingerprint: projectionFingerprint,
    sandbox: Type.Optional(subagentSandboxDescriptorSchema),
  },
  { additionalProperties: false },
);

/** Legacy SDK tool-call origin retained for v2 mixed-log validation. */
export const sdkToolCallAdmissionOriginSchema = Type.Object(
  { kind: Type.Literal("sdk_tool_call"), tool_call_id: id },
  { additionalProperties: false },
);

/** Non-SDK controller action provenance for v2 native admission. */
export const controllerActionAdmissionOriginSchema = Type.Object(
  {
    kind: Type.Literal("controller_action"),
    controller_id: id,
    definition_digest: sha256,
    action_id: id,
    activation_id: id,
  },
  { additionalProperties: false },
);

/** Discriminated admission source for versioned delegated submissions. */
export const delegationAdmissionOriginSchema = Type.Union([
  sdkToolCallAdmissionOriginSchema,
  controllerActionAdmissionOriginSchema,
]);

/** Strict legacy atomic acceptance record for one SDK tool-call batch. */
export const delegationSubmissionAcceptedV1Schema = Type.Object(
  {
    type: Type.Literal("delegation_submission_accepted"),
    schema_version: Type.Literal(1),
    run_id: id,
    submission_id: id,
    logical_parent_id: id,
    parent_role: id,
    parent_visit_index: nonNegativeInteger,
    tool_call_id: id,
    input_fingerprint: sha256,
    request_fingerprint: Type.Optional(sha256),
    children: Type.Array(child, { minItems: 1 }),
    ts: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** Strict v2 acceptance record with explicit SDK or controller provenance. */
export const delegationSubmissionAcceptedV2Schema = Type.Object(
  {
    type: Type.Literal("delegation_submission_accepted"),
    schema_version: Type.Literal(2),
    run_id: id,
    submission_id: id,
    logical_parent_id: id,
    parent_role: id,
    parent_visit_index: nonNegativeInteger,
    tool_call_id: Type.Optional(Type.Never()),
    origin: delegationAdmissionOriginSchema,
    input_fingerprint: sha256,
    request_fingerprint: Type.Optional(sha256),
    accepted_args: delegateSubmissionArgsSchema,
    children: Type.Array(child, { minItems: 1 }),
    ts: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** All supported accepted-submission record shapes. */
export const delegationSubmissionAcceptedSchema = Type.Union([
  delegationSubmissionAcceptedV1Schema,
  delegationSubmissionAcceptedV2Schema,
]);

/** Persisted atomic acceptance record. */
export type DelegationSubmissionAcceptedRecord = Readonly<
  Static<typeof delegationSubmissionAcceptedSchema>
>;
/** Controller-origin admission provenance retained in a v2 acceptance record. */
export type ControllerAdmissionOrigin = Readonly<
  Static<typeof controllerActionAdmissionOriginSchema>
>;
/** Child metadata retained in an accepted submission. */
export type DelegationAcceptedChild = Readonly<Static<typeof child>>;
