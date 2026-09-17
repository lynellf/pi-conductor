/** Protected host-driver and trusted program measurement for issue #117. */

import { lstat } from "node:fs/promises";

import { sha256Canonical } from "../../persistence/trajectory-records.js";
import { measureProtectedImplementationFiles } from "./effect-implementation-inventory.js";
import type { SupportedEffectImplementation } from "./effect-registry.js";
import {
  localProgramImplementationDigest,
  localProgramRuntimeDigest,
} from "./local-effect-registry.js";
import type { LocalProgramRuntimeGrant } from "./local-effect-runtime-contract.js";

export interface LocalProgramImplementationMeasurement {
  readonly hostDriverDigest: string;
  readonly programRuntimeDigest: string;
  readonly implementationDigest: string;
}

/** Derive the protected host-driver identity from the measured built-in closure. */
export function deriveLocalProgramHostDriverDigest(
  builtins: readonly SupportedEffectImplementation[],
): string {
  if (builtins.some((entry) => entry.kind === "local_program"))
    throw new Error("host driver inventory must contain only measured built-in effects");
  return sha256Canonical(builtins);
}

/** Measure the host driver and complete operator-declared program runtime closure. */
export async function measureLocalProgramImplementation(
  grant: LocalProgramRuntimeGrant,
  hostDriverDigest: string,
): Promise<SupportedEffectImplementation> {
  const measurement = await measureLocalProgramImplementationMetadata(grant, hostDriverDigest);
  return Object.freeze({
    id: grant.implementation_id,
    kind: "local_program",
    digest: measurement.implementationDigest,
    request_schema_id: grant.request_schema_id,
    request_schema_digest: grant.request_schema_digest,
    output_schema_id: grant.output_schema_id,
    output_schema_digest: grant.output_schema_digest,
  });
}

/** Return separate measurement domains for audit records and immediate pre-spawn checks. */
export async function measureLocalProgramImplementationMetadata(
  grant: LocalProgramRuntimeGrant,
  hostDriverDigest: string,
): Promise<LocalProgramImplementationMeasurement> {
  if (!/^[a-f0-9]{64}$/.test(hostDriverDigest) || grant.host_driver_digest !== hostDriverDigest)
    throw new Error("local provider host driver measurement changed or was replaced");
  const executable = grant.provider.executable;
  const declared = [executable, ...grant.provider.runtime.dependencies];
  const byPath = new Map<string, string>();
  for (const entry of declared) {
    const prior = byPath.get(entry.canonical_path);
    if (prior !== undefined && prior !== entry.sha256)
      throw new Error("local provider inventory gives one file conflicting digests");
    byPath.set(entry.canonical_path, entry.sha256);
  }
  const measured = await measureProtectedImplementationFiles([...byPath.keys()], {});
  for (const file of measured.files) {
    if (byPath.get(file.path) !== file.sha256)
      throw new Error("local provider executable or runtime dependency changed or was replaced");
  }
  const executableStat = await lstat(executable.canonical_path);
  if ((executableStat.mode & 0o111) === 0)
    throw new Error("local provider executable is not executable");
  const programRuntimeDigest = localProgramRuntimeDigest(grant.provider.runtime);
  if (programRuntimeDigest !== grant.provider.runtime.digest)
    throw new Error("local provider runtime inventory digest changed or was replaced");
  const implementationDigest = localProgramImplementationDigest(grant.provider, hostDriverDigest);
  if (implementationDigest !== grant.implementation_digest)
    throw new Error("local provider implementation measurement changed or was replaced");
  return Object.freeze({
    hostDriverDigest,
    programRuntimeDigest,
    implementationDigest,
  });
}
