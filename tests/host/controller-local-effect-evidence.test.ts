import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { resolveLocalEffectEvidence } from "../../src/host/controller/local-effect-evidence.js";
import type { LocalProgramRequest } from "../../src/manifest/local-effect.js";

it("stops resolving further evidence once aggregate encoded input exceeds the grant", async () => {
  const bytes = Buffer.alloc(600, "a");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const request: LocalProgramRequest = {
    schema_version: 1,
    kind: "local_program",
    repository_id: "repo",
    operation: "observe",
    source_ref: "refs/heads/source",
    target_ref: "refs/heads/target",
    reviewed_head: "a".repeat(40),
    payload: {},
    evidence: ["one", "two", "three"].map((artifact_ref) => ({
      artifact_ref,
      sha256,
      producer_id: "review",
      schema_id: "review-v1",
      subject_head: "a".repeat(40),
      verdict: "approved",
    })),
  };
  const resolveBytes = vi.fn(async () => bytes);
  const resolveClaim = async (claim: LocalProgramRequest["evidence"][number]) => ({
    artifactRef: claim.artifact_ref,
    sha256: claim.sha256,
    producerId: claim.producer_id,
    schemaId: claim.schema_id,
    subjectHead: claim.subject_head,
    verdict: claim.verdict,
  });
  await expect(
    resolveLocalEffectEvidence(
      request,
      Buffer.byteLength(JSON.stringify(request)) + 1000,
      resolveClaim,
      resolveBytes,
    ),
  ).rejects.toThrow("input byte limit");
  expect(resolveBytes).toHaveBeenCalledTimes(2);
});
