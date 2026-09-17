/** Controller action dispatcher contracts — issue #115 §§4, 6. */

import type { ControllerOutputPrincipal } from "../../manifest/controller-output.js";
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
import type { ResolvedControllerOutput } from "./output-resolver.js";

/** One safe host result returned for a controller opaque read. */
export type ControllerReadResult =
  | { readonly kind: "artifact"; readonly value: ArtifactRangeRead }
  | {
      readonly kind: "action" | "request" | "accepted" | "record" | "child_output";
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
  /** Host-only source service; requests select pinned identities, never filesystem paths. */
  readonly sources?: {
    readonly validate: (
      action: Extract<ControllerAction, { kind: "prepare_source" }>,
    ) => Promise<void>;
    readonly prepare: (
      action: Extract<ControllerAction, { kind: "prepare_source" }>,
      requestDigest: string,
      signal?: AbortSignal,
    ) => Promise<ReceiptFields>;
    readonly resolve: (
      ref: string,
      principal: ControllerOutputPrincipal,
    ) => Promise<{
      readonly descriptor: unknown;
      readonly audience: readonly ControllerOutputPrincipal[];
    }>;
  };
  /** A fixed adapter may hand a validated request to an independently tracked host effect. */
  readonly runAdapterEffect?: (
    action: Extract<ControllerAction, { readonly kind: "adapter" }>,
    result: import("./executable-host-contract.js").ControllerAdapterInvocationResult,
    signal?: AbortSignal,
  ) => Promise<ReceiptFields> | null;
  readonly outputResolver?: {
    readonly resolveRef: (
      ref: string,
      principal: ControllerOutputPrincipal,
    ) => Promise<ResolvedControllerOutput>;
    readonly getInputAudience: (
      ref: string,
      principal?: ControllerOutputPrincipal,
    ) => Promise<readonly ControllerOutputPrincipal[] | null>;
  };
  readonly externalPendingCount?: () => number;
  readonly externalSettle?: () => Promise<void>;
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
  resolveRef(ref: string, principal?: ControllerOutputPrincipal): Promise<unknown>;
  pendingCount(): number;
}

/** Build one receipt only from a durable action identity. */
export type ReceiptFields = Pick<
  ControllerActionReceiptRecord,
  "outcome" | "operation_id" | "result_refs" | "diagnostic"
> & { readonly result?: unknown };
