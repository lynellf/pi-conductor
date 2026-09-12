/** Durable delegated-child sandbox identity — Issue #106 §3. */

import { type Static, Type } from "typebox";
import { sha256Canonical } from "./trajectory-records.js";

const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const materializationId = Type.String({
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
  minLength: 1,
  maxLength: 128,
});

/** Strict identity binding for an explicitly enabled delegated sandbox. */
export const subagentSandboxDescriptorSchema = Type.Object(
  {
    backend: Type.Literal("bubblewrap"),
    execution_policy_digest: sha256,
    runtime_digest: sha256,
    materialization_id: materializationId,
  },
  { additionalProperties: false },
);

/** Durable sandbox identity shared by acceptance and child-start records. */
export type SubagentSandboxDescriptor = Readonly<Static<typeof subagentSandboxDescriptorSchema>>;

/** Compute the authority-bound acceptance digest from canonical child descriptors. */
export function sandboxBoundFingerprint(
  requestFingerprint: string,
  descriptors: readonly (SubagentSandboxDescriptor | undefined)[],
): string {
  return sha256Canonical({
    request_fingerprint: requestFingerprint,
    sandbox: descriptors.map((descriptor) =>
      descriptor === undefined
        ? null
        : {
            backend: descriptor.backend,
            execution_policy_digest: descriptor.execution_policy_digest,
            runtime_digest: descriptor.runtime_digest,
          },
    ),
  });
}
