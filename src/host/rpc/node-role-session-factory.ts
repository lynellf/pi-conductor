/** Construct a Node RPC role session with the host-owned Pi command line. */

import { MACHINE_TOOLS_CONFIG_ENV } from "./machine-tools-config.js";
import {
  resolveMachineToolsExtensionPath,
  resolvePackageLocalPiCli,
  spawnPackageLocalPi,
} from "./node-role-process.js";
import { NodeRoleSession } from "./node-role-session.js";
import type { NodeRoleSessionOptions, RpcSpawnOptions } from "./protocol.js";
import { RpcChildProcessError } from "./protocol.js";

/** Build and initialize a RoleSession backed by a distinct `pi --mode rpc` process. */
export async function createNodeRoleSession(
  options: NodeRoleSessionOptions,
): Promise<NodeRoleSession> {
  if (options.machineToolsConfigPath.trim().length === 0) {
    throw new RpcChildProcessError("RPC role process requires a machine-tools configuration path");
  }
  const spawnOptions: RpcSpawnOptions = {
    command: process.execPath,
    args: [
      resolvePackageLocalPiCli(),
      "--mode",
      "rpc",
      "--no-extensions",
      "--no-builtin-tools",
      "--extension",
      resolveMachineToolsExtensionPath(),
      ...(options.model === null ? [] : ["--model", toPiModelArgument(options.model)]),
      "--thinking",
      options.effort,
      ...(options.systemPrompt === null ? [] : ["--system-prompt", options.systemPrompt]),
      "--session-dir",
      options.sessionDir,
    ],
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
      PI_CODING_AGENT_DIR: options.agentDir,
      [MACHINE_TOOLS_CONFIG_ENV]: options.machineToolsConfigPath,
    },
  };
  const child = options.spawn?.(spawnOptions) ?? spawnPackageLocalPi(spawnOptions);
  const session = new NodeRoleSession(options, child);
  try {
    await session.initialize();
    return session;
  } catch (error) {
    session.terminate();
    throw error;
  }
}

function toPiModelArgument(model: string): string {
  const separator = model.indexOf(":");
  if (separator <= 0 || separator === model.length - 1) {
    throw new RpcChildProcessError(`RPC role model '${model}' must use provider:id format`);
  }
  return `${model.slice(0, separator)}/${model.slice(separator + 1)}`;
}
