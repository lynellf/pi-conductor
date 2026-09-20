/** Legacy child-admission command runner facade (#106 §7). */

import type { SandboxAdmissionRecord } from "../../../persistence/sandbox-admission.js";
import type { SandboxProjectMaterializationDescriptor } from "../../../persistence/sandbox-materialization.js";
import { readSandboxAdmission } from "./admission-store.js";
import type { SandboxCommandRunner } from "./command-runner-contract.js";
import { createVerifiedSandboxCommandRunner } from "./command-runner-core.js";
import type { HostApprovedBubblewrapBuild } from "./prerequisites.js";
import { verifySandboxProjectBase } from "./project-materialization.js";
import type { HostApprovedBootstrapRuntime } from "./runtime-types.js";

export type {
  SandboxCommandResult,
  SandboxCommandRunner,
} from "./command-runner-contract.js";
export { SandboxCommandRunnerError } from "./command-runner-core.js";

export interface CreateSandboxCommandRunnerOptions {
  readonly binaryPath: string;
  readonly approvedBuilds: readonly HostApprovedBubblewrapBuild[];
  readonly getcapPath?: string;
  readonly bootstrapApproval: HostApprovedBootstrapRuntime;
  readonly runStateDir: string;
  readonly admission: SandboxAdmissionRecord;
  readonly project: SandboxProjectMaterializationDescriptor;
  /** Passed as one Bash -c argument, never interpolated into bootstrap source. */
  readonly command: string;
  readonly previewBytes?: number;
  /** Hold after private spool creation; production callers omit this test seam. */
  readonly testHookAfterSpool?: () => Promise<void>;
}

/** Direct fixed-argv Bubblewrap runner used by manifest-pinned verification recipes. */
export type CreateSandboxArgvRunnerOptions = Omit<CreateSandboxCommandRunnerOptions, "command"> & {
  readonly argv: readonly [string, ...string[]];
};

/** Preserve the SDK child runner while sharing its verified process lifecycle. */
export function createSandboxCommandRunner(
  supplied: CreateSandboxCommandRunnerOptions,
): SandboxCommandRunner {
  if (supplied.command.includes("\0")) throw new TypeError("sandbox command must be NUL-free");
  const { testHookAfterSpool, ...cloneable } = supplied;
  const options = {
    ...structuredClone(cloneable),
    ...(testHookAfterSpool === undefined ? {} : { testHookAfterSpool }),
  };
  return createArgvSandboxCommandRunner({
    ...options,
    argv: ["/bin/bash", "--noprofile", "--norc", "-c", options.command],
  });
}

/** Build a verified runner from a literal argv without introducing a shell. */
export function createSandboxArgvRunner(
  supplied: CreateSandboxArgvRunnerOptions,
): SandboxCommandRunner {
  const { testHookAfterSpool, ...cloneable } = supplied;
  return createArgvSandboxCommandRunner({
    ...structuredClone(cloneable),
    argv: supplied.argv,
    ...(testHookAfterSpool === undefined ? {} : { testHookAfterSpool }),
  });
}

function createArgvSandboxCommandRunner(
  supplied: Omit<CreateSandboxCommandRunnerOptions, "command"> & {
    readonly argv: readonly [string, ...string[]];
    readonly testHookAfterSpool?: () => Promise<void>;
  },
): SandboxCommandRunner {
  const options = supplied;
  return createVerifiedSandboxCommandRunner({
    binaryPath: options.binaryPath,
    approvedBuilds: options.approvedBuilds,
    ...(options.getcapPath === undefined ? {} : { getcapPath: options.getcapPath }),
    runStateDir: options.runStateDir,
    argv: options.argv,
    ...(options.testHookAfterSpool === undefined
      ? {}
      : { testHookAfterSpool: options.testHookAfterSpool }),
    loadVerifiedContext: async () => {
      const admission = await readSandboxAdmission({
        runStateDir: options.runStateDir,
        expectedRunId: options.admission.runId,
        expectedChildId: options.admission.childId,
        expectedSandbox: options.admission.sandbox,
        bootstrapApproval: options.bootstrapApproval,
      });
      const project = await verifySandboxProjectBase(options.project, {
        admission,
        runStateDir: options.runStateDir,
        expectedRunId: admission.runId,
        expectedChildId: admission.childId,
      });
      return Object.freeze({
        runtime: admission.runtime,
        readonlyWorkspaceRoot: project.basePath,
        privateWritableRoot: project.writablePath,
        bootstrapPath: project.bootstrapPath,
        owner: { child_id: admission.childId, descriptor: admission.sandbox },
        writableMounts: admission.policy.writableRoots,
        environment: admission.policy.execution.environment,
        runId: admission.runId,
        outputCaps: {
          maxBytes: admission.policy.execution.max_output_bytes,
          ...(options.previewBytes === undefined ? {} : { previewBytes: options.previewBytes }),
        },
      });
    },
  });
}
