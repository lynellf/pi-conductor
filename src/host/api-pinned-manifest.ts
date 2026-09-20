/** Reconstruct a LoadedManifest from the durable pinned snapshot. */
import { dirname } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { toMachineDefinition } from "../manifest/definition.js";
import {
  parseDelegationAssignments,
  parseDelegationInterface,
} from "../manifest/delegation-assignment.js";
import { parseSubagentWorkspace } from "../manifest/subagent-projection.js";
import type { AssignmentDelegationPolicy, LegacyDelegationPolicy } from "../manifest/types.js";
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
    roles: Object.freeze(
      pinned.roles.map((role, index) => {
        if (role.delegation === undefined) return role;
        const delegation = role.delegation;
        const assignments = parseDelegationAssignments(
          delegation.assignments,
          `pinned roles[${index}].delegation.assignments`,
        );
        const delegationInterface = parseDelegationInterface(
          delegation.interface,
          `pinned roles[${index}].delegation`,
        );
        if (delegationInterface === "assignments_v1") {
          const normalizedDelegation = Object.freeze({
            ...delegation,
            interface: delegationInterface,
            ...(assignments === undefined ? {} : { assignments }),
          }) as AssignmentDelegationPolicy;
          return Object.freeze({ ...role, delegation: normalizedDelegation });
        }
        if (assignments !== undefined) {
          throw new Error(`pinned roles[${index}].delegation.assignments is invalid for legacy_v1`);
        }
        const normalizedDelegation = Object.freeze({
          ...delegation,
          interface: delegationInterface,
        }) as LegacyDelegationPolicy;
        return Object.freeze({ ...role, delegation: normalizedDelegation });
      }),
    ),
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
