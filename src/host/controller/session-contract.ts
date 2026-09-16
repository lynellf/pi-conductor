/** Dependencies for the controller RoleSession without an SDK conversation — issue #115 §5. */
import type { Role } from "../../core/types.js";
import type { ControllerRequest, ControllerResponse } from "../../manifest/controller-protocol.js";
import type { ControllerActivationStartedRecord } from "../../persistence/controller-records.js";
import type { PersistedRecord } from "../../persistence/log.js";
import type { DelegationAdmissionService } from "../delegation/admission-service.js";
import type { RoleSession } from "../role-session-contract.js";
import type { ControllerActionDispatcher } from "./action-dispatcher-contract.js";
import type { ControllerActivationFence } from "./activation-fence.js";

/** Host callbacks share the durable writer and the existing native admission service. */
export interface ControllerRoleSessionOptions {
  readonly role: Role;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly activation: ControllerActivationStartedRecord;
  readonly readRecords: () => readonly PersistedRecord[];
  readonly persist: (record: PersistedRecord) => void;
  readonly invokePlanner: (
    request: ControllerRequest,
    signal: AbortSignal,
  ) => Promise<ControllerResponse>;
  readonly dispatcher: ControllerActionDispatcher;
  readonly fence: ControllerActivationFence;
  readonly maxParallel: number;
  readonly admission: DelegationAdmissionService;
  readonly isRunCostCapReached: () => boolean;
  /** Permanently close executables and native scope and await owned cleanup. */
  readonly closeOwnedWork: () => Promise<void>;
}
/** Host-only wake/failure controls; neither accepts repository-supplied authority. */
export interface ControllerRoleSession extends RoleSession {
  wake(): void;
  fail(cause: unknown): void;
  stopForRunCostCap(): void;
}
