/** Pure durable child-output artifact descriptors — issue #116 capability A. */

import { type Static, Type } from "typebox";
import {
  type ControllerOutputPrincipal,
  controllerOutputPrincipalSchema,
} from "../manifest/controller-output.js";

const identifier = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$" });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });

export const childOutputPrincipalSchema = controllerOutputPrincipalSchema;
export type ChildOutputPrincipal = ControllerOutputPrincipal;

export const childOutputBindingSchema = Type.Object(
  {
    runId: identifier,
    definitionDigest: digest,
    childId: identifier,
    taskId: identifier,
    acceptedBase: Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }),
    terminal: Type.Object(
      { ordinal: Type.Integer({ minimum: 0 }), recordDigest: digest },
      { additionalProperties: false },
    ),
    producerProfileId: identifier,
    output: Type.Object(
      {
        id: identifier,
        path: Type.Union([
          Type.String({
            minLength: 1,
            maxLength: 1024,
            pattern: "^(?!/)(?!.*//)(?!.*(?:^|/)\\.\\.?(?:/|$))(?!.*\\\\).+$",
          }),
          Type.Null(),
        ]),
        kind: Type.Union([Type.Literal("report"), Type.Literal("patch")]),
      },
      { additionalProperties: false },
    ),
    outputPolicyDigest: digest,
    mediaType: Type.Union([
      Type.Literal("text/plain"),
      Type.Literal("text/markdown"),
      Type.Literal("application/json"),
      Type.Literal("application/octet-stream"),
      Type.Literal("application/x-git-patch"),
    ]),
    audience: Type.Array(childOutputPrincipalSchema, { maxItems: 64 }),
  },
  { additionalProperties: false },
);
export type ChildOutputBinding = Static<typeof childOutputBindingSchema>;

export const childOutputArtifactDescriptorSchema = Type.Object(
  {
    ref: Type.String({ pattern: "^child-output/v2/[a-f0-9]{64}/[a-f0-9]{64}$" }),
    sha256: digest,
    byte_length: Type.Integer({ minimum: 0, maximum: 524_288 }),
    media_type: childOutputBindingSchema.properties.mediaType,
    binding: childOutputBindingSchema,
  },
  { additionalProperties: false },
);
export type ChildOutputArtifactDescriptor = Static<typeof childOutputArtifactDescriptorSchema>;
