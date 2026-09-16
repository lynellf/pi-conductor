import { describe, expect, it } from "vitest";
import {
  assertEffectRequestInScope,
  assertEffectResultInScope,
  type EffectGrant,
  effectAuthorityDigest,
  pinEffectAuthority,
  validateEffectGrant,
  verifyEffectAuthority,
} from "../../src/host/controller/effect-registry.js";
import {
  effectRequestSchemaDigest,
  effectResultSchemaDigest,
  validateEffectResult,
} from "../../src/manifest/controller-effect.js";

const sha = (character: string) => character.repeat(64);

const implementation = {
  id: "builtin-git-integrate-v1",
  kind: "git_integrate" as const,
  digest: sha("1"),
  request_schema_id: "git-integrate-request-v1",
  request_schema_digest: effectRequestSchemaDigest("git_integrate"),
  output_schema_id: "git-integrate-result-v1",
  output_schema_digest: effectResultSchemaDigest("git_integrate"),
};

const grant: EffectGrant = {
  schema_version: 1,
  id: "integrate-reviewed",
  adapter_id: "choose-integration",
  kind: "git_integrate",
  implementation_id: implementation.id,
  implementation_digest: implementation.digest,
  request_schema_id: "git-integrate-request-v1",
  request_schema_digest: implementation.request_schema_digest,
  output_schema_id: "git-integrate-result-v1",
  output_schema_digest: implementation.output_schema_digest,
  repository: {
    id: "repo-main",
    canonical_path: "/srv/repos/project",
    fingerprint: sha("2"),
  },
  allowed_integration_refs: ["refs/pi-conductor/integration/reviewed"],
  allowed_source_paths: ["src/index.ts"],
  required_patch_evidence: [{ producer_id: "review-patch", schema_id: "patch-review-v1" }],
  max_input_bytes: 524_288,
  max_output_bytes: 524_288,
  timeout_seconds: 120,
};

