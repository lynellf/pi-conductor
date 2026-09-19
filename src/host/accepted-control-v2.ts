/** Host-owned v2 accepted-control promotion and bounded envelope construction (§7, §9). */

import type {
  AcceptedControlV2,
  RecipientTaskContextV2,
  ReportedContextV2,
  Role,
} from "../core/types.js";
import { sanitizeReportedHintsV2 } from "../seam/control-arguments.js";

const ACCEPTED_CONTROL_MAX_UTF8_BYTES = 16 * 1024;

/** Typed failure for an impossible host-generated v2 control envelope. */
export class AcceptedControlV2Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcceptedControlV2Error";
  }
}

/** Build the durable host-generated envelope before accepted-record persistence. */
export function createAcceptedControlV2(args: {
  readonly sourceRole: Role;
  readonly orchestratorRole: Role;
  readonly recipientRole: Role;
  readonly reportedArguments: unknown;
  readonly reportedContext?: ReportedContextV2;
}): AcceptedControlV2 {
  const reported = isRecord(args.reportedArguments)
    ? sanitizeReportedHintsV2(args.reportedArguments)
    : { hints: {}, task_context: {}, ignored_fields: [] };
  const task: RecipientTaskContextV2 = {
    host_directive:
      args.sourceRole === args.orchestratorRole
        ? `Perform the work assigned to role ${args.recipientRole} in service of the run goal.`
        : `Assess the returned work against the run goal and choose the next legal action.`,
    ...(reported.task_context.objective === undefined
      ? {}
      : { reported_objective: reported.task_context.objective }),
    ...(reported.task_context.requested_action === undefined
      ? {}
      : { reported_action: reported.task_context.requested_action }),
    ...(args.reportedContext === undefined ? {} : { reported_context: args.reportedContext }),
  };
  const direction: AcceptedControlV2["direction"] =
    args.sourceRole === args.orchestratorRole ? "dispatch" : "return";
  const base = {
    schema_version: 2 as const,
    direction,
    recipient_role: args.recipientRole,
    task,
    reported_hints: reported.hints,
    ignored_hint_fields: reported.ignored_fields,
  };
  const bounded = fitEnvelope(base);
  return Object.freeze(bounded);
}

function fitEnvelope(base: Omit<AcceptedControlV2, "utf8_bytes">): AcceptedControlV2 {
  const first = measure(base);
  if (first.utf8_bytes <= ACCEPTED_CONTROL_MAX_UTF8_BYTES) return first;

  const { reported_context: _reportedContext, ...taskWithoutContext } = base.task;
  const withoutContext: Omit<AcceptedControlV2, "utf8_bytes"> = {
    ...base,
    task: taskWithoutContext,
  };
  const second = measure(removeUndefined(withoutContext));
  if (second.utf8_bytes <= ACCEPTED_CONTROL_MAX_UTF8_BYTES) return second;

  const withoutHints: Omit<AcceptedControlV2, "utf8_bytes"> = {
    ...removeUndefined(withoutContext),
    reported_hints: {},
  };
  const third = measure(withoutHints);
  if (third.utf8_bytes <= ACCEPTED_CONTROL_MAX_UTF8_BYTES) return third;
  throw new AcceptedControlV2Error("host-generated v2 control envelope exceeds 16 KiB");
}

function measure(value: Omit<AcceptedControlV2, "utf8_bytes">): AcceptedControlV2 {
  const json = JSON.stringify(value);
  const utf8_bytes = new TextEncoder().encode(json).byteLength;
  return { ...value, utf8_bytes };
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
