/** Raw v2 control-argument boundary and best-effort hint extraction (§6.5–§6.6). */

import { Value } from "typebox/value";
import { returnEnvelopeArgsSchema } from "./schema.js";

export type { ReturnEnvelopeArgs } from "./schema.js";
// Issue #137 — re-export the documented worker-return envelope schema so a
// caller can validate a captured emission against the contract boundary
// without reaching into the schema module directly. The semantic parser
// below (`parseReturnEnvelope`) validates against the same schema before
// applying its stricter bounded-field policy; both surfaces share the single
// source of truth defined in `schema.ts`.
export { returnEnvelopeArgsSchema } from "./schema.js";

/** Hard compact-JSON UTF-8 bound applied before semantic inspection. */
export const RAW_CONTROL_ARGUMENT_MAX_UTF8_BYTES = 65_536;
const MAX_IGNORED_FIELD_NAMES = 32;
const MAX_FIELD_NAME_CHARS = 64;
const MAX_HINT_UTF8_BYTES = 2_048;
const MAX_VERIFICATION_ITEMS = 16;
const MAX_VERIFICATION_UTF8_BYTES = 256;

// ─── Issue #137: return envelope (worker → orchestrator) ────────────

/** Stable diagnostic prefix emitted for every ignored return-envelope field. */
export const RETURN_ENVELOPE_DIAGNOSTIC_PREFIX = "ignored_return_field:";

/** One recorded unsupported top-level field on the return envelope. */
export interface ReturnEnvelopeIgnoredField {
  /** Stable field name (≤ MAX_FIELD_NAME_CHARS code units). */
  readonly name: string;
  /** Stable diagnostic name; always `${RETURN_ENVELOPE_DIAGNOSTIC_PREFIX}${name}`. */
  readonly diagnostic: string;
}

/** Validated worker-return envelope: supported narrative + explicitly ignored fields. */
export interface ReturnEnvelope {
  readonly supported: {
    readonly reason?: string;
    readonly summary?: string;
    readonly verification?: readonly string[];
  };
  readonly ignored: readonly ReturnEnvelopeIgnoredField[];
}

/** Supported top-level narrative fields on the return envelope. */
const RETURN_ENVELOPE_SUPPORTED_FIELDS: ReadonlySet<string> = new Set([
  "reason",
  "summary",
  "verification",
]);

/** Bounded, frozen list of ignored-field entries from one parse call. */
function freezeIgnored(
  ignored: readonly ReturnEnvelopeIgnoredField[],
): readonly ReturnEnvelopeIgnoredField[] {
  return Object.freeze([...ignored]);
}

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
      [...ignored].slice(0, MAX_IGNORED_FIELD_NAMES).map((field) => boundFieldName(field)),
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

/**
 * Issue #137: validate one raw return-arguments object against the
 * documented worker-return envelope.
 *
 * The supported narrative fields (`reason` primary, `summary`, `verification`)
 * are returned in `supported`. Any other top-level key (or any malformed
 * supported field) is recorded in `ignored` with a stable diagnostic name
 * shaped `${RETURN_ENVELOPE_DIAGNOSTIC_PREFIX}${field_name}` so a role can
 * self-correct without re-deriving the contract from a seam failure.
 *
 * Non-object inputs return an empty envelope rather than throwing — the
 * return envelope is best-effort hint extraction, not a hard contract
 * breach; the seam already rejects malformed tool-argument objects at the
 * raw boundary (`readRawControlArguments`).
 *
 * The supported `reason` is **never silently displaced**: even when the
 * envelope carries ignored custom fields, the parsed bounded
 * `supported.reason` remains available to the host.
 */
export function parseReturnEnvelope(value: unknown): ReturnEnvelope {
  if (!isJsonObject(value)) {
    return Object.freeze({
      supported: Object.freeze({}) as ReturnEnvelope["supported"],
      ignored: Object.freeze([]) as readonly ReturnEnvelopeIgnoredField[],
    });
  }

  // Validate the documented structural shape first. Semantic bounds (trim,
  // UTF-8 length, and item count) are stricter and are applied below so an
  // invalid optional field becomes an explicit diagnostic instead of dropping
  // the complete return narrative.
  const schemaValid = Value.Check(returnEnvelopeArgsSchema, value);

  const supported: { reason?: string; summary?: string; verification?: readonly string[] } = {};
  const ignored: ReturnEnvelopeIgnoredField[] = [];

  const reason = boundedString(value.reason, MAX_HINT_UTF8_BYTES);
  if (value.reason !== undefined) {
    if (reason === undefined) {
      addIgnored(ignored, "reason");
    } else {
      supported.reason = reason;
    }
  }

  const summary = boundedString(value.summary, MAX_HINT_UTF8_BYTES);
  if (value.summary !== undefined) {
    if (summary === undefined) {
      addIgnored(ignored, "summary");
    } else {
      supported.summary = summary;
    }
  }

  if (value.verification !== undefined) {
    if (!Array.isArray(value.verification)) {
      addIgnored(ignored, "verification");
    } else {
      const verification: string[] = [];
      let malformed = value.verification.length > MAX_VERIFICATION_ITEMS;
      for (const item of value.verification) {
        const bounded = boundedString(item, MAX_VERIFICATION_UTF8_BYTES);
        if (bounded === undefined) {
          malformed = true;
          break;
        }
        if (verification.length < MAX_VERIFICATION_ITEMS) {
          verification.push(bounded);
        }
      }
      if (malformed || verification.length === 0) {
        addIgnored(ignored, "verification");
      } else {
        supported.verification = Object.freeze(verification);
      }
    }
  }

  for (const key of Object.keys(value)) {
    if (RETURN_ENVELOPE_SUPPORTED_FIELDS.has(key)) continue;
    addIgnored(ignored, key);
  }

  if (!schemaValid && ignored.length === 0) {
    addIgnored(ignored, "return_envelope");
  }

  return Object.freeze({
    supported: Object.freeze(supported) as ReturnEnvelope["supported"],
    ignored: freezeIgnored(ignored),
  });
}

function addIgnored(ignored: ReturnEnvelopeIgnoredField[], name: string): void {
  if (ignored.length >= MAX_IGNORED_FIELD_NAMES) return;
  ignored.push(makeIgnored(name));
}

function makeIgnored(name: string): ReturnEnvelopeIgnoredField {
  const bounded = boundFieldName(name);
  return Object.freeze({
    name: bounded,
    diagnostic: `${RETURN_ENVELOPE_DIAGNOSTIC_PREFIX}${bounded}`,
  });
}

function boundFieldName(value: string): string {
  let printable = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\r") printable += "\\r";
    else if (character === "\n") printable += "\\n";
    else printable += code < 32 || code === 127 ? "?" : character;
  }
  const byCharacters = printable.slice(0, MAX_FIELD_NAME_CHARS);
  if (byCharacters.length === 0) return "<empty>";
  const bytes = new TextEncoder().encode(byCharacters);
  if (bytes.byteLength <= MAX_FIELD_NAME_CHARS) return byCharacters;
  let end = MAX_FIELD_NAME_CHARS;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.slice(0, end));
}

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
