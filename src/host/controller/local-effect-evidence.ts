/** Bound private evidence aggregation before admitting a provider process (#117). */
import { createHash } from "node:crypto";
import type { LocalProgramInvocation, LocalProgramRequest } from "../../manifest/local-effect.js";
import type { EffectBrokerDependencies } from "./effect-broker-contract.js";

/** Resolve in order, checking identity and size before retaining encoded bytes. */
export async function resolveLocalEffectEvidence(
  request: LocalProgramRequest,
  maximumBytes: number,
  resolveClaim: (
    claim: LocalProgramRequest["evidence"][number],
  ) => ReturnType<EffectBrokerDependencies["resolveHeadEvidence"]>,
  resolveBytes: (claim: LocalProgramRequest["evidence"][number]) => Promise<Buffer>,
): Promise<LocalProgramInvocation["evidence"]> {
  const evidence: LocalProgramInvocation["evidence"] = [];
  let encodedBytes = Buffer.byteLength(JSON.stringify(request));
  for (const claim of request.evidence) {
    const verified = await resolveClaim(claim);
    if (
      verified.artifactRef !== claim.artifact_ref ||
      verified.sha256 !== claim.sha256 ||
      verified.producerId !== claim.producer_id ||
      verified.schemaId !== claim.schema_id ||
      verified.subjectHead !== request.reviewed_head ||
      verified.verdict !== "approved"
    )
      throw new Error("local effect evidence binding mismatch");
    const bytes = await resolveBytes(claim);
    encodedBytes += 4 * Math.ceil(bytes.byteLength / 3);
    if (encodedBytes > maximumBytes)
      throw new Error("local effect evidence exceeds input byte limit");
    if (createHash("sha256").update(bytes).digest("hex") !== claim.sha256)
      throw new Error("local effect evidence digest mismatch");
    evidence.push({
      artifact_ref: claim.artifact_ref,
      sha256: claim.sha256,
      bytes_base64: bytes.toString("base64"),
    });
  }
  // The runtime also bounds the complete serialized envelope, including credentials.
  return evidence;
}
