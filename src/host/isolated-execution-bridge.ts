/** Isolated role bridge adapters shared by either execution tier (§3). */
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExecutionBridgeToolDefinition } from "./rpc/execution-bridge.js";

/** Bound RPC waiting to the existing finite tool and cleanup budgets. */
export function boundedBridgeTimeout(timeoutSeconds: number, graceSeconds: number): number {
  const milliseconds = timeoutSeconds * 1_000 + graceSeconds * 2_000 + 5_000;
  return Math.min(2_147_483_647, Math.max(1, Math.floor(milliseconds)));
}

/** Preserve the public SDK context seam for a host-owned file tool. */
export function toExecutionBridgeTool(tool: ToolDefinition): ExecutionBridgeToolDefinition {
  return {
    name: tool.name as ExecutionBridgeToolDefinition["name"],
    parameters: tool.parameters,
    execute: (toolCallId, params, signal, modelInput) =>
      tool.execute(toolCallId, params as never, signal, undefined, {
        model:
          typeof modelInput === "object" &&
          modelInput !== null &&
          "input" in modelInput &&
          Array.isArray(modelInput.input)
            ? { input: modelInput.input }
            : undefined,
      } as unknown as ExtensionContext),
  };
}
