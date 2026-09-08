/** SDK child prompt and report tool adapters. */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { reportResultArgsSchema } from "../../seam/schema.js";
import type { ReportCapture } from "./child-observation.js";
import { capChildText } from "./child-result.js";
import type { SpawnChildConfig } from "./delegate-tool.js";

export function childTaskSeed(config: SpawnChildConfig): string {
  if (config.profile.completion_protocol === "minimal")
    return "Begin the assigned task using only the available file tools.";
  return [
    `Task ID: ${config.taskId}`,
    `Worktree: ${config.worktreePath}`,
    "Begin the assigned task. Modify files in this worktree, then call report_result.",
  ].join("\n");
}

export function buildReportResultTool(capture: ReportCapture): ToolDefinition {
  return defineTool({
    name: "report_result",
    label: "report_result",
    description: "Report the child result and terminate this child session.",
    parameters: reportResultArgsSchema,
    async execute(_toolCallId, args: Static<typeof reportResultArgsSchema>) {
      if (capture.isClosed())
        return {
          content: [{ type: "text", text: "child session is closed" }],
          details: {},
          isError: true,
          terminate: true,
        };
      const capped = capChildText(args.summary);
      capture.capture(
        {
          status: args.status,
          summary: capped.text,
          ...(args.verification === undefined
            ? {}
            : { verification: args.verification.slice(0, 16).map((line) => line.slice(0, 256)) }),
        },
        capped.truncated,
      );
      return { content: [{ type: "text", text: "result recorded" }], details: {}, terminate: true };
    },
  });
}
