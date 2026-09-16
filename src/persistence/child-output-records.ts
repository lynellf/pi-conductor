/** Native output capture and publication records — issue #116 capability A. */
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  controllerChildOutputPolicySchema,
  controllerOutputPrincipalSchema,
} from "../manifest/controller-output.js";
import { childOutputArtifactDescriptorSchema } from "./child-output-artifact.js";
import { sha256Canonical } from "./trajectory-records.js";

const id = Type.String({ minLength: 1, maxLength: 256 });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const oid = Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" });
const captureOutput = Type.Object(
  {
    id,
    path: Type.Union([Type.String({ minLength: 1, maxLength: 1024 }), Type.Null()]),
    kind: Type.Union([Type.Literal("report"), Type.Literal("patch")]),
    media_type: childOutputArtifactDescriptorSchema.properties.media_type,
    sha256: digest,
    byte_length: Type.Integer({ minimum: 0, maximum: 524288 }),
  },
  { additionalProperties: false },
);

/** Host-measured source fingerprints attached to the authoritative child terminal. */
export const childOutputCaptureSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    accepted_base: oid,
    head_commit: oid,
    policy_digest: digest,
    profile_id: id,
    outputs: Type.Array(captureOutput, { minItems: 1, maxItems: 16 }),
  },
  { additionalProperties: false },
);
export type ChildOutputCapture = Static<typeof childOutputCaptureSchema>;

const common = {
  schema_version: Type.Literal(1),
  run_id: id,
  controller_id: id,
  definition_digest: digest,
  activation_id: id,
  owner_epoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  child_id: id,
  task_id: id,
  producer_profile_id: id,
  terminal: Type.Object(
    {
      ordinal: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      record_digest: digest,
    },
    { additionalProperties: false },
  ),
  ts: Type.Number({ minimum: 0 }),
};

/** Durable publication intent refers to bytes fingerprinted before child terminal persistence. */
export const childOutputStartedSchema = Type.Object(
  {
    ...common,
    type: Type.Literal("controller_child_output_started"),
    capture: childOutputCaptureSchema,
    policy: controllerChildOutputPolicySchema,
    input_audience: Type.Union([
      Type.Null(),
      Type.Array(controllerOutputPrincipalSchema, { maxItems: 64 }),
    ]),
  },
  { additionalProperties: false },
);
export const childOutputPublishedSchema = Type.Object(
  {
    ...common,
    type: Type.Literal("controller_child_output_published"),
    intent_digest: digest,
    outputs: Type.Array(childOutputArtifactDescriptorSchema, { minItems: 1, maxItems: 16 }),
  },
  { additionalProperties: false },
);
export const childOutputFailedSchema = Type.Object(
  {
    ...common,
    type: Type.Literal("controller_child_output_failed"),
    intent_digest: Type.Union([Type.Null(), digest]),
    code: Type.String({ pattern: "^[a-z][a-z0-9-]{0,95}$" }),
  },
  { additionalProperties: false },
);
export const childOutputRecordSchema = Type.Union([
  childOutputStartedSchema,
  childOutputPublishedSchema,
  childOutputFailedSchema,
]);
export type ChildOutputStartedRecord = Static<typeof childOutputStartedSchema>;
export type ChildOutputPublishedRecord = Static<typeof childOutputPublishedSchema>;
export type ChildOutputFailedRecord = Static<typeof childOutputFailedSchema>;
export type ChildOutputRecord = Static<typeof childOutputRecordSchema>;

/** Recognize the versioned native-output publication lifecycle. */
export function isChildOutputRecord(value: unknown): value is ChildOutputRecord {
  return (
    value !== null &&
    typeof value === "object" &&
    "type" in value &&
    [
      "controller_child_output_started",
      "controller_child_output_published",
      "controller_child_output_failed",
    ].includes(String(value.type))
  );
}

/** Reject malformed source fingerprints before they can attest publication. */
export function assertChildOutputCapture(value: unknown): asserts value is ChildOutputCapture {
  if (!Value.Check(childOutputCaptureSchema, value))
    throw new Error("invalid child output capture");
  if (value.accepted_base !== value.head_commit)
    throw new Error("child output capture changed its accepted base");
  const ids = new Set<string>();
  let total = 0;
  for (const output of value.outputs) {
    if (ids.has(output.id)) throw new Error("duplicate child output identity");
    ids.add(output.id);
    total += output.byte_length;
    if (
      output.kind === "report" &&
      (output.path === null ||
        output.byte_length > 131072 ||
        output.media_type === "application/x-git-patch")
    )
      throw new Error("invalid child report capture");
    if (
      output.kind === "patch" &&
      (output.path !== null || output.media_type !== "application/x-git-patch")
    )
      throw new Error("invalid child patch capture");
  }
  if (total > 1048576) throw new Error("child output capture exceeds total byte limit");
}

/** Validate closed journal data, including binding to its exact capture policy. */
export function assertChildOutputRecord(value: unknown): asserts value is ChildOutputRecord {
  if (!Value.Check(childOutputRecordSchema, value)) throw new Error("invalid child output record");
  if (value.type === "controller_child_output_started") {
    assertChildOutputCapture(value.capture);
    if (
      sha256Canonical(value.policy) !== value.capture.policy_digest ||
      value.policy.profile_id !== value.producer_profile_id ||
      value.capture.profile_id !== value.producer_profile_id
    )
      throw new Error("child output capture policy mismatch");
  }
  if (value.type === "controller_child_output_published") {
    const ids = new Set<string>();
    let total = 0;
    for (const output of value.outputs) {
      const binding = output.binding;
      if (
        binding.runId !== value.run_id ||
        binding.definitionDigest !== value.definition_digest ||
        binding.childId !== value.child_id ||
        binding.taskId !== value.task_id ||
        binding.producerProfileId !== value.producer_profile_id ||
        binding.terminal.ordinal !== value.terminal.ordinal ||
        binding.terminal.recordDigest !== value.terminal.record_digest ||
        output.media_type !== binding.mediaType
      )
        throw new Error("child output publication identity mismatch");
      if (ids.has(binding.output.id)) throw new Error("duplicate child output identity");
      ids.add(binding.output.id);
      total += output.byte_length;
      if (binding.output.kind === "report" && output.byte_length > 131072)
        throw new Error("child report exceeds byte limit");
    }
    if (total > 1048576) throw new Error("child publication exceeds total byte limit");
  }
}
