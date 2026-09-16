/** Pure lookups shared by production effect execution and recovery. */
import type { PersistedRecord } from "../../persistence/log.js";
import type { ApprovedControllerDefinition } from "./approved-definition.js";
import type { PinnedEffectAuthority } from "./effect-registry.js";
import type { ControllerHostApproval } from "./host-approval.js";

export function effectContext(
  definition: ApprovedControllerDefinition,
  actionId: string,
  adapterId: string,
  effectId: string,
) {
  return {
    runId: definition.record.run_id,
    definitionDigest: definition.record.definition_digest,
    actionId,
    adapterId,
    effectId,
  };
}

export function durableEffectIntent(records: readonly PersistedRecord[], operationId: string) {
  const value = records.find(
    (
      record,
    ): record is Extract<
      import("../../persistence/controller-effect-records.js").ControllerEffectRecord,
      { type: "controller_effect_intent" }
    > => record.type === "controller_effect_intent" && record.operation_id === operationId,
  );
  if (value === undefined) throw new Error("effect publication has no durable intent");
  return value;
}

export function pinnedEffects(value: unknown): readonly PinnedEffectAuthority[] | undefined {
  if (value === null || typeof value !== "object" || !("effects" in value)) return undefined;
  return (value as { effects?: readonly PinnedEffectAuthority[] }).effects;
}

export function pinnedEffectForAdapter(
  pinned: ReadonlyMap<string, PinnedEffectAuthority>,
  adapterId: string,
): string {
  const found = [...pinned.values()].find((entry) => entry.grant.adapter_id === adapterId);
  if (found === undefined) throw new Error("effect request adapter is not pinned");
  return found.grant.id;
}

export function sourceConsumers(definition: ApprovedControllerDefinition, adapterId: string) {
  return definition.config.adapters.find((entry) => entry.id === adapterId)?.source_consumers ?? [];
}

export function resultConsumers(definition: ApprovedControllerDefinition, adapterId: string) {
  // Result metadata is private until the operator names its readers explicitly.
  return definition.config.adapters.find((entry) => entry.id === adapterId)?.result_consumers ?? [];
}

export function assertCredentialSources(
  pinned: ReadonlyMap<string, PinnedEffectAuthority>,
  approval: ControllerHostApproval,
  files: Readonly<Record<string, string>>,
): void {
  for (const authority of pinned.values()) {
    if (authority.grant.kind !== "deliver_ref") continue;
    const id = authority.grant.remote.credential_source_id;
    const current = approval.credential_sources?.find((entry) => entry.id === id);
    if (current === undefined || files[id] !== current.path)
      throw new Error("effect credential source changed or was revoked");
  }
}
