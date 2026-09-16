/** Controller action dispatcher contracts — issue #115 §§4, 6. */

import type { ControllerAction } from "../../manifest/controller-protocol.js";
import type { ControllerSourceCursor } from "../../persistence/controller-records.js";
import type { DelegationSubmissionAcceptedRecord } from "../../persistence/delegation-task.js";
import type {
  ControllerActionReceiptRecord,
  ControllerActionState,
  ControllerActivationStartedRecord,
  PersistedRecord,
} from "../../persistence/log.js";
import type { DelegationAdmissionService } from "../delegation/admission-service.js";
import type { ArtifactRangeRead, ArtifactStore } from "./artifact-store.js";
import type { ControllerEventPage } from "./event-page.js";
import type { ExecutableControllerHost } from "./executable-host-contract.js";

/** One safe host result returned for a controller opaque read. */
export type ControllerReadResult =
  | { readonly kind: "artifact"; readonly value: ArtifactRangeRead }
  | {
      readonly kind: "action" | "request" | "accepted" | "record";
      readonly value: {
        readonly encoding: "base64";
        readonly data: string;
        readonly offset: number;
        readonly next_offset: number;
        readonly total_bytes: number;
        readonly eof: boolean;
      };
    };

/** Dependencies fixed to one activation and host append fence. */
export interface CreateControllerActionDispatcherOptions {
  readonly activation: ControllerActivationStartedRecord;
  readonly readRecords: () => readonly PersistedRecord[];
  readonly persist: (record: PersistedRecord) => void;
  readonly admission: DelegationAdmissionService;
  readonly executables: Pick<ExecutableControllerHost, "invokeAdapter">;
  readonly artifacts: Pick<ArtifactStore, "rangeReadForController" | "createStaging" | "publish">;
  readonly assertOpen: () => void;
  /** Activation-owned abort signal propagated into adapter execution. */
  readonly signal?: AbortSignal;
  readonly runNativePreparation: <T>(
    action: Extract<ControllerAction, { readonly kind: "delegate" }>,
    operation: () => Promise<T>,
  ) => Promise<T>;
  readonly wake: () => void;
  readonly onFatal: (cause: unknown) => void;
  readonly maxAdapters?: number;
}

/** Async dispatcher for effects that already have durable controller intents. */
export interface ControllerActionDispatcher {
  validateReferences(actions: readonly ControllerAction[]): Promise<void>;
  dispatchCommitted(actionId: string): void;
  settle(): Promise<void>;
  getAction(actionId: string): ControllerActionState | null;
  getAcceptedSubmission(actionId: string): DelegationSubmissionAcceptedRecord | null;
  getEvents(cursor: ControllerSourceCursor | null, limit?: number): ControllerEventPage;
  read(ref: string, offset?: number, limit?: number): Promise<ControllerReadResult>;
  resolveRef(ref: string): Promise<unknown>;
  pendingCount(): number;
}

/** Build one receipt only from a durable action identity. */
export type ReceiptFields = Pick<
  ControllerActionReceiptRecord,
  "outcome" | "operation_id" | "result_refs" | "diagnostic"
> & { readonly result?: unknown };
