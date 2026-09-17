/** Measure the exact host and registered provider code before effect admission (#117). */
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import { measureBuiltinEffectImplementations } from "./effect-implementation-inventory.js";
import type { PinnedEffectAuthority, SupportedEffectImplementation } from "./effect-registry.js";
import {
  deriveLocalProgramHostDriverDigest,
  measureLocalProgramImplementation,
} from "./local-effect-measurement.js";

/** Build one measured inventory without treating operator-declared hashes as observations. */
export async function measureProductionEffectImplementations(
  authorities: readonly PinnedEffectAuthority[],
): Promise<readonly SupportedEffectImplementation[]> {
  const builtins = await measureBuiltinEffectImplementations();
  const hostDigest = deriveLocalProgramHostDriverDigest(builtins);
  const local = await Promise.all(
    authorities.flatMap(({ grant }) =>
      grant.kind === "local_program" ? [measureLocalProgramImplementation(grant, hostDigest)] : [],
    ),
  );
  const unique = new Map<string, SupportedEffectImplementation>();
  for (const entry of [...builtins, ...local]) {
    const prior = unique.get(entry.id);
    if (prior !== undefined && sha256Canonical(prior) !== sha256Canonical(entry))
      throw new Error("effect implementation registration conflicts");
    unique.set(entry.id, entry);
  }
  return Object.freeze([...unique.values()]);
}

/** Reject file or runtime replacement without silently adopting a new implementation. */
export async function verifyProductionEffectImplementations(
  authorities: readonly PinnedEffectAuthority[],
  expected: readonly SupportedEffectImplementation[],
): Promise<readonly SupportedEffectImplementation[]> {
  const current = await measureProductionEffectImplementations(authorities);
  if (sha256Canonical(current) !== sha256Canonical(expected))
    throw new Error("effect implementation changed or was replaced");
  return current;
}
