/** Reconstruct a LoadedManifest from the durable pinned snapshot. */
import { dirname } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { toMachineDefinition } from "../manifest/definition.js";
import type { ManifestSnapshotRecord } from "../persistence/trajectory-records.js";
import { checkModelProvidersRegistered, type LoadedManifest } from "./manifest.js";
import { resolvePrewalkManifestContext } from "./prewalk-manifest-context.js";

/** Rebuild the host manifest view from the immutable run snapshot. */
export async function loadPinnedManifest(
  snapshot: ManifestSnapshotRecord,
  manifestPath: string,
  modelRegistry: ModelRegistry | undefined,
): Promise<LoadedManifest> {
  const manifestDir = dirname(manifestPath);
  const context = await resolvePrewalkManifestContext({
    manifest: snapshot.normalized_manifest,
    modelRegistry,
    workspaceCwd: manifestDir,
    manifestDir,
  });
  const warnings =
    modelRegistry === undefined
      ? Object.freeze([])
      : checkModelProvidersRegistered(snapshot.normalized_manifest, modelRegistry);
  return Object.freeze({
    manifest: snapshot.normalized_manifest,
    def: toMachineDefinition(snapshot.normalized_manifest, context),
    warnings,
    manifestDir,
    manifestVersion: snapshot.normalized_manifest.version,
    ...(context !== undefined ? { prewalkValidationContext: context } : {}),
  });
}
