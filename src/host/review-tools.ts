/** Host-owned terminal tools for reviewer decisions (issue #124). */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { readRawControlArguments } from "../seam/control-arguments.js";
import {
  approveArgsSchema,
  type ReviewDecision,
  requestChangesArgsSchema,
} from "../seam/review.js";
import type { SessionSeam } from "./seam.js";

/** Structured reviewer-tool outcome retained for tests and host diagnostics. */
export type ReviewToolDetails =
  | { readonly ok: true; readonly decision: ReviewDecision }
  | {
      readonly ok: false;
      readonly reason: "schema_invalid" | "extra_decision" | "host_terminated" | "aborted";
    };

interface ReviewToolOptions {
  readonly seam: SessionSeam | (() => SessionSeam);
  readonly toolName: ReviewDecision;
  readonly shouldRejectCapture?: () => boolean;
}

/** Build the host-captured `approve` terminal tool. */
export function createApproveTool(
  seam: SessionSeam | (() => SessionSeam),
  shouldRejectCapture?: () => boolean,
): ToolDefinition {
  return createReviewTool({
    seam,
    toolName: "approve",
    ...(shouldRejectCapture === undefined ? {} : { shouldRejectCapture }),
  });
}

/** Build the host-captured `request_changes` terminal tool. */
export function createRequestChangesTool(
  seam: SessionSeam | (() => SessionSeam),
  shouldRejectCapture?: () => boolean,
): ToolDefinition {
  return createReviewTool({
    seam,
    toolName: "request_changes",
    ...(shouldRejectCapture === undefined ? {} : { shouldRejectCapture }),
  });
}

function createReviewTool(options: ReviewToolOptions): ToolDefinition {
  const activeSeam = (): SessionSeam =>
    typeof options.seam === "function" ? options.seam() : options.seam;
  const schema = options.toolName === "approve" ? approveArgsSchema : requestChangesArgsSchema;
  return defineTool({
    name: options.toolName,
    label: options.toolName,
    description:
      options.toolName === "approve"
        ? "Approve the host-pinned review gate with a concise reason. This is terminal."
        : "Request changes from the phase owner with a concise reason. This is terminal.",
    parameters: schema,
    execute: async (_toolCallId, params, signal) => {
      if (options.shouldRejectCapture?.() === true) {
        return result("host_terminated", false);
      }
      if (signal?.aborted === true) return result("aborted", false);
      const raw = readRawControlArguments(params);
      if (raw.kind === "rejected" || !Value.Check(schema, raw.value)) {
        return result("schema_invalid", true);
      }
      const seam = activeSeam();
      if (seam.readReviewDecisions().length > 0) {
        seam.pushReviewDecision({ toolName: options.toolName, args: raw.value });
        return result("extra_decision", true);
      }
      seam.pushReviewDecision({ toolName: options.toolName, args: raw.value });
      seam.seal();
      return {
        content: [
          {
            type: "text" as const,
            text: `${options.toolName} recorded. Do not call further tools; the conductor will route the review outcome.`,
          },
        ],
        details: { ok: true, decision: options.toolName } satisfies ReviewToolDetails,
        terminate: true,
      };
    },
  });
}

function result(
  reason: Exclude<ReviewToolDetails, { readonly ok: true }>["reason"],
  terminate: boolean,
): {
  readonly content: { readonly type: "text"; readonly text: string }[];
  readonly details: ReviewToolDetails;
  readonly terminate: boolean;
} {
  return {
    content: [
      {
        type: "text",
        text:
          reason === "extra_decision"
            ? "extra review decision: emit exactly one terminal reviewer decision."
            : reason === "schema_invalid"
              ? "schema-invalid reviewer decision: provide one bounded non-empty reason."
              : `review decision unavailable: ${reason}.`,
      },
    ],
    details: { ok: false, reason },
    terminate,
  };
}
