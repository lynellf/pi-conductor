/**
 * `report_result` tool factory (spec §7.2, issue #17 §7.2).
 *
 * Mirrors `createHandoffTool` in `src/host/tools.ts`. The tool:
 * - Validates args via `Value.Check(reportResultInputSchema, params)`
 * - On failure: returns a structured error result WITHOUT writing the capture
 * - On success: calls `onReport(...)` and returns `terminate: true`
 *
 * The tool is bound to a specific `(childId, attempt)`; the host MUST
 * construct one per child attempt and never reuse a closed attempt's tool.
 *
 * Defensive: never throws; all errors are returned as tool result errors.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import { reportResultInputSchema } from "../../seam/schema.js";

/** Captured report result written to the host's capture buffer. */
export interface ReportCapture {
  readonly childId: string;
  readonly attempt: number;
  readonly status: "completed" | "failed" | "no_changes";
  readonly summary: string;
  /** May be undefined when the report has no verification items. */
  readonly verification: readonly string[] | undefined;
}

export interface CreateReportResultToolArgs {
  readonly childId: string;
  readonly attempt: number;
  readonly onReport: (capture: ReportCapture) => void;
}

function textContent(text: string) {
  return { type: "text" as const, text };
}

/**
 * A tool definition for `report_result` bound to a specific child attempt.
 *
 * Returns a tool definition compatible with the `customTools` parameter of
 * `createAgentSession`. The tool's parameters match `reportResultInputSchema`.
 */
export function createReportResultTool(args: CreateReportResultToolArgs) {
  const { childId, attempt, onReport } = args;
  return defineTool({
    name: "report_result",
    label: "report_result",
    description: `Report the result of delegated task for child "${childId}" (attempt ${attempt}).`,
    parameters: reportResultInputSchema,
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      // Validate against the schema; return error without writing capture.
      if (!Value.Check(reportResultInputSchema, params)) {
        return {
          content: [textContent(`Invalid report_result arguments: ${JSON.stringify(params)}`)],
          details: {},
          terminate: false,
        };
      }

      const typed = params as {
        status: "completed" | "failed" | "no_changes";
        summary: string;
        verification?: readonly string[];
      };

      // Write the capture to the host's buffer.
      onReport({
        childId,
        attempt,
        status: typed.status,
        summary: typed.summary,
        verification: typed.verification,
      });

      return {
        content: [
          textContent(
            JSON.stringify({ child_id: childId, status: typed.status, summary: typed.summary }),
          ),
        ],
        details: {},
        terminate: true,
      };
    },
  });
}
