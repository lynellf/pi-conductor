/** Generic trusted-provider outputs retain every private input's audience (#117). */
import { combineInputAudiences, intersectOutputAudience } from "../../manifest/output-audience.js";
import type { ControllerEffectIntentRecord } from "../../persistence/controller-effect-records.js";
import { resultConsumers } from "./production-effect-support.js";
import type { ProductionEffectsOptions } from "./production-effects.js";

/** Unlike fixed built-in receipts, a provider's arbitrary typed result can contain input data. */
export async function localEffectResultConsumers(
  options: ProductionEffectsOptions,
  intent: ControllerEffectIntentRecord,
) {
  if (intent.request.kind !== "local_program") throw new Error("expected local provider intent");
  const refs = [
    intent.request_artifact.ref,
    ...intent.request.evidence.map((claim) => claim.artifact_ref),
  ];
  const audiences = await Promise.all(
    refs.map(
      async (ref) =>
        (
          await options.outputResolver.resolveRef(ref, {
            kind: "effect",
            effect_id: intent.effect_id,
          })
        ).audience,
    ),
  );
  return intersectOutputAudience(
    resultConsumers(options.definition, intent.adapter_id),
    combineInputAudiences(audiences),
  );
}
