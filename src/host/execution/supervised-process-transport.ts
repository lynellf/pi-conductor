/** Platform-specific spawn transport; lifecycle and cleanup remain supervisor-owned (#165). */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { spawnMacLeader } from "./macos/command-transport.js";
import type { SupervisedProcessOptions } from "./supervised-process-contract.js";

/** Spawn the historical Linux workload directly or the Darwin admission-gated leader. */
export function spawnSupervisedChild(
  options: SupervisedProcessOptions,
): ChildProcessWithoutNullStreams {
  if (process.platform === "darwin") return spawnMacLeader(options);
  const shared = {
    cwd: options.cwd,
    env: {
      ...(options.inheritEnv === false ? {} : process.env),
      ...options.env,
      PI_CONDUCTOR_EXECUTION_ID: options.executionId,
    },
    detached: true,
    stdio: "pipe" as const,
  };
  return options.file
    ? spawn(options.file, options.args ?? [], { ...shared, shell: false })
    : spawn(options.command ?? "", { ...shared, shell: true });
}
