/** Contracts shared by controller recovery planners — issue #115 §6. */

import type { ControllerActionReceiptRecord } from "../../persistence/controller-records.js";
import type { ControllerActionState } from "../../persistence/controller-timeline.js";
import type {
  ArtifactBinding,
  ArtifactControllerRangeReadRequest,
  ArtifactRangeRead,
  PublishedArtifact,
} from "./artifact-store.js";

/** One receipt that recovery can derive only from existing authoritative records. */
export interface ControllerRecoveryReceipt {
  readonly actionId: string;
  readonly outcome: "accepted" | "completed" | "failed" | "interrupted";
  readonly operationId: string | null;
  readonly resultRefs: readonly string[];
  readonly diagnostic: string | null;
  readonly intentActivationId: string;
  readonly causalRevision: number;
  readonly requestSha256: string;
  readonly kind: ControllerActionReceiptRecord["kind"];
  readonly result?: unknown;
}

/** Immutable publication lookup available to resume planning without publication authority. */
export interface ControllerRecoveryArtifacts {
  recoverAction(binding: ArtifactBinding): Promise<PublishedArtifact>;
  rangeReadForController(request: ArtifactControllerRangeReadRequest): Promise<ArtifactRangeRead>;
}

/** Pure resume decision. A false gate forbids creating the next controller activation. */
export interface ControllerRecoveryPlan {
  readonly canActivate: boolean;
  readonly receipts: readonly ControllerRecoveryReceipt[];
  readonly blocked: readonly string[];
  readonly freshActionRequired: readonly string[];
  readonly previousActivationId: string | null;
  readonly nextOwnerEpoch: number;
}

/** Build one recovery receipt from the original durable action identity. */
export function controllerRecoveryReceipt(
  action: ControllerActionState,
  outcome: ControllerRecoveryReceipt["outcome"],
  resultRefs: readonly string[],
  diagnostic: string | null,
  operationId: string | null = null,
  result?: unknown,
): ControllerRecoveryReceipt {
  return Object.freeze({
    actionId: action.actionId,
    outcome,
    operationId,
    resultRefs: Object.freeze([...resultRefs]),
    diagnostic,
    intentActivationId: action.intentActivationId,
    causalRevision: action.originalRevision,
    requestSha256: action.intent.request_sha256,
    kind: action.intent.kind,
    ...(result === undefined ? {} : { result }),
  });
}
