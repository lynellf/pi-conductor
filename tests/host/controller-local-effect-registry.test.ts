import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
  assertEffectRequestInScope,
  assertEffectResultInScope,
  localProgramImplementationDigest,
  localProgramRuntimeDigest,
  pinEffectAuthority,
  validateEffectGrant,
} from "../../src/host/controller/effect-registry.js";
import type { LocalProgramEffectGrant } from "../../src/host/controller/local-effect-registry.js";
import {
  effectRequestSchemaDigest,
  effectResultSchemaDigest,
} from "../../src/manifest/controller-effect.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";

const sha = (character: string) => character.repeat(64);
const inputDocument = Type.Object({ pull_request: Type.Integer({ minimum: 1 }) });
const resultDocument = Type.Object({
  ci: Type.Union([Type.Literal("pending"), Type.Literal("passed")]),
});
const provider = {
  executable: { canonical_path: "/srv/providers/forge", sha256: sha("1") },
  argv: ["--stdio"],
  runtime: {
    id: "node-24",
    digest: "",
    dependencies: [{ canonical_path: "/srv/providers/node", sha256: sha("3") }],
  },
  credential_source_ids: ["forge-token"],
  network: { allowed_origins: ["https://forge.invalid"] },
};
provider.runtime.digest = localProgramRuntimeDigest(provider.runtime);

const grant: LocalProgramEffectGrant = {
  schema_version: 1,
  id: "forge-local",
  adapter_id: "choose-forge",
  kind: "local_program",
  implementation_id: "forge-provider-v1",
  host_driver_digest: sha("9"),
  implementation_digest: localProgramImplementationDigest(provider, sha("9")),
  request_schema_id: "local-program-request-v1",
  request_schema_digest: effectRequestSchemaDigest("local_program"),
  output_schema_id: "local-program-result-v1",
  output_schema_digest: effectResultSchemaDigest("local_program"),
  repository: { id: "repo-main", canonical_path: "/srv/repos/project", fingerprint: sha("4") },
  provider,
  operations: [
    {
      operation: "observe-ci",
      semantics: "observe",
      input_schema: {
        id: "observe-ci-input-v1",
        digest: sha256Canonical(inputDocument),
        document: inputDocument as unknown as Record<string, unknown>,
      },
      result_schema: {
        id: "observe-ci-result-v1",
        digest: sha256Canonical(resultDocument),
        document: resultDocument as unknown as Record<string, unknown>,
      },
      resource_conflict_keys: ["pull-request-main"],
    },
  ],
  allowed_source_refs: ["refs/pi-conductor/integration/reviewed"],
  allowed_target_refs: ["refs/heads/main"],
  required_evidence: [{ producer_id: "review", schema_id: "review-v1" }],
  max_input_bytes: 65_536,
  max_output_bytes: 65_536,
  timeout_seconds: 30,
};

const request = {
  schema_version: 1 as const,
  kind: "local_program" as const,
  repository_id: "repo-main",
  operation: "observe-ci",
  source_ref: "refs/pi-conductor/integration/reviewed",
  target_ref: "refs/heads/main",
  reviewed_head: sha("5"),
  evidence: [
    {
      artifact_ref: "artifact/v2/review",
      sha256: sha("6"),
      producer_id: "review",
      schema_id: "review-v1",
      subject_head: sha("5"),
      verdict: "approved" as const,
    },
  ],
  payload: { pull_request: 12 },
};

describe("local-program effect authority", () => {
  it("pins a measured fixed provider and validates registered typed request/result payloads", () => {
    const authority = pinEffectAuthority(grant, [
      {
        id: grant.implementation_id,
        kind: "local_program",
        digest: grant.implementation_digest,
        request_schema_id: grant.request_schema_id,
        request_schema_digest: grant.request_schema_digest,
        output_schema_id: grant.output_schema_id,
        output_schema_digest: grant.output_schema_digest,
      },
    ]);
    expect(() => assertEffectRequestInScope(authority, request)).not.toThrow();
    expect(() =>
      assertEffectResultInScope(authority, request, {
        schema_version: 1,
        kind: "local_program",
        repository_id: request.repository_id,
        operation: request.operation,
        source_ref: request.source_ref,
        target_ref: request.target_ref,
        reviewed_head: request.reviewed_head,
        payload: { ci: "pending" },
      }),
    ).not.toThrow();
  });

  it("rejects a local provider measurement with a mismatched generic schema registration", () => {
    expect(() =>
      pinEffectAuthority(grant, [
        {
          id: grant.implementation_id,
          kind: "local_program",
          digest: grant.implementation_digest,
          request_schema_id: "wrong",
          request_schema_digest: grant.request_schema_digest,
          output_schema_id: grant.output_schema_id,
          output_schema_digest: grant.output_schema_digest,
        },
      ]),
    ).toThrow("implementation is not supported");
  });

  it.each([
    ["caller changes operation", { ...request, operation: "merge" }],
    ["caller changes repository", { ...request, repository_id: "other" }],
    ["caller changes source ref", { ...request, source_ref: "refs/heads/other" }],
    ["caller changes target ref", { ...request, target_ref: "refs/heads/other" }],
    ["caller omits evidence", { ...request, evidence: [] }],
    [
      "caller changes reviewed head",
      { ...request, evidence: [{ ...request.evidence[0], subject_head: sha("7") }] },
    ],
    ["payload misses registered schema", { ...request, payload: { pull_request: "twelve" } }],
  ])("rejects %s before local invocation", (_name, candidate) => {
    const authority = pinEffectAuthority(grant, [
      {
        id: grant.implementation_id,
        kind: "local_program",
        digest: grant.implementation_digest,
        request_schema_id: grant.request_schema_id,
        request_schema_digest: grant.request_schema_digest,
        output_schema_id: grant.output_schema_id,
        output_schema_digest: grant.output_schema_digest,
      },
    ]);
    expect(() => assertEffectRequestInScope(authority, candidate)).toThrow();
  });

  it("rejects changed provider inventory and schema documents", () => {
    const firstOperation = grant.operations[0];
    if (firstOperation === undefined) throw new Error("test local operation is missing");
    expect(() =>
      validateEffectGrant({ ...grant, provider: { ...provider, argv: ["--other"] } }),
    ).toThrow("implementation digest does not match");
    expect(() =>
      validateEffectGrant({
        ...grant,
        operations: [
          {
            ...firstOperation,
            input_schema: { ...firstOperation.input_schema, digest: sha("8") },
          },
        ],
      }),
    ).toThrow("schema digest does not match");
  });
});
