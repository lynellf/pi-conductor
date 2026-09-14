/** Reconstruct a LoadedManifest from the durable pinned snapshot. */
import { dirname } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { toMachineDefinition } from "../manifest/definition.js";
import { parseSubagentWorkspace } from "../manifest/subagent-projection.js";
import type { ManifestSnapshotRecord } from "../persistence/trajectory-records.js";
import { checkModelProvidersRegistered, type LoadedManifest } from "./manifest.js";

/** Rebuild the host manifest view from the immutable run snapshot. */
export async function loadPinnedManifest(
  snapshot: ManifestSnapshotRecord,
  manifestPath: string,
  modelRegistry: ModelRegistry | undefined,
): Promise<LoadedManifest> {
  const manifestDir = dirname(manifestPath);
  // Retained JSON is untrusted at runtime. Reparse the closed workspace union
  // without applying current manifest defaults to unrelated pinned fields.
  const pinned = snapshot.normalized_manifest;
  const manifest = Object.freeze({
    ...pinned,
    ...(pinned.subagents === undefined
      ? {}
      : {
          subagents: Object.freeze(
            pinned.subagents.map((profile, index) =>
              profile.workspace === undefined
                ? profile
                : Object.freeze({
                    ...profile,
                    workspace: parseSubagentWorkspace(
                      profile.workspace,
                      `pinned subagents[${index}].workspace`,
                    ),
                  }),
            ),
          ),
        }),
  });
  const warnings =
    modelRegistry === undefined
      ? Object.freeze([])
      : checkModelProvidersRegistered(manifest, modelRegistry);
  return Object.freeze({
    manifest,
    def: toMachineDefinition(manifest),
    warnings,
    manifestDir,
    manifestVersion: manifest.version,
  });
}
