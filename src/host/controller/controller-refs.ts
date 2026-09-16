/** Opaque controller timeline references — issue #115 §§4, 6. */

import type { ControllerActivationStartedRecord, PersistedRecord } from "../../persistence/log.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";

export type ControllerRefKind = "action" | "request" | "accepted" | "record";

/** Derive the controller namespace that prevents cross-definition ref access. */
export function controllerRefNamespace(identity: {
  readonly run_id: string;
  readonly controller_id: string;
  readonly definition_digest: string;
}): string {
  return sha256Canonical({
    domain: "pi-conductor/controller-ref-namespace/v1",
    run_id: identity.run_id,
    controller_id: identity.controller_id,
    definition_digest: identity.definition_digest,
  });
}

/** Format an opaque ref from a canonical timeline value. */
export function controllerRef(
  identity: {
    readonly run_id: string;
    readonly controller_id: string;
    readonly definition_digest: string;
  },
  kind: ControllerRefKind,
  value: unknown,
): string {
  return `controller/v1/${controllerRefNamespace(identity)}/${kind}/${sha256Canonical(value)}`;
}

/** Opaque query ref for one durable controller action identity. */
export function controllerActionRef(
  activation: ControllerActivationStartedRecord,
  actionId: string,
): string {
  return controllerRef(activation, "action", { action_id: actionId });
}

/** Opaque query ref for the inline durable request of one action. */
export function controllerRequestRef(
  activation: ControllerActivationStartedRecord,
  actionId: string,
): string {
  return controllerRef(activation, "request", { action_id: actionId });
}

/** Opaque query ref for a controller-native accepted submission. */
export function controllerAcceptedSubmissionRef(
  activation: ControllerActivationStartedRecord,
  actionId: string,
): string {
  return controllerRef(activation, "accepted", { action_id: actionId });
}

/** Opaque query ref for one exact durable record value. */
export function controllerRecordRef(
  activation: ControllerActivationStartedRecord,
  record: PersistedRecord,
): string {
  return controllerRef(activation, "record", record);
}

/** Parse only the closed controller reference grammar. */
export function parseControllerRef(ref: string): {
  readonly namespace: string;
  readonly kind: ControllerRefKind;
  readonly digest: string;
} {
  const match =
    /^controller\/v1\/([a-f0-9]{64})\/(action|request|accepted|record)\/([a-f0-9]{64})$/u.exec(ref);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined)
    throw new Error("invalid controller opaque reference");
  return { namespace: match[1], kind: match[2] as ControllerRefKind, digest: match[3] };
}
