/** Shared verified-context sandbox command contracts (#106 §7, #115 §3). */

import type { AnySandboxExecutionOwner } from "../../../persistence/sandbox-execution.js";
import type { SandboxOutputFinalRecord } from "../../../persistence/sandbox-output.js";
import type { ToolExecutionScope } from "../tool-execution-contract.js";
import type { SandboxToolExecutionAdapter } from "../tool-execution-lifecycle.js";
import type { SandboxWritableMount } from "./mount-plan.js";
import type { SandboxOutputPreviews } from "./output-spool.js";
import type { HostApprovedBubblewrapBuild } from "./prerequisites.js";
import type { PreparedRuntimeDescriptor } from "./runtime-types.js";

/** Ordinary command completion, including nonzero status. */
export interface SandboxCommandResult {
  readonly executionId: string;
  readonly normalizedStatus: number;
  readonly signal: "unknown";
  readonly output: SandboxOutputFinalRecord;
  readonly previews: SandboxOutputPreviews;
}

/** Fully verified launch inputs returned by a trusted host boundary immediately before spawn. */
export interface VerifiedSandboxCommandContext {
  readonly runtime: PreparedRuntimeDescriptor;
  readonly readonlyWorkspaceRoot: string;
  readonly privateWritableRoot: string;
  readonly bootstrapPath: string;
  readonly owner: AnySandboxExecutionOwner;
  readonly writableMounts: readonly SandboxWritableMount[];
  readonly environment: Readonly<Record<string, string>>;
  readonly runId: string;
  readonly outputCaps: Readonly<{ maxBytes: number; previewBytes?: number }>;
}

/** Shared verified-context runner inputs for child and controller executables. */
export interface CreateVerifiedSandboxCommandRunnerOptions {
  readonly binaryPath: string;
  readonly approvedBuilds: readonly HostApprovedBubblewrapBuild[];
  readonly getcapPath?: string;
  readonly runStateDir: string;
  /** Revalidates all runtime, workspace, owner, and mount authority before this spawn. */
  readonly loadVerifiedContext: (
    scope: ToolExecutionScope,
  ) => Promise<VerifiedSandboxCommandContext>;
  /** Fixed executable and literal argv passed through the trusted bootstrap. */
  readonly argv: readonly [string, ...string[]];
  /** Optional bytes delivered on FD 0; the runner starts the write without blocking release. */
  readonly stdin?: Buffer;
  /** Hold after private spool creation; production callers omit this test seam. */
  readonly testHookAfterSpool?: () => Promise<void>;
}

/** Shared sandbox lifecycle adapter returned to the execution controller. */
export type SandboxCommandRunner = SandboxToolExecutionAdapter<SandboxCommandResult>;
