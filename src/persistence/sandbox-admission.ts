/** Private retained sandbox admission metadata for Issue #106 §3. */

import { type Static, Type } from "typebox";

import { pinnedSandboxPolicySchema } from "./sandbox-policy.js";
import { preparedRuntimeDescriptorSchema } from "./sandbox-runtime.js";
import { subagentSandboxDescriptorSchema } from "./subagent-sandbox.js";

const identifier = Type.String({ minLength: 1, maxLength: 256 });

/** Strict append-once admission record stored outside sandbox mounts. */
export const sandboxAdmissionRecordSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    runId: identifier,
    childId: identifier,
    sandbox: subagentSandboxDescriptorSchema,
    policy: pinnedSandboxPolicySchema,
    runtime: preparedRuntimeDescriptorSchema,
  },
  { additionalProperties: false },
);

/** Retained sandbox admission record derived from its only schema. */
export type SandboxAdmissionRecord = Readonly<Static<typeof sandboxAdmissionRecordSchema>>;
