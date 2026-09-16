/** Principal equality and non-widening derived audiences — issue #116. */
import type { ControllerOutputPrincipal } from "./controller-output.js";

/** Use discriminants rather than JSON property order as the consumer identity. */
export function outputPrincipalKey(principal: ControllerOutputPrincipal): string {
  switch (principal.kind) {
    case "controller":
      return "controller";
    case "native":
      return `native:${principal.profile_id}`;
    case "adapter":
      return `adapter:${principal.adapter_id}`;
    case "effect":
      return `effect:${principal.effect_id}`;
  }
}

/** Preserve only consumers granted by every private input; null denotes no private input. */
export function intersectOutputAudience(
  requested: readonly ControllerOutputPrincipal[],
  inputs: readonly ControllerOutputPrincipal[] | null,
): readonly ControllerOutputPrincipal[] {
  const allowed = inputs === null ? null : new Set(inputs.map(outputPrincipalKey));
  return requested.filter(
    (principal) => allowed === null || allowed.has(outputPrincipalKey(principal)),
  );
}

/** Accumulate the authority shared by every input, preserving an explicit empty audience. */
export function combineInputAudiences(
  inputs: readonly (readonly ControllerOutputPrincipal[] | null)[],
): readonly ControllerOutputPrincipal[] | null {
  let result: readonly ControllerOutputPrincipal[] | null = null;
  for (const audience of inputs) {
    if (audience === null) continue;
    result = result === null ? audience : intersectOutputAudience(result, audience);
  }
  return result;
}
