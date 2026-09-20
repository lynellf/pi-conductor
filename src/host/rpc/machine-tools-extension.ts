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
import { readRawControlArguments } from "../../seam/control-arguments.js";
import { approveArgsSchema, requestChangesArgsSchema } from "../../seam/review.js";

import {
  type DelegateArgs,
  type DelegateTaskArgs,
  type DelegationControlArgs,
  delegateArgsSchema,
  delegateArgsSchemaForMode,
  delegateTaskArgsSchema,
  delegationControlArgsSchema,
  endArgsSchema,
  endArgsSchemaV2,
  handoffArgsSchema,
  orchestratorHandoffArgsSchema,
  type RequestFilesArgs,
  requestFilesArgsSchema,
  workerHandoffArgsSchema,
} from "../../seam/schema.js";
import { buildConfinedTools } from "../workspace/confine-tools.js";
import {
  requestDelegateBridge,
  requestDelegateTaskBridge,
  requestDelegationControlBridge,
  requestFilesBridge,
} from "./delegate-bridge.js";
import { requestExecutionBridge } from "./execution-bridge.js";
import { loadMachineToolsConfig, type MachineToolsConfig } from "./machine-tools-config.js";

/** Register the static, config-gated tool surface for one isolated RPC role process. */
export default function machineToolsExtension(pi: ExtensionAPI): void {
  const config = loadMachineToolsConfig();
  const v2 = config.controlProtocol === "v2";
  const orchestrator =
    config.role !== undefined &&
    config.orchestratorRole !== undefined &&
    config.role === config.orchestratorRole;
  const handoffSchema = v2
    ? orchestrator
      ? orchestratorHandoffArgsSchema
      : workerHandoffArgsSchema
    : handoffArgsSchema;
  if (config.reviewGate === undefined) {
    pi.registerTool(createTerminatingMachineTool("handoff", "Handoff", handoffSchema));
    pi.registerTool(
      createTerminatingMachineTool("end", "End", v2 ? endArgsSchemaV2 : endArgsSchema),
    );
  } else {
    pi.registerTool(createTerminatingReviewTool("approve", approveArgsSchema));
    pi.registerTool(createTerminatingReviewTool("request_changes", requestChangesArgsSchema));
  }

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
  if (config.delegateBridge !== undefined) {
    assertDelegationToolConfiguration(config);
    if (config.delegationInterface === "assignments_v1") {
      pi.registerTool(
        createDelegateTaskBridgeTool(config.delegateBridge.directory, config.delegationMode),
      );
      pi.registerTool(createDelegationControlBridgeTool(config.delegateBridge.directory));
    } else if (config.declaredToolNames.includes("delegate")) {
      pi.registerTool(
        createDelegateBridgeTool(
          config.delegateBridge.directory,
          config.delegationMode,
          config.legacyDelegationMode,
        ),
      );
    }
  }
  if (
    config.requestFilesBridge !== undefined &&
    config.declaredToolNames.includes("request_files")
  ) {
    pi.registerTool(createRequestFilesBridgeTool(config.requestFilesBridge.directory));
  }
}

function assertDelegationToolConfiguration(config: MachineToolsConfig): void {
  const hasLegacyTool = config.declaredToolNames.includes("delegate");
  const hasTaskTool = config.declaredToolNames.includes("delegate_task");
  const hasControlTool = config.declaredToolNames.includes("delegation_control");

  if (config.delegationInterface === "assignments_v1") {
    if (!hasTaskTool || !hasControlTool || hasLegacyTool || config.legacyDelegationMode === true) {
      throw new Error(
        "invalid assignments_v1 machine-tools configuration: expected delegate_task and delegation_control only",
      );
    }
    return;
  }

  if (hasTaskTool || hasControlTool) {
    throw new Error(
      "invalid legacy machine-tools configuration: assignment delegation tools require assignments_v1",
    );
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

function createDelegateTaskBridgeTool(
  directory: string,
  configuredMode: MachineToolsConfig["delegationMode"],
): ToolDefinition {
  return defineTool({
    name: "delegate_task",
    label: "delegate_task",
    description:
      configuredMode === undefined
        ? "Request one manifest-defined delegated task from the conductor host."
        : `Request one manifest-defined delegated task from the conductor host. ${delegateModeDescription(configuredMode)}`,
    parameters: delegateTaskArgsSchema,
    async execute(toolCallId, args: DelegateTaskArgs, signal) {
      try {
        return await requestDelegateTaskBridge({
          directory,
          args,
          actualToolCallId: toolCallId,
          ...(configuredMode === undefined ? {} : { configuredMode }),
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `delegate_task unavailable: ${error instanceof Error ? error.message : "bridge failure"}`,
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

function createDelegationControlBridgeTool(directory: string): ToolDefinition {
  return defineTool({
    name: "delegation_control",
    label: "delegation_control",
    description: "Inspect, await, or cancel accepted delegated child handles.",
    parameters: delegationControlArgsSchema,
    async execute(_toolCallId, args: DelegationControlArgs, signal) {
      try {
        return await requestDelegationControlBridge({
          directory,
          args,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `delegation_control unavailable: ${error instanceof Error ? error.message : "bridge failure"}`,
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
        if (
          result.terminate === true &&
          process.env.PI_CONDUCTOR_CONTEXT_CHILD_CONFIG === undefined
        ) {
          ctx.shutdown();
        }
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

function createTerminatingReviewTool(
  name: "approve" | "request_changes",
  parameters: TSchema,
): ToolDefinition {
  return defineTool({
    name,
    label: name,
    description:
      name === "approve"
        ? "Approve the pinned review gate with one bounded reason."
        : "Request changes from the phase owner with one bounded reason.",
    parameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const raw = readRawControlArguments(params);
      if (raw.kind === "rejected") {
        return {
          content: [
            {
              type: "text" as const,
              text: "review decision arguments were not exactly representable or were too large",
            },
          ],
          details: { ok: false, reason: "schema_invalid" },
          terminate: true,
        };
      }
      if (process.env.PI_CONDUCTOR_CONTEXT_CHILD_CONFIG === undefined) ctx.shutdown();
      return {
        content: [
          {
            type: "text" as const,
            text: `${name} recorded. Do not call further tools; the conductor will route the review outcome.`,
          },
        ],
        details: {},
        terminate: true,
      };
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
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const raw = readRawControlArguments(params);
      if (raw.kind === "rejected") {
        return {
          content: [
            {
              type: "text" as const,
              text:
                raw.reason === "tool_arguments_too_large"
                  ? "tool arguments exceed the 65536-byte UTF-8 transport limit"
                  : "tool arguments are not exactly JSON-representable",
            },
          ],
          details: { ok: false, reason: raw.reason },
          terminate: false,
        };
      }
      // RPC mode performs the requested shutdown after this tool execution ends.
      // The adapter sends its final statistics command at that boundary, which
      // makes the shutdown observable and drops the child's native guidance queues.
      // Context-retention children must finish their host ACK in the prompt
      // wrapper before the RPC process exits; ordinary RPC roles retain the
      // existing immediate shutdown behavior.
      if (process.env.PI_CONDUCTOR_CONTEXT_CHILD_CONFIG === undefined) ctx.shutdown();
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