describe("controller effect registry", () => {
  it("pins the exact implementation, schemas, and scope digest", () => {
    const pinned = pinEffectAuthority(grant, [implementation]);
    expect(pinned.authority_digest).toBe(effectAuthorityDigest(grant));
    expect(pinned.grant).toEqual(grant);
  });

  it("rejects an implementation that is not registered by the host", () => {
    expect(() => pinEffectAuthority(grant, [])).toThrow("implementation is not supported");
    expect(() =>
      pinEffectAuthority(grant, [{ ...implementation, request_schema_id: "other-request" }]),
    ).toThrow("implementation is not supported");
  });

  it("validates a closed exact-head broker result", () => {
    expect(() =>
      validateEffectResult("git_integrate", {
        schema_version: 1,
        kind: "git_integrate",
        repository_id: "repo-main",
        accepted_base: sha("3"),
        integrated_head: sha("4"),
        integration_ref: "refs/pi-conductor/integration/reviewed",
        prior_ref_oid: null,
        source_artifact_ref: "artifact/v2/source",
        source_artifact_sha256: sha("5"),
        credential: "must-not-be-recorded",
      }),
    ).toThrow("effect result does not match its built-in schema");
  });

  it("enforces configured request and result byte limits", () => {
    const bounded = pinEffectAuthority({ ...grant, max_input_bytes: 1, max_output_bytes: 1 }, [
      implementation,
    ]);
    expect(() =>
      assertEffectRequestInScope(bounded, {
        schema_version: 1,
        kind: "git_integrate",
      }),
    ).toThrow("effect request exceeds pinned byte authority");
    expect(() =>
      assertEffectResultInScope(
        bounded,
        {
          schema_version: 1,
          kind: "git_integrate",
          repository_id: "repo-main",
          accepted_base: sha("3"),
          integration_ref: "refs/pi-conductor/integration/reviewed",
          expected_ref_oid: null,
          patches: [],
          selected_source_paths: [],
        },
        {},
      ),
    ).toThrow("effect result exceeds pinned byte authority");
  });

  it("rejects unknown grant fields", () => {
    expect(() => validateEffectGrant({ ...grant, shell: "/bin/bash" })).toThrow(
      "effect grant does not match schema version 1",
    );
  });

  it("rejects sensitive source paths and noncanonical Git refs in authority", () => {
    expect(() =>
      validateEffectGrant({ ...grant, allowed_source_paths: [".pi-conductor/private"] }),
    ).toThrow("selected source path is unsafe");
    expect(() =>
      validateEffectGrant({
        ...grant,
        allowed_integration_refs: ["refs/pi-conductor/.hidden"],
      }),
    ).toThrow("unsafe Git ref");
    expect(() =>
      validateEffectGrant({
        ...grant,
        allowed_integration_refs: ["refs/releases/release.lock/candidate"],
      }),
    ).toThrow("unsafe Git ref");
    expect(() =>
      validateEffectGrant({ ...grant, allowed_source_paths: [".PI-CONDUCTOR/private"] }),
    ).toThrow("selected source path is unsafe");
  });

  it("rejects changed or revoked authority on verification", () => {
    const pinned = pinEffectAuthority(grant, [implementation]);
    const changed = { ...grant, allowed_integration_refs: ["refs/heads/main"] };
    expect(() => verifyEffectAuthority(pinned, [changed], [implementation])).toThrow(
      "changed or was revoked",
    );
    expect(() => verifyEffectAuthority(pinned, [], [implementation])).toThrow(
      "changed or was revoked",
    );
  });

  it("rejects duplicate current grants and host implementation identities", () => {
    const pinned = pinEffectAuthority(grant, [implementation]);
    expect(() => verifyEffectAuthority(pinned, [grant, grant], [implementation])).toThrow(
      "duplicate current effect grant identity",
    );
    expect(() => pinEffectAuthority(grant, [implementation, implementation])).toThrow(
      "duplicate supported effect implementation identity",
    );
  });

  it("rejects a valid-shaped result for a different originating request", () => {
    const pinned = pinEffectAuthority(grant, [implementation]);
    const request = integrationRequest("repo-main");
    expect(() =>
      assertEffectResultInScope(pinned, request, {
        schema_version: 1,
        kind: "git_integrate",
        repository_id: "repo-main",
        accepted_base: request.accepted_base,
        integrated_head: sha("8"),
        integration_ref: request.integration_ref,
        prior_ref_oid: sha("9"),
        source_artifact_ref: "artifact/v2/source",
        source_artifact_sha256: sha("a"),
      }),
    ).toThrow("integration result does not match its originating request");
  });

  it("rejects a Git request outside the pinned repository or ref scope", () => {
    const pinned = pinEffectAuthority(grant, [implementation]);
    const request = {
      schema_version: 1 as const,
      kind: "git_integrate" as const,
      repository_id: "repo-other",
      accepted_base: sha("3"),
      integration_ref: "refs/heads/main",
      expected_ref_oid: null,
      patches: [
        {
          artifact_ref: "artifact/v2/patch",
          sha256: sha("4"),
          base_commit: sha("3"),
          evidence: [
            {
              artifact_ref: "artifact/v2/patch-review",
              sha256: sha("5"),
              producer_id: "review-patch",
              schema_id: "patch-review-v1",
              subject_digest: sha("4"),
              verdict: "approved",
            },
          ],
        },
      ],
      selected_source_paths: ["src/index.ts"],
    };
    expect(() => assertEffectRequestInScope(pinned, request)).toThrow(
      "outside the pinned repository scope",
    );
  });

  it("keeps delivery credentials out of pinned requests and requires exact endpoint scope", () => {
    const deliveryImplementation = {
      id: "builtin-deliver-ref-v1",
      kind: "deliver_ref" as const,
      digest: sha("5"),
      request_schema_id: "deliver-ref-request-v1",
      request_schema_digest: effectRequestSchemaDigest("deliver_ref"),
      output_schema_id: "deliver-ref-result-v1",
      output_schema_digest: effectResultSchemaDigest("deliver_ref"),
    };
    const deliveryGrant: EffectGrant = {
      schema_version: 1,
      id: "deliver-reviewed",
      adapter_id: "choose-delivery",
      kind: "deliver_ref",
      implementation_id: deliveryImplementation.id,
      implementation_digest: deliveryImplementation.digest,
      request_schema_id: "deliver-ref-request-v1",
      request_schema_digest: deliveryImplementation.request_schema_digest,
      output_schema_id: "deliver-ref-result-v1",
      output_schema_digest: deliveryImplementation.output_schema_digest,
      repository: grant.repository,
      remote: {
        id: "fake-origin",
        exact_origin: "https://delivery.invalid",
        exact_path: "/v1/refs/main",
        method: "PUT",
        credential_source_id: "delivery-token",
      },
      allowed_source_refs: ["refs/pi-conductor/integration/reviewed"],
      allowed_target_refs: ["refs/heads/main"],
      required_evidence: [{ producer_id: "validate-integrated", schema_id: "validation-v1" }],
      max_input_bytes: 65_536,
      max_output_bytes: 65_536,
      timeout_seconds: 30,
    };
    const pinned = pinEffectAuthority(deliveryGrant, [deliveryImplementation]);
    expect(JSON.stringify(pinned)).not.toContain("token-value");
    expect(() =>
      assertEffectRequestInScope(pinned, {
        schema_version: 1,
        kind: "deliver_ref",
        repository_id: "repo-main",
        source_ref: "refs/pi-conductor/integration/reviewed",
        reviewed_head: sha("6"),
        remote_id: "other-origin",
        target_ref: "refs/heads/main",
        expected_remote_oid: null,
        idempotency_key: "delivery-1",
        evidence: [
          {
            artifact_ref: "artifact/v2/evidence",
            sha256: sha("7"),
            producer_id: "validate-integrated",
            schema_id: "validation-v1",
            subject_head: sha("6"),
            verdict: "approved",
          },
        ],
      }),
    ).toThrow("outside the pinned remote scope");
  });

  it("rejects remote paths that escape or change under URL normalization", () => {
    const delivery = {
      ...grant,
      kind: "deliver_ref" as const,
      remote: {
        id: "remote",
        exact_origin: "https://delivery.invalid",
        exact_path: "//attacker.invalid/write",
        method: "PUT" as const,
        credential_source_id: "private-token",
      },
      allowed_source_refs: ["refs/pi-conductor/integration/reviewed"],
      allowed_target_refs: ["refs/heads/main"],
      required_evidence: [{ producer_id: "validate", schema_id: "validation-v1" }],
    };
    const {
      allowed_integration_refs: _refs,
      allowed_source_paths: _paths,
      required_patch_evidence: _evidence,
      ...candidate
    } = delivery;
    expect(() => validateEffectGrant(candidate)).toThrow("effect remote path must be exact");
    expect(() =>
      validateEffectGrant({
        ...candidate,
        remote: { ...candidate.remote, exact_path: "/v1/%2e%2e/private" },
      }),
    ).toThrow("effect remote path must be exact");
  });
});

function integrationRequest(repositoryId: string) {
  return {
    schema_version: 1 as const,
    kind: "git_integrate" as const,
    repository_id: repositoryId,
    accepted_base: sha("3"),
    integration_ref: "refs/pi-conductor/integration/reviewed",
    expected_ref_oid: null,
    patches: [
      {
        artifact_ref: "artifact/v2/patch",
        sha256: sha("4"),
        base_commit: sha("3"),
        evidence: [
          {
            artifact_ref: "artifact/v2/review",
            sha256: sha("5"),
            producer_id: "review-patch",
            schema_id: "patch-review-v1",
            subject_digest: sha("4"),
            verdict: "approved" as const,
          },
        ],
      },
    ],
    selected_source_paths: ["src/index.ts"],
  };
}
