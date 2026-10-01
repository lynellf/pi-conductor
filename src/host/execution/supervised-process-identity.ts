/** Platform observation facade; Linux keeps its procfs implementation (#76 / #165). */
import * as linux from "./linux-process-identity.js";
import * as macos from "./macos/process-identity.js";
import type { ProcessIdentity, ProcessObservationScope } from "./process-identity-contract.js";

export {
  ownsProcessGroup,
  ownsProcessIdentity,
  type ProcessIdentity,
  ProcessObservationError,
  type ProcessObservationOperation,
  type ProcessObservationScope,
} from "./process-identity-contract.js";

function backend() {
  return process.platform === "darwin" ? macos : linux;
}

/** Capture original process identities before spawning any workload. */
export function snapshotProcessNamespace(): Promise<ProcessObservationScope> {
  return backend().snapshotProcessNamespace();
}
/** Observe identity, optionally requiring a positive execution marker. */
export function readProcessIdentity(pid: number, token?: string): Promise<ProcessIdentity | null> {
  return backend().readProcessIdentity(pid, token);
}
/** Discover escapers or reject incomplete ownership observations. */
export function findProcessesByOwnerToken(
  token: string,
  minimum?: string,
  scope?: ProcessObservationScope,
): Promise<readonly ProcessIdentity[]> {
  return backend().findProcessesByOwnerToken(token, minimum, scope);
}
/** Report live members of one observed process group. */
export function processGroupHasLiveMembers(group: number): Promise<boolean> {
  return backend().processGroupHasLiveMembers(group);
}
/** Snapshot live process-group identities without granting signal authority. */
export function readProcessGroupMembers(group: number): Promise<readonly ProcessIdentity[]> {
  return backend().readProcessGroupMembers(group);
}
/** Observe members of an originally owned session. */
export function readProcessSessionMembers(
  session: number,
  minimum: string,
  scope: ProcessObservationScope,
): Promise<readonly ProcessIdentity[]> {
  return backend().readProcessSessionMembers(session, minimum, scope);
}
