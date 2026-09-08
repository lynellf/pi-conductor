/**
 * Static RPC role extension — Issue #48 remediation Process adapter.
 *
 * The host writes the projection config and the RPC adapter loads this extension
 * explicitly with discovered extensions and built-in tools disabled. This module
 * only supplies the restricted tool surface; it never owns run transitions or I/O.
 */

import {
  defineTool,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { delegateModeDescription } from "../../manifest/delegation-mode.js";

import {
  type DelegateArgs,
  delegateArgsSchema,
  delegateArgsSchemaForMode,
  endArgsSchema,
  handoffArgsSchema,
  type RequestFilesArgs,
  requestFilesArgsSchema,
} from "../../seam/schema.js";
import { buildConfinedTools } from "../workspace/confine-tools.js";
import { requestDelegateBridge, requestFilesBridge } from "./delegate-bridge.js";
import { requestExecutionBridge } from "./execution-bridge.js";
import { loadMachineToolsConfig, type MachineToolsConfig } from "./machine-tools-config.js";

/** Register the static, config-gated tool surface for one isolated RPC role process. */
export default function machineToolsExtension(pi: ExtensionAPI): void {
  const config = loadMachineToolsConfig();
  pi.registerTool(createTerminatingMachineTool("handoff", "Handoff", handoffArgsSchema));
  pi.registerTool(createTerminatingMachineTool("end", "End", endArgsSchema));

  const confined = buildConfinedTools(
    { workspaceRoot: config.workspaceRoot, mounts: config.mounts },
    config.declaredToolNames,
  );
  for (const tool of confined.tools) {
    if (config.executionBridge !== undefined && isExecutionTool(tool.name)) {
      pi.registerTool(
        createExecutionBridgeTool(
          tool,
          config.executionBridge.directory,
          config.executionBridge.timeout_ms,
        ),
      );
    } else {
      pi.registerTool(tool);
    }
  }
  if (config.delegateBridge !== undefined && config.declaredToolNames.includes("delegate")) {
    pi.registerTool(
      createDelegateBridgeTool(
        config.delegateBridge.directory,
        config.delegationMode,
        config.legacyDelegationMode,
      ),
    );
  }
  if (
    config.requestFilesBridge !== undefined &&
    config.declaredToolNames.includes("request_files")
  ) {
    pi.registerTool(createRequestFilesBridgeTool(config.requestFilesBridge.directory));
  }
}

function isExecutionTool(name: string): name is "read" | "grep" | "find" | "ls" | "edit" | "write" {
  return ["read", "grep", "find", "ls", "edit", "write"].includes(name);
}

function createExecutionBridgeTool(
  tool: ToolDefinition,
  directory: string,
  timeoutMs: number,
): ToolDefinition {
  return {
    ...tool,
    execute: async (toolCallId, params, signal, _onUpdate, ctx) =>
      (await requestExecutionBridge({
        directory,
        actualToolCallId: toolCallId,
        toolName: tool.name as "read" | "grep" | "find" | "ls" | "edit" | "write",
        params,
        ...(ctx.model?.input === undefined ? {} : { modelInput: { input: [...ctx.model.input] } }),
        ...(signal === undefined ? {} : { signal }),
        timeoutMs,
      })) as Awaited<ReturnType<ToolDefinition["execute"]>>,
  };
}

function createDelegateBridgeTool(
  directory: string,
  configuredMode: MachineToolsConfig["delegationMode"],
  legacyDelegationMode: MachineToolsConfig["legacyDelegationMode"],
): ToolDefinition {
  const effectiveMode = legacyDelegationMode === true ? undefined : configuredMode;
  return defineTool({
    name: "delegate",
    label: "delegate",
    description:
      effectiveMode === undefined
        ? "Request bounded delegated work from the conductor host."
        : `Request bounded delegated work from the conductor host. ${delegateModeDescription(effectiveMode)}`,
    parameters:
      effectiveMode === undefined ? delegateArgsSchema : delegateArgsSchemaForMode(effectiveMode),
    async execute(toolCallId, args: DelegateArgs, signal) {
      try {
        return await requestDelegateBridge({
          directory,
          args,
          actualToolCallId: toolCallId,
          ...(configuredMode === undefined ? {} : { configuredMode }),
          ...(legacyDelegationMode === undefined ? {} : { legacyDelegationMode }),
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `delegate unavailable: ${error instanceof Error ? error.message : "bridge failure"}`,
            },
          ],
          details: {},
          isError: true,
          terminate: false,
        };
      }
    },
  });
}

function createRequestFilesBridgeTool(directory: string): ToolDefinition {
  return defineTool({
    name: "request_files",
    label: "request_files",
    description: "Request explicitly named files from the conductor's pinned projection.",
    parameters: requestFilesArgsSchema,
    async execute(_toolCallId, args: RequestFilesArgs, signal, _onUpdate, ctx) {
      try {
        const result = await requestFilesBridge({
          directory,
          args,
          ...(signal === undefined ? {} : { signal }),
        });
        if (result.terminate === true) ctx.shutdown();
        return result;
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `request_files unavailable: ${error instanceof Error ? error.message : "bridge failure"}`,
            },
          ],
          details: { outcome: "unavailable", code: "bridge-unavailable" },
          isError: true,
          terminate: false,
        };
      }
    },
  });
}

function createTerminatingMachineTool(
  name: "handoff" | "end",
  label: string,
  parameters: TSchema,
): ToolDefinition {
  return defineTool({
    name,
    label,
    description:
      name === "handoff"
        ? "Record a machine handoff and terminate this role session."
        : "Record run completion and terminate this role session.",
    parameters,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      // RPC mode performs the requested shutdown after this tool execution ends.
      // The adapter sends its final statistics command at that boundary, which
      // makes the shutdown observable and drops the child's native guidance queues.
      ctx.shutdown();
      return {
        content: [
          {
            type: "text" as const,
            text: `${name} recorded. Do not call further tools; the conductor will end this session.`,
          },
        ],
        details: {},
        terminate: true,
      };
    },
  });
}
