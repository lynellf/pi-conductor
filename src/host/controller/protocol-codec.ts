/** Strict JSON codec for the controller planner boundary — issue #115 §3. */

import { Value } from "typebox/value";
import {
  type ControllerRequest,
  type ControllerResponse,
  controllerRequestSchema,
  controllerResponseSchema,
} from "../../manifest/controller-protocol.js";

/** Protocol v1 hard ceiling for each encoded request or response. */
export const CONTROLLER_JSON_MAX_BYTES = 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_STATE_BYTES = 64 * 1024;

export type ControllerProtocolErrorCode = "invalid" | "stale_identity" | "bounds";

/** Typed failure raised at the controller JSON boundary. */
export class TypedControllerProtocolError extends Error {
  constructor(
    readonly code: ControllerProtocolErrorCode,
    message: string,
  ) {
    super(boundMessage(message));
    this.name = "TypedControllerProtocolError";
  }
}

/** Encode a validated request, enforcing protocol byte/depth limits. */
export function encodeControllerRequest(request: ControllerRequest): Buffer {
  validateRequest(request);
  return encodeBoundedControllerJson(request);
}

/** Encode one strict plain JSON value within the protocol v1 depth and byte ceilings. */
export function encodeBoundedControllerJson(value: unknown): Buffer {
  maxDepth(value);
  return encodeJson(value);
}

/** Decode and validate one response against the exact request identity. */
export function decodeControllerResponse(
  bytes: Uint8Array,
  request: ControllerRequest,
): ControllerResponse {
  const value = decodeJson(bytes);
  if (!Value.Check(controllerResponseSchema, value))
    throw protocolError("invalid", "controller response does not match protocol schema");
  const response = value as ControllerResponse;
  if (
    response.run_id !== request.run_id ||
    response.controller_id !== request.controller_id ||
    response.definition_digest !== request.definition_digest ||
    response.activation_id !== request.activation_id ||
    response.owner_epoch !== request.owner_epoch
  )
    throw protocolError("stale_identity", "controller response identity does not match request");
  if (response.state_revision !== request.state_revision)
    throw protocolError("stale_identity", "controller response state revision is stale");
  if (!sameCursor(response.event_cursor, request.page_cursor))
    throw protocolError("stale_identity", "controller response cursor does not match request page");
  validatePayloadBounds(response);
  return response;
}

function validateRequest(request: ControllerRequest): void {
  if (!Value.Check(controllerRequestSchema, request))
    throw protocolError("invalid", "controller request does not match protocol schema");
  validatePayloadBounds(request);
}

function validatePayloadBounds(value: ControllerRequest | ControllerResponse): void {
  const depth = maxDepth(value);
  if (depth > MAX_DEPTH) throw protocolError("bounds", "controller JSON exceeds depth limit");
  const state = value.state;
  if (jsonBytes(state) > MAX_STATE_BYTES)
    throw protocolError("bounds", "controller state exceeds 64 KiB");
  if ("actions" in value) {
    const ids = new Set<string>();
    for (const action of value.actions) {
      if (new TextEncoder().encode(action.action_id).byteLength > 128)
        throw protocolError("bounds", "controller action ID exceeds 128 UTF-8 bytes");
      if (ids.has(action.action_id))
        throw protocolError("invalid", `controller plan repeats action '${action.action_id}'`);
      ids.add(action.action_id);
    }
  }
}

function encodeJson(value: unknown): Buffer {
  let text: string;
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("JSON value is undefined");
    text = encoded;
  } catch (cause) {
    throw protocolError("invalid", `controller JSON cannot be encoded: ${errorMessage(cause)}`);
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > CONTROLLER_JSON_MAX_BYTES)
    throw protocolError("bounds", "controller JSON exceeds 1 MiB");
  return Buffer.from(bytes);
}

function decodeJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength > CONTROLLER_JSON_MAX_BYTES)
    throw protocolError("bounds", "controller JSON exceeds 1 MiB");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw protocolError("invalid", "controller JSON is not valid UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw protocolError(
      "invalid",
      "controller response must be one JSON value with no trailing data",
    );
  }
}

function maxDepth(value: unknown, depth = 0, seen = new Set<object>()): number {
  if (depth > MAX_DEPTH) throw protocolError("bounds", "controller JSON exceeds depth limit");
  if (typeof value === "number" && !Number.isFinite(value))
    throw protocolError("invalid", "controller JSON contains a non-finite number");
  if (
    value !== null &&
    typeof value !== "string" &&
    typeof value !== "boolean" &&
    typeof value !== "number" &&
    typeof value !== "object"
  )
    throw protocolError("invalid", "controller JSON contains an unsupported primitive");
  if (value === null || typeof value !== "object") return depth;
  if (seen.has(value)) throw protocolError("invalid", "controller JSON contains a cycle");
  seen.add(value);
  let result = depth;
  if (Array.isArray(value)) {
    for (const item of value) result = Math.max(result, maxDepth(item, depth + 1, seen));
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw protocolError("invalid", "controller JSON must contain plain objects");
    for (const item of Object.values(value))
      result = Math.max(result, maxDepth(item, depth + 1, seen));
  }
  seen.delete(value);
  return result;
}

function jsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    throw protocolError("invalid", "controller JSON contains an unserializable value");
  }
}

function sameCursor(
  a: ControllerRequest["page_cursor"],
  b: ControllerRequest["page_cursor"],
): boolean {
  if (a === null || b === null) return a === b;
  return a.ordinal === b.ordinal && a.record_digest === b.record_digest;
}

function protocolError(
  code: ControllerProtocolErrorCode,
  message: string,
): TypedControllerProtocolError {
  return new TypedControllerProtocolError(code, message);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function boundMessage(message: string): string {
  let output = "";
  let bytes = 0;
  for (const character of message) {
    const size = new TextEncoder().encode(character).byteLength;
    if (bytes + size > 4096) break;
    output += character;
    bytes += size;
  }
  return output;
}
