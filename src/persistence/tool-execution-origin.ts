/** Closed provenance for controller-owned executable operations — issue #115 §5. */

import { type Static, Type } from "typebox";
import { sha256Canonical } from "./trajectory-records.js";

const id = Type.String({ minLength: 1, maxLength: 256 });
const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });

/** Real non-SDK provenance for one controller executable operation. */
export const controllerExecutionOriginSchema = Type.Object(
  {
    kind: Type.Literal("controller_operation"),
    controller_id: id,
    definition_digest: sha256,
    activation_id: id,
    owner_epoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    operation_id: id,
    operation_kind: Type.Union([
      Type.Literal("planner"),
      Type.Literal("adapter"),
      Type.Literal("preparation"),
    ]),
    action_id: Type.Union([Type.Null(), id]),
    request_sha256: sha256,
  },
  { additionalProperties: false },
);

export type ControllerExecutionOrigin = Readonly<Static<typeof controllerExecutionOriginSchema>>;

/** Stable equality for correlation across start, readiness, terminal, and repair evidence. */
export function sameControllerExecutionOrigin(
  left: ControllerExecutionOrigin,
  right: ControllerExecutionOrigin,
): boolean {
  return sha256Canonical(left) === sha256Canonical(right);
}

/** Controller operations with external or preparatory effects are never implicitly replayable. */
export function controllerOperationMayReinvokeAfterCleanup(
  origin: ControllerExecutionOrigin,
): boolean {
  return origin.operation_kind === "planner";
}
