/**
 * Bounded predecessor-session reader for issue #14.
 *
 * The tool deliberately accepts an empty object: the host closes over the
 * trusted `HandoffContextRef`, so a recipient cannot select an arbitrary run,
 * role, or session file. Context is opt-in and bounded; it is never injected
 * into the recipient's initial prompt automatically.
 */

import { defineTool, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { HandoffContextRef } from "../core/types.js";

const MAX_CONTEXT_CHARS = 10_000;

/** Empty parameter schema for the predecessor-only tool. */
export const handoffContextArgsSchema = Type.Object({}, { additionalProperties: false });

/** Structured details returned by `handoff_context`. */
export interface HandoffContextToolDetails {
  readonly status: "available" | "unavailable";
  readonly context_ref: HandoffContextRef;
  readonly truncated?: boolean;
}

/**
 * Create a read-only tool bound to one host-selected predecessor session.
 * Uses the SDK's `SessionManager.open().buildSessionContext()` path so branch
 * selection and compaction semantics match pi's own context construction.
 */
export function createHandoffContextTool(ref: HandoffContextRef): ToolDefinition {
  // The SDK erases the concrete parameter/details types when custom tools
  // share one heterogeneous array; this is the same boundary cast used by
  // the ask_user factory.
  return defineTool<typeof handoffContextArgsSchema, HandoffContextToolDetails>({
    name: "handoff_context",
    label: "Read handoff context",
    description:
      "Read a bounded view of the immediately preceding role session selected by the conductor. No session path can be supplied.",
    promptSnippet: "read bounded context from the immediately preceding handoff session",
    promptGuidelines: [
      "Use handoff_context only when the handoff summary is insufficient; it reads the trusted predecessor session only.",
      "The returned context is bounded and may be truncated.",
    ],
    parameters: handoffContextArgsSchema,
    execute: async () => {
      try {
        const source = SessionManager.open(ref.source_session_file);
        const serialized = JSON.stringify(source.buildSessionContext().messages, null, 2);
        const truncated = serialized.length > MAX_CONTEXT_CHARS;
        const bounded = truncated
          ? `${serialized.slice(0, MAX_CONTEXT_CHARS)}\n...[handoff context truncated]`
          : serialized;
        return {
          content: [
            {
              type: "text" as const,
              text: [
                "[handoff context]",
                "context_ref:",
                `  run_id: ${ref.run_id}`,
                `  source_role: ${ref.source_role}`,
                `  source_session_file: ${ref.source_session_file}`,
                "messages:",
                bounded,
              ].join("\n"),
            },
          ],
          details: {
            status: "available",
            context_ref: ref,
            ...(truncated && { truncated: true }),
          } satisfies HandoffContextToolDetails,
          terminate: false,
        };
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                "[handoff context unavailable]",
                "No readable source session exists for this handoff.",
              ].join("\n"),
            },
          ],
          details: {
            status: "unavailable",
            context_ref: ref,
          } satisfies HandoffContextToolDetails,
          terminate: false,
        };
      }
    },
  }) as ToolDefinition;
}
