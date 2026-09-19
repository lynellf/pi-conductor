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
import { readRawControlArguments, sanitizeReportedHintsV2 } from "../../seam/control-arguments.js";
import { legacyReportResultArgsSchema, reportResultArgsSchema } from "../../seam/schema.js";
import type { ReportCapture } from "./child-observation.js";
import { capChildText } from "./child-result.js";
import type { SpawnChildConfig } from "./delegate-tool.js";

type ReportResultToolDetails = {
  readonly ok: boolean;
  readonly reason?: string;
};

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

export function buildReportResultTool(
  capture: ReportCapture,
  protocol: "v1" | "v2" = "v1",
): ToolDefinition {
  return defineTool({
    name: "report_result",
    label: "report_result",
    description:
      protocol === "v2"
        ? "Signal terminal intent to the conductor host. Optional fields are untrusted hints."
        : "Report the child result and terminate this child session.",
    parameters: protocol === "v2" ? reportResultArgsSchema : legacyReportResultArgsSchema,
    async execute(toolCallId, args: unknown) {
      const raw = readRawControlArguments(args);
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
          details: { ok: false, reason: raw.reason } as ReportResultToolDetails,
          isError: true,
          terminate: false,
        };
      }
      if (capture.isClosed())
        return {
          content: [{ type: "text", text: "child session is closed" }],
          details: { ok: false } as ReportResultToolDetails,
          isError: true,
          terminate: true,
        };
      if (protocol === "v2") {
        sanitizeReportedHintsV2(raw.value);
        capture.signalTerminalIntent(toolCallId, boundedReportedStatus(raw.value.status));
        return {
          content: [{ type: "text", text: "result recorded" }],
          details: { ok: true } as ReportResultToolDetails,
          terminate: true,
        };
      }
      const legacyArgs = raw.value as Static<typeof legacyReportResultArgsSchema>;
      const continuity = await captureContinuity(legacyArgs, capture);
      if (continuity.kind === "rejected") {
        return {
          content: [{ type: "text", text: continuity.message }],
          details: { ok: false } as ReportResultToolDetails,
          isError: true,
          terminate: true,
        };
      }
      const capped = capChildText(legacyArgs.summary);
      capture.capture(
        {
          status: legacyArgs.status,
          summary: capped.text,
          ...(legacyArgs.verification === undefined
            ? {}
            : {
                verification: legacyArgs.verification
                  .slice(0, 16)
                  .map((line) => line.slice(0, 256)),
              }),
        },
        capped.truncated,
        continuity.sibling,
      );
      return {
        content: [{ type: "text", text: "result recorded" }],
        details: { ok: true } as ReportResultToolDetails,
        terminate: true,
      };
    },
  }) as unknown as ToolDefinition;
}

function boundedReportedStatus(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || new TextEncoder().encode(trimmed).byteLength > 128) return undefined;
  return trimmed;
}

async function captureContinuity(
  args: Static<typeof legacyReportResultArgsSchema>,
  capture: ReportCapture,
): Promise<
  | { readonly kind: "ok"; readonly sibling: ChildContinuitySibling | null }
  | { readonly kind: "rejected"; readonly message: string }
> {
  const context = capture.continuityValidation();
  const isSuccessful = args.status === "completed" || args.status === "no_changes";
  if (args.continuity === undefined) {
    if (isSuccessful && context?.policy?.require_delegated_result === true) {
      capture.setProtocolDiagnostic("continuity_packet_required");
      return {
        kind: "rejected",
        message:
          "continuity_packet_required: continuity packet is required for a successful report_result",
      };
    }
    return { kind: "ok", sibling: null };
  }
  if (context === null)
    return { kind: "rejected", message: "continuity validation authority is unavailable" };
  const resolvedContext = await withResolvedEvidence(args.continuity, context);
  const result = tryValidateContinuityPacket(args.continuity, resolvedContext);
  if (result.kind === "rejected")
    return {
      kind: "rejected",
      message: `continuity packet rejected: ${result.diagnostics.map((item) => item.code).join(", ")}`,
    };
  const evidence_resolutions = continuityEvidenceResolutions(result.packet, resolvedContext);
  return {
    kind: "ok",
    sibling: {
      packet: result.packet,
      packet_utf8_bytes: result.bytes,
      evidence_resolutions: evidence_resolutions.map((resolution) => ({ ...resolution })),
    },
  };
}

async function withResolvedEvidence(
  packet: ContinuityPacketV1,
  context: NonNullable<ReturnType<ReportCapture["continuityValidation"]>>,
): Promise<NonNullable<ReturnType<ReportCapture["continuityValidation"]>>> {
  if (context.resolveEvidence === undefined && context.resolveEvidenceAsync === undefined)
    return context;
  const evidenceVerifiedByKey = new Map(context.evidenceVerifiedByKey);
  const collections = [
    ["findings", packet.findings],
    ["open_questions", packet.open_questions],
    ["next_steps", packet.next_steps],
  ] as const;
  for (const [collection, items] of collections)
    for (const item of items)
      for (const [index, ref] of item.evidence.entries()) {
        const key = evidenceRefKey(collection, item.id, index);
        const resolution =
          context.resolveEvidenceAsync === undefined
            ? context.resolveEvidence?.(key, ref)
            : await context.resolveEvidenceAsync(key, ref);
        evidenceVerifiedByKey.set(
          key,
          resolution ?? {
            ref_key: key,
            kind: ref.kind,
            status: "missing",
            diagnostic: "continuity_evidence_audience_denied",
          },
        );
      }
  return { ...context, evidenceVerifiedByKey };
}

function continuityEvidenceResolutions(
  packet: ContinuityPacketV1,
  context: NonNullable<ReturnType<ReportCapture["continuityValidation"]>>,
): readonly import("../../core/types.js").ContinuityEvidenceResolution[] {
  const refs: { key: string; kind: import("../../seam/continuity.js").EvidenceRef["kind"] }[] = [];
  const collect = (
    collection: "findings" | "open_questions" | "next_steps",
    items: readonly {
      readonly id: string;
      readonly evidence: readonly import("../../seam/continuity.js").EvidenceRef[];
    }[],
  ): void => {
    items.forEach((item) => {
      item.evidence.forEach((ref, index) => {
        refs.push({ key: evidenceRefKey(collection, item.id, index), kind: ref.kind });
      });
    });
  };
  collect("findings", packet.findings);
  collect("open_questions", packet.open_questions);
  collect("next_steps", packet.next_steps);
  return refs.map(({ key, kind }) => {
    const resolved = context.evidenceVerifiedByKey.get(key);
    if (resolved !== undefined) return { ...resolved };
    return {
      ref_key: key,
      kind,
      status: kind === "external" ? "declared" : "missing",
      diagnostic: kind === "external" ? "external_declared" : "continuity_evidence_audience_denied",
    };
  });
}
