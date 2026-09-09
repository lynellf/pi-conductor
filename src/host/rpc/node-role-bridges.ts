import { realpathSync } from "node:fs";

import { DelegateBridgeHost } from "./delegate-bridge.js";
import { ExecutionBridgeHost } from "./execution-bridge.js";
import { loadMachineToolsConfig, MACHINE_TOOLS_CONFIG_ENV } from "./machine-tools-config.js";
import type { NodeRoleSessionOptions } from "./protocol.js";
import { RpcChildProcessError } from "./protocol.js";

/** Create the validated execution bridge owned by one RPC role session. */
export function createExecutionBridge(options: NodeRoleSessionOptions): ExecutionBridgeHost {
  const bridge = options.executionBridge;
  if (bridge === undefined || bridge.tools.length === 0) {
    throw new RpcChildProcessError("RPC execution bridge requires host tool definitions");
  }
  try {
    const config = loadMachineToolsConfig({
      [MACHINE_TOOLS_CONFIG_ENV]: options.machineToolsConfigPath,
    });
    if (
      config.executionBridge === undefined ||
      realpathSync(bridge.directory) !== config.executionBridge.directory
    ) {
      throw new RpcChildProcessError(
        "RPC execution bridge directory does not match the machine-tools configuration",
      );
    }
    const declared = new Set(config.declaredToolNames);
    if (bridge.tools.some((tool) => !declared.has(tool.name))) {
      throw new RpcChildProcessError("RPC execution bridge tool is not declared for this role");
    }
    return new ExecutionBridgeHost(bridge);
  } catch (error) {
    if (error instanceof RpcChildProcessError) throw error;
    throw new RpcChildProcessError(
      `RPC execution bridge configuration is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Create the validated delegation/request-files bridge owned by one RPC role. */
export function createDelegateBridge(options: NodeRoleSessionOptions): DelegateBridgeHost {
  const delegateBridge = options.delegateBridge;
  const requestFilesBridge = options.requestFilesBridge;
  if (delegateBridge === undefined && requestFilesBridge === undefined) {
    throw new RpcChildProcessError("RPC machine tool bridge options are missing");
  }
  try {
    const config = loadMachineToolsConfig({
      [MACHINE_TOOLS_CONFIG_ENV]: options.machineToolsConfigPath,
    });
    if (delegateBridge !== undefined) {
      if (config.delegateBridge === undefined || !config.declaredToolNames.includes("delegate")) {
        throw new RpcChildProcessError(
          "RPC delegate bridge requires a delegate-enabled machine-tools configuration",
        );
      }
      if (realpathSync(delegateBridge.directory) !== config.delegateBridge.directory) {
        throw new RpcChildProcessError(
          "RPC delegate bridge directory does not match the machine-tools configuration",
        );
      }
    }
    if (requestFilesBridge !== undefined) {
      if (
        config.requestFilesBridge === undefined ||
        !config.declaredToolNames.includes("request_files")
      ) {
        throw new RpcChildProcessError(
          "RPC request_files bridge requires a request_files-enabled machine-tools configuration",
        );
      }
      if (realpathSync(requestFilesBridge.directory) !== config.requestFilesBridge.directory) {
        throw new RpcChildProcessError(
          "RPC request_files bridge directory does not match the machine-tools configuration",
        );
      }
    }
    const directory = delegateBridge?.directory ?? requestFilesBridge?.directory;
    if (directory === undefined) {
      throw new RpcChildProcessError("RPC machine tool bridge directory is missing");
    }
    if (
      delegateBridge !== undefined &&
      requestFilesBridge !== undefined &&
      realpathSync(delegateBridge.directory) !== realpathSync(requestFilesBridge.directory)
    ) {
      throw new RpcChildProcessError("RPC machine tool bridge handlers must share one directory");
    }
    return new DelegateBridgeHost({
      sessionDir: options.sessionDir,
      directory,
      ...(delegateBridge === undefined ? {} : { delegate: delegateBridge.delegate }),
      ...(requestFilesBridge === undefined
        ? {}
        : { requestFiles: requestFilesBridge.requestFiles }),
    });
  } catch (error) {
    if (error instanceof RpcChildProcessError) throw error;
    throw new RpcChildProcessError(
      `RPC machine tool bridge configuration is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
