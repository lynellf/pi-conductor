/** Exact public Pi SDK capability gate for Issue #63 trajectory transport. */

import { VERSION } from "@earendil-works/pi-coding-agent";

import type { HandoffPolicy } from "../manifest/types.js";
import { TrajectoryHandoffError } from "./trajectory-admission.js";

const TRAJECTORY_SDK_VERSION = "0.80.6";

/** Fail closed unless the SDK version proven by the acknowledged spike is loaded. */
export function assertTrajectorySdkSupported(version: string = VERSION): void {
  if (version !== TRAJECTORY_SDK_VERSION) {
    throw new TrajectoryHandoffError(
      "trajectory_environment_unsupported",
      `trajectory requires @earendil-works/pi-coding-agent ${TRAJECTORY_SDK_VERSION}; loaded ${version}`,
    );
  }
}

/** Reject trajectory-bearing manifests before production host side effects. */
export function assertTrajectorySdkSupportedForHandoffs(
  handoffs: readonly HandoffPolicy[] | undefined,
  version: string = VERSION,
): void {
  if (handoffs?.some((policy) => policy.mode === "trajectory") !== true) return;
  assertTrajectorySdkSupported(version);
}
