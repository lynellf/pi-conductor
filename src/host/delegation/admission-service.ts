/** Structured controller admission facade with no SDK ToolDefinition dependency. */

import type { DelegationSubmissionAcceptedRecord } from "../../persistence/delegation-task.js";
import type { DelegateSubmissionArgs } from "../../seam/schema.js";
import type { PoolChildResult } from "./pool.js";
import type {
  ControllerSchedulerSubmission,
  DelegationScheduler,
  DelegationTaskStatus,
} from "./scheduler.js";

/** Controller-safe access to the host's one native scheduler. */
export interface DelegationAdmissionService {
  submit(
    action: ControllerSchedulerSubmission,
    input: DelegateSubmissionArgs,
  ): Promise<readonly string[]>;
  status(childIds?: readonly string[]): readonly DelegationTaskStatus[];
  wait(childId: string, signal?: AbortSignal): Promise<PoolChildResult>;
  cancel(childIds: readonly string[]): Promise<void>;
  remainingChildren(): number;
  acceptedSubmission(actionId: string): DelegationSubmissionAcceptedRecord | null;
}

/** Expose native admission without a Pi ToolDefinition or synthetic tool-call ID. */
export function createDelegationAdmissionService(
  scheduler: DelegationScheduler,
): DelegationAdmissionService {
  return Object.freeze({
    submit: (action: ControllerSchedulerSubmission, input: DelegateSubmissionArgs) =>
      scheduler.submitController(action, input),
    status: (childIds: readonly string[] | undefined) => scheduler.status(childIds),
    wait: (childId: string, signal: AbortSignal | undefined) => scheduler.wait(childId, signal),
    cancel: (childIds: readonly string[]) => scheduler.cancel(childIds),
    remainingChildren: () => scheduler.remainingChildren(),
    acceptedSubmission: (actionId: string) => scheduler.acceptedControllerSubmission(actionId),
  });
}
