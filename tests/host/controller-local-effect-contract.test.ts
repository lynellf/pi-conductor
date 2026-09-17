import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  localProgramInvocationSchema,
  localProgramOutcomeSchema,
  localProgramRequestSchema,
} from "../../src/manifest/local-effect.js";

const sha = (character: string) => character.repeat(64);

const request = {
  schema_version: 1,
  kind: "local_program",
  repository_id: "repo-main",
  operation: "observe-ci",
  source_ref: "refs/pi-conductor/integration/reviewed",
  target_ref: "refs/heads/main",
  reviewed_head: sha("1"),
  evidence: [
    {
      artifact_ref: "artifact/v2/review",
      sha256: sha("2"),
      producer_id: "review",
      schema_id: "review-v1",
      subject_head: sha("1"),
      verdict: "approved",
    },
  ],
  payload: { pull_request: 12 },
};

describe("local program effect protocol", () => {
  it("keeps caller executable, environment, credential, and authority fields out of a request", () => {
    expect(Value.Check(localProgramRequestSchema, request)).toBe(true);
    expect(
      Value.Check(localProgramRequestSchema, {
        ...request,
        executable: "/bin/sh",
      }),
    ).toBe(false);
  });

  it("binds a successful observation result to the host invocation", () => {
    const invocation = {
      protocol_version: 1,
      command: "inspect",
      operation_id: sha("6"),
      invocation_id: sha("3"),
      implementation_id: "forge-provider",
      implementation_digest: sha("4"),
      authority_digest: sha("7"),
      request_digest: sha("5"),
      request,
      scope: {
        repository_path: "/srv/repos/project",
        repository_fingerprint: sha("8"),
        allowed_network_origins: ["https://forge.invalid"],
      },
      evidence: [],
      credentials: [{ source_id: "forge-token", value: "private-token" }],
    };
    expect(Value.Check(localProgramInvocationSchema, invocation)).toBe(true);
    expect(
      Value.Check(localProgramOutcomeSchema, {
        protocol_version: 1,
        operation_id: invocation.operation_id,
        invocation_id: invocation.invocation_id,
        implementation_id: invocation.implementation_id,
        implementation_digest: invocation.implementation_digest,
        authority_digest: invocation.authority_digest,
        request_digest: invocation.request_digest,
        status: "applied",
        result: {
          schema_version: 1,
          kind: "local_program",
          repository_id: request.repository_id,
          operation: request.operation,
          source_ref: request.source_ref,
          target_ref: request.target_ref,
          reviewed_head: request.reviewed_head,
          payload: { ci: "pending" },
        },
      }),
    ).toBe(true);
  });

  it("requires a typed observation when inspection proves a write was not applied", () => {
    expect(
      Value.Check(localProgramOutcomeSchema, {
        protocol_version: 1,
        operation_id: sha("6"),
        invocation_id: sha("3"),
        implementation_id: "forge-provider",
        implementation_digest: sha("4"),
        authority_digest: sha("7"),
        request_digest: sha("5"),
        status: "not_applied",
        diagnostic_code: "remote-absent",
      }),
    ).toBe(false);
  });
});
