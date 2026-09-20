/** TypeBox contract for host-owned reviewer terminal decisions (issue #124). */

import { type Static, Type } from "typebox";

/** Maximum UTF-16 code units retained for a reviewer reason. */
export const REVIEW_REASON_MAX_LENGTH = 4096;

/** Reviewer approval arguments; routing and identity remain host-owned. */
export const approveArgsSchema = Type.Object(
  {
    reason: Type.String({
      minLength: 1,
      maxLength: REVIEW_REASON_MAX_LENGTH,
      pattern: "\\S",
      description: "Bounded explanation for approving the pinned review gate.",
    }),
  },
  { additionalProperties: false },
);

/** Reviewer change-request arguments; routing and identity remain host-owned. */
export const requestChangesArgsSchema = Type.Object(
  {
    reason: Type.String({
      minLength: 1,
      maxLength: REVIEW_REASON_MAX_LENGTH,
      pattern: "\\S",
      description: "Bounded explanation for the requested changes.",
    }),
  },
  { additionalProperties: false },
);

/** Typed arguments produced by the `approve` tool. */
export type ApproveArgs = Static<typeof approveArgsSchema>;

/** Typed arguments produced by the `request_changes` tool. */
export type RequestChangesArgs = Static<typeof requestChangesArgsSchema>;

/** Host-captured reviewer terminal tool call before persistence. */
export interface ReviewDecisionCapture {
  readonly toolName: "approve" | "request_changes";
  readonly args: unknown;
}

/** Reviewer outcome represented by the two terminal tool names. */
export type ReviewDecision = ReviewDecisionCapture["toolName"];
