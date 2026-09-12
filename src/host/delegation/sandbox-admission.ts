/** Host-bound delegated sandbox admission adapter for Issue #106 §§3–5. */

import {
  captureSandboxAdmission,
  readSandboxAdmission,
} from "../execution/sandbox/admission-store.js";
import { pinSandboxPolicy } from "../execution/sandbox/policy-pin.js";
import type { HostApprovedBubblewrapBuild } from "../execution/sandbox/prerequisites.js";
import { runSandboxCapabilityProbe } from "../execution/sandbox/probe-runner.js";
import type {
  HostApprovedBootstrapRuntime,
  RuntimeHostProtection,
} from "../execution/sandbox/runtime-types.js";
import type { SandboxAdmissionAdapter } from "./delegate-tool.js";

/** Trusted host configuration captured independently from manifest authority. */
export interface CreateSandboxAdmissionAdapterOptions {
  readonly runId: string;
  readonly runStateDir: string;
  readonly primaryCheckout: string;
  readonly manifestRoot: string;
  readonly hostProtection: RuntimeHostProtection;
  readonly bootstrapApproval: HostApprovedBootstrapRuntime;
  readonly binaryPath: string;
  readonly approvedBuilds: readonly HostApprovedBubblewrapBuild[];
  readonly probeApproval: { readonly approvalId: string; readonly sha256: string };
  readonly getcapPath?: string;
}

/** Bind capture and resume verification to an immutable host-owned configuration. */
export function createSandboxAdmissionAdapter(
  options: CreateSandboxAdmissionAdapterOptions,
): SandboxAdmissionAdapter {
  if (options.hostProtection.primaryCheckout !== options.primaryCheckout) {
    throw new Error("sandbox host protection does not match its primary checkout");
  }
  const host = deepFreeze(structuredClone(options));
  const probeOptions = {
    binaryPath: host.binaryPath,
    approvedBuilds: host.approvedBuilds,
    bootstrapApproval: host.bootstrapApproval,
    probeApproval: host.probeApproval,
    runStateDir: host.runStateDir,
    ...(host.getcapPath === undefined ? {} : { getcapPath: host.getcapPath }),
  };
  const adapter: SandboxAdmissionAdapter = {
    capture: async (input) => {
      assertHostIdentity(input.runId, input.primaryCheckout, host);
      if (input.profile.execution === undefined) {
        throw new Error("sandbox admission requires explicit profile execution authority");
      }
      const policy = pinSandboxPolicy({
        execution: input.profile.execution,
        ...(input.profile.tool_execution === undefined
          ? {}
          : { toolExecution: input.profile.tool_execution }),
        selectedPaths: input.selectedPaths,
        trackedPaths: input.trackedPaths,
        ...(input.projectionRoots === undefined ? {} : { projectionRoots: input.projectionRoots }),
      });
      const admission = await captureSandboxAdmission({
        runId: host.runId,
        childId: input.childId,
        manifestRoot: host.manifestRoot,
        policy,
        hostProtection: host.hostProtection,
        bootstrapApproval: host.bootstrapApproval,
        runStateDir: host.runStateDir,
      });
      await runSandboxCapabilityProbe({ ...probeOptions, admission });
      return Object.freeze({ sandbox: admission.sandbox });
    },
    verify: async (input) => {
      const admission = await readSandboxAdmission({
        runStateDir: host.runStateDir,
        expectedRunId: host.runId,
        expectedChildId: input.childId,
        expectedSandbox: input.sandbox,
        bootstrapApproval: host.bootstrapApproval,
      });
      await runSandboxCapabilityProbe({ ...probeOptions, admission });
    },
  };
  return Object.freeze(adapter);
}

function assertHostIdentity(
  runId: string,
  primaryCheckout: string,
  host: Pick<CreateSandboxAdmissionAdapterOptions, "runId" | "primaryCheckout">,
): void {
  if (runId !== host.runId) throw new Error("sandbox admission run does not match its host");
  if (primaryCheckout !== host.primaryCheckout)
    throw new Error("sandbox admission checkout does not match its host");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
