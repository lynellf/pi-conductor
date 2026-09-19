/** Raw v2 control-argument boundary and best-effort hint extraction (§6.5–§6.6). */

/** Hard compact-JSON UTF-8 bound applied before semantic inspection. */
export const RAW_CONTROL_ARGUMENT_MAX_UTF8_BYTES = 65_536;
const MAX_IGNORED_FIELD_NAMES = 32;
const MAX_FIELD_NAME_CHARS = 64;
const MAX_HINT_UTF8_BYTES = 2_048;
const MAX_VERIFICATION_ITEMS = 16;
const MAX_VERIFICATION_UTF8_BYTES = 256;

/** Mechanical reasons for rejecting a complete tool argument object. */
export type RawControlArgumentRejection = "tool_arguments_not_json" | "tool_arguments_too_large";

/** Result of the pre-sanitization raw argument boundary. */
export type RawControlArguments =
  | {
      readonly kind: "accepted";
      readonly value: Readonly<Record<string, unknown>>;
      readonly json: string;
      readonly utf8_bytes: number;
    }
  | {
      readonly kind: "rejected";
      readonly reason: RawControlArgumentRejection;
    };

/** Best-effort v2 narrative fields retained after boundary validation. */
export interface ReportedHintsV2 {
  readonly summary?: string;
  readonly reason?: string;
  readonly verification?: readonly string[];
}

/** Optional model-reported task text, kept separate from host routing. */
export interface ReportedTaskContextV2 {
  readonly objective?: string;
  readonly requested_action?: string;
}

/** Sanitized hints plus bounded names for ignored optional fields. */
export interface SanitizedReportedHintsV2 {
  readonly hints: ReportedHintsV2;
  readonly task_context: ReportedTaskContextV2;
  readonly ignored_fields: readonly string[];
}

/**
 * Encode one complete argument object as compact JSON and measure its UTF-8
 * bytes before inspecting any semantic field. No partial value is returned.
 */
export function readRawControlArguments(value: unknown): RawControlArguments {
  if (!isJsonObject(value)) return { kind: "rejected", reason: "tool_arguments_not_json" };

  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return { kind: "rejected", reason: "tool_arguments_not_json" };
  }
  if (json === undefined) return { kind: "rejected", reason: "tool_arguments_not_json" };
  const utf8_bytes = new TextEncoder().encode(json).byteLength;
  if (utf8_bytes > RAW_CONTROL_ARGUMENT_MAX_UTF8_BYTES) {
    return { kind: "rejected", reason: "tool_arguments_too_large" };
  }
  return { kind: "accepted", value, json, utf8_bytes };
}

/** Extract only bounded, explicitly recognized narrative fields. */
export function sanitizeReportedHintsV2(
  value: Readonly<Record<string, unknown>>,
): SanitizedReportedHintsV2 {
  const ignored = new Set<string>();
  const hints: {
    summary?: string;
    reason?: string;
    verification?: readonly string[];
  } = {};
  const task_context: { objective?: string; requested_action?: string } = {};

  const summary = boundedString(value.summary, MAX_HINT_UTF8_BYTES);
  if (value.summary !== undefined) {
    if (summary === undefined) ignored.add("summary");
    else hints.summary = summary;
  }
  const reason = boundedString(value.reason, MAX_HINT_UTF8_BYTES);
  if (value.reason !== undefined) {
    if (reason === undefined) ignored.add("reason");
    else hints.reason = reason;
  }
  const objective = boundedString(value.objective, MAX_HINT_UTF8_BYTES);
  if (value.objective !== undefined) {
    if (objective === undefined) ignored.add("objective");
    else task_context.objective = objective;
  }
  const requestedAction = boundedString(value.requested_action, MAX_HINT_UTF8_BYTES);
  if (value.requested_action !== undefined) {
    if (requestedAction === undefined) ignored.add("requested_action");
    else task_context.requested_action = requestedAction;
  }

  if (value.verification !== undefined) {
    if (!Array.isArray(value.verification)) {
      ignored.add("verification");
    } else {
      const verification: string[] = [];
      for (const item of value.verification) {
        const bounded = boundedString(item, MAX_VERIFICATION_UTF8_BYTES);
        if (bounded === undefined) {
          ignored.add("verification");
        } else if (verification.length < MAX_VERIFICATION_ITEMS) {
          verification.push(bounded);
        }
      }
      if (verification.length > 0) hints.verification = Object.freeze(verification);
    }
  }

  for (const key of Object.keys(value)) {
    if (RECOGNIZED_CONTROL_FIELDS.has(key)) continue;
    ignored.add(key);
  }

  return Object.freeze({
    hints: Object.freeze(hints),
    task_context: Object.freeze(task_context),
    ignored_fields: Object.freeze(
      [...ignored]
        .slice(0, MAX_IGNORED_FIELD_NAMES)
        .map((field) => field.slice(0, MAX_FIELD_NAME_CHARS)),
    ),
  });
}

const RECOGNIZED_CONTROL_FIELDS = new Set([
  "target_role",
  "request_end",
  "summary",
  "reason",
  "verification",
  "objective",
  "requested_action",
  "status",
  "suggests_next",
  "artifacts",
  "continuity",
  "context_ref",
  "evidence",
  "final_note",
  "metadata",
  "confidence",
  "findings",
  "evaluations",
  "open_questions",
  "next_steps",
]);

function boundedString(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (new TextEncoder().encode(trimmed).byteLength > maxBytes) return undefined;
  return trimmed;
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const seen = new WeakSet<object>();
  return isJsonValue(value, seen);
}

function isJsonValue(value: unknown, seen: WeakSet<object>): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      return false;
    case "object":
      break;
    default:
      return false;
  }

  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isJsonValue(item, seen)) return false;
    }
    seen.delete(value);
    return true;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const objectValue = value as Record<string, unknown>;
  for (const key of Object.keys(objectValue)) {
    if (!isJsonValue(objectValue[key], seen)) return false;
  }
  seen.delete(value);
  return true;
}
