/** Fixed-argv sandbox runner for controller and adapter JSON operations (#115 §3). */

import type {
  SandboxCommandRunner,
  VerifiedSandboxCommandContext,
} from "../execution/sandbox/command-runner-contract.js";
import { createVerifiedSandboxCommandRunner } from "../execution/sandbox/command-runner-core.js";
import type { HostApprovedBubblewrapBuild } from "../execution/sandbox/prerequisites.js";
import type { ToolExecutionScope } from "../execution/tool-execution-contract.js";
import { CONTROLLER_JSON_MAX_BYTES, encodeBoundedControllerJson } from "./protocol-codec.js";

/** Protocol v1 hard ceiling for one UTF-8 JSON request. */
export const CONTROLLER_JSON_INPUT_MAX_BYTES = CONTROLLER_JSON_MAX_BYTES;

/** Fixed executable, request, sandbox authority, and host launcher inputs. */
export interface CreateControllerCommandRunnerOptions {
  readonly binaryPath: string;
  readonly approvedBuilds: readonly HostApprovedBubblewrapBuild[];
  readonly getcapPath?: string;
  readonly runStateDir: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly request: unknown;
  /** Must revalidate the pinned runtime and owner epoch immediately before the launch. */
  readonly loadVerifiedContext: (
    scope: ToolExecutionScope,
  ) => Promise<VerifiedSandboxCommandContext>;
  /** Hold after private spool creation; production callers omit this test seam. */
  readonly testHookAfterSpool?: () => Promise<void>;
}

/** Create one single-use controller runner without shell expansion or SDK child admission. */
export function createControllerCommandRunner(
  options: CreateControllerCommandRunnerOptions,
): SandboxCommandRunner {
  const stdin = encodeBoundedControllerJson(options.request);
  return createVerifiedSandboxCommandRunner({
    binaryPath: options.binaryPath,
    approvedBuilds: options.approvedBuilds,
    ...(options.getcapPath === undefined ? {} : { getcapPath: options.getcapPath }),
    runStateDir: options.runStateDir,
    loadVerifiedContext: options.loadVerifiedContext,
    argv: [options.executable, ...options.argv],
    stdin,
    ...(options.testHookAfterSpool === undefined
      ? {}
      : { testHookAfterSpool: options.testHookAfterSpool }),
  });
}
