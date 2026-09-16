/** Exact output-authority reconstruction for controller recovery — issue #116. */
import type { ControllerAdapterConfig } from "../../manifest/controller.js";
import type { ControllerOutputPrincipal } from "../../manifest/controller-output.js";
import { combineInputAudiences, intersectOutputAudience } from "../../manifest/output-audience.js";
import type { ApprovedControllerDefinition } from "./approved-definition.js";
import type { ControllerRecoveryArtifacts } from "./recovery-contract.js";

/** Resolve every private input under its actual principal; legacy doubles remain valid only pre-feature. */
export async function recoveryInputAudience(
  artifacts: ControllerRecoveryArtifacts,
  refs: readonly string[],
  principal: ControllerOutputPrincipal,
  featureRequired: boolean,
): Promise<readonly ControllerOutputPrincipal[] | null> {
  if (artifacts.getInputAudience === undefined) {
    if (featureRequired || refs.some((ref) => ref.startsWith("child-output/v2/")))
      throw new Error("controller recovery requires an output audience resolver");
    return null;
  }
  const resolve = artifacts.getInputAudience;
  return combineInputAudiences(await Promise.all(refs.map((ref) => resolve(ref, principal))));
}

/** Reproduce executable-host output authority, including its explicit legacy omission. */
export function recoveredAdapterAudience(
  definition: ApprovedControllerDefinition,
  adapter: ControllerAdapterConfig,
  inputAudience: readonly ControllerOutputPrincipal[] | null,
): readonly ControllerOutputPrincipal[] | undefined {
  const requested =
    adapter.effect_id === undefined
      ? (adapter.output_consumers ?? legacyAudience(definition))
      : (adapter.output_consumers ?? []);
  if (
    adapter.output_consumers === undefined &&
    inputAudience === null &&
    adapter.effect_id === undefined
  )
    return undefined;
  return Object.freeze([...intersectOutputAudience(requested, inputAudience)]);
}

function legacyAudience(
  definition: ApprovedControllerDefinition,
): readonly ControllerOutputPrincipal[] {
  return Object.freeze([
    { kind: "controller" },
    ...definition.config.delegation.allowed_subagents.map((profile_id) => ({
      kind: "native" as const,
      profile_id,
    })),
    ...definition.config.adapters.map((adapter) => ({
      kind: "adapter" as const,
      adapter_id: adapter.id,
    })),
  ]);
}
