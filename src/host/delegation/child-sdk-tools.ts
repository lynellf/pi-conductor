/** SDK child prompt and report tool adapters. */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import {
  type ChildContinuitySibling,
  evidenceRefKey,
  tryValidateContinuityPacket,
} from "../../persistence/continuity.js";
import type { ContinuityPacketV1 } from "../../seam/continuity.js";
import { reportResultArgsSchema } from "../../seam/schema.js";
import type { ReportCapture } from "./child-observation.js";
import { capChildText } from "./child-result.js";
import type { SpawnChildConfig } from "./delegate-tool.js";

export function childTaskSeed(config: SpawnChildConfig): string {
  const workspace = config.sandbox === undefined ? config.worktreePath : "/workspace";
  if (config.profile.completion_protocol === "minimal")
    return config.sandbox === undefined
      ? "Begin the assigned task using only the available file tools."
      : "Begin the assigned task in /workspace using the available file and command tools.";
  return [
    `Task ID: ${config.taskId}`,
    `Worktree: ${workspace}`,
    `Begin the assigned task. Modify files in ${workspace}, then call report_result.`,
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
      const continuity = captureContinuity(args, capture);
      if (continuity.kind === "rejected") {
        return {
          content: [{ type: "text", text: continuity.message }],
          details: {},
          isError: true,
          terminate: true,
        };
      }
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
        continuity.sibling,
      );
      return { content: [{ type: "text", text: "result recorded" }], details: {}, terminate: true };
    },
  });
}

function captureContinuity(
  args: Static<typeof reportResultArgsSchema>,
  capture: ReportCapture,
):
  | { readonly kind: "ok"; readonly sibling: ChildContinuitySibling | null }
  | { readonly kind: "rejected"; readonly message: string } {
  const context = capture.continuityValidation();
  const isSuccessful = args.status === "completed" || args.status === "no_changes";
  if (args.continuity === undefined) {
    if (isSuccessful && context?.policy?.require_delegated_result === true)
      return {
        kind: "rejected",
        message: "continuity packet is required for a successful report_result",
      };
    return { kind: "ok", sibling: null };
  }
  if (context === null)
    return { kind: "rejected", message: "continuity validation authority is unavailable" };
  const result = tryValidateContinuityPacket(args.continuity, context);
  if (result.kind === "rejected")
    return {
      kind: "rejected",
      message: `continuity packet rejected: ${result.diagnostics.map((item) => item.code).join(", ")}`,
    };
  const keys = continuityEvidenceKeys(result.packet);
  const evidence_resolutions = [...context.evidenceVerifiedByKey.values()].filter((resolution) =>
    keys.has(resolution.ref_key),
  );
  return {
    kind: "ok",
    sibling: {
      packet: result.packet,
      packet_utf8_bytes: result.bytes,
      evidence_resolutions: evidence_resolutions.map((resolution) => ({ ...resolution })),
    },
  };
}

function continuityEvidenceKeys(packet: ContinuityPacketV1): ReadonlySet<string> {
  const keys = new Set<string>();
  packet.findings.forEach((item) => {
    item.evidence.forEach((_ref, index) => {
      keys.add(evidenceRefKey("findings", item.id, index));
    });
  });
  packet.open_questions.forEach((item) => {
    item.evidence.forEach((_ref, index) => {
      keys.add(evidenceRefKey("open_questions", item.id, index));
    });
  });
  packet.next_steps.forEach((item) => {
    item.evidence.forEach((_ref, index) => {
      keys.add(evidenceRefKey("next_steps", item.id, index));
    });
  });
  return keys;
}
