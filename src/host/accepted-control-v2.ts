/** Host-owned v2 accepted-control promotion and bounded envelope construction (§7, §9). */

import type {
  AcceptedControlV2,
  RecipientTaskContextV2,
  ReportedContextV2,
  Role,
} from "../core/types.js";
import { parseReturnEnvelope, sanitizeReportedHintsV2 } from "../seam/control-arguments.js";

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
  const direction: AcceptedControlV2["direction"] =
    args.sourceRole === args.orchestratorRole ? "dispatch" : "return";
  const reported = isRecord(args.reportedArguments)
    ? sanitizeReportedHintsV2(args.reportedArguments)
    : { hints: {}, task_context: {}, ignored_fields: [] };
  const returnEnvelope =
    direction === "return" ? parseReturnEnvelope(args.reportedArguments) : undefined;
  // Keep `ignored_hint_fields` exactly compatible with the generic control
  // sanitizer: required/control fields such as `target_role`, `status`,
  // `objective`, and `requested_action` are consumed by the handoff path and
  // must not become "ignored" merely because the return-envelope narrative
  // parser does not project them. Stable return diagnostics are therefore
  // limited to fields the existing sanitizer actually classified as ignored.
  const ignoredReturnDiagnostics =
    returnEnvelope === undefined
      ? undefined
      : returnEnvelope.ignored
          .filter((entry) => reported.ignored_fields.includes(entry.name))
          .map((entry) => entry.diagnostic);
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
  const base: Omit<AcceptedControlV2, "utf8_bytes"> = {
    schema_version: 2 as const,
    direction,
    recipient_role: args.recipientRole,
    task,
    reported_hints: returnEnvelope?.supported ?? reported.hints,
    ignored_hint_fields: reported.ignored_fields,
    ...(ignoredReturnDiagnostics === undefined || ignoredReturnDiagnostics.length === 0
      ? {}
      : { ignored_hint_diagnostics: ignoredReturnDiagnostics }),
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

  const withoutOptionalHints: Omit<AcceptedControlV2, "utf8_bytes"> = {
    ...removeUndefined(withoutContext),
    reported_hints:
      withoutContext.reported_hints.reason === undefined
        ? {}
        : { reason: withoutContext.reported_hints.reason },
  };
  const third = measure(withoutOptionalHints);
  if (third.utf8_bytes <= ACCEPTED_CONTROL_MAX_UTF8_BYTES) return third;

  const { ignored_hint_diagnostics: _ignoredDiagnostics, ...withoutDiagnostics } =
    withoutOptionalHints;
  const fourth = measure(withoutDiagnostics);
  if (fourth.utf8_bytes <= ACCEPTED_CONTROL_MAX_UTF8_BYTES) return fourth;
  throw new AcceptedControlV2Error("host-generated v2 control envelope exceeds 16 KiB");
}

function measure(value: Omit<AcceptedControlV2, "utf8_bytes">): AcceptedControlV2 {
  let utf8_bytes = 0;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const json = JSON.stringify({ ...value, utf8_bytes });
    const measured = new TextEncoder().encode(json).byteLength;
    if (measured === utf8_bytes) return { ...value, utf8_bytes: measured };
    utf8_bytes = measured;
  }
  return { ...value, utf8_bytes };
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
