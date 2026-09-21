/**
 * Issue #135, Phase 3: bounded redaction helpers for host-observed evidence.
 *
 * These helpers shrink host observations into the facts the seed may carry —
 * never raw full output, environment values, absolute home paths, or
 * credentials (plan invariant: no secrets or transcripts in continuity). Each
 * is pure and side-effect free.
 */

import { createHash } from "node:crypto";

/**
 * sha256 hex digest of a buffer. The digest is the stable, fixed-length truth
 * about an execution's output; the redacted head is only a bounded preview.
 */
export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Truncate a UTF-8 string to at most `maxBytes`, never splitting a code point.
 *
 * A raw `Buffer.from(str).subarray(0, maxBytes).toString("utf8")` can leave a
 * trailing partial multibyte sequence decoded to U+FFFD (3 bytes), which would
 * exceed the cap. Trim trailing U+FFFD until the measured byte length holds the
 * exact bound.
 */
function boundedUtf8Head(str: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(str, "utf8") <= maxBytes) return str;
  let head = Buffer.from(str, "utf8").subarray(0, maxBytes).toString("utf8");
  // A partial trailing code point decodes to U+FFFD (up to 3 bytes). Trim it
  // until the byte cap holds exactly — at most a couple of iterations.
  while (head.length > 0 && Buffer.byteLength(head, "utf8") > maxBytes) head = head.slice(0, -1);
  return head;
}

/**
 * Token start guard: a path begins at `/` or a drive letter that is NOT
 * preceded by a word char, colon, dot, slash, or dash — so URL schemes
 * (`http://...`) and shell flags (`-x`) are left intact.
 */
const PATH_PREFIX_GUARD = "(?<![A-Za-z0-9:.\\/-])";

const ABSOLUTE_WINDOWS = new RegExp(`${PATH_PREFIX_GUARD}[A-Za-z]:[\\\\/][^\\s"'\`]*`, "g");
const ABSOLUTE_UNIX = new RegExp(`${PATH_PREFIX_GUARD}/[^\\s"'\`]*`, "g");

/**
 * Redact absolute filesystem paths (Unix drive and Windows drive forms).
 * URL schemes survive: their leading `/` is preceded by `:` (in the guard
 * set), and the second `/` of `//` is preceded by `/` (also guarded).
 */
export function redactAbsolutePaths(value: string): string {
  return value.replace(ABSOLUTE_WINDOWS, "[abs]").replace(ABSOLUTE_UNIX, "[abs]");
}

/**
 * Credential-assignment and header value patterns. Captures the key +
 * separator, then the value up to the next quote/newline, and redacts only
 * the value. Case-insensitive; over-redaction (e.g. `key`) is safe.
 */
const CREDENTIAL = new RegExp(
  "((" +
    "token|secret|api[_-]?key|apikey|passwd|pwd|password|access[_-]?key|" +
    "authorization|authorization[_-]?token|bearer|private[_-]?key|" +
    "client[_-]?secret|credential|key" +
    ")\\b[^:\\n\"'=<>]{0,40}\\s*[:=]\\s*)([^\\n\"'=<>\\\\]+)",
  "gi",
);

/**
 * Redact credential-like assignments and header values to `[redacted]`,
 * keeping the key + separator so the shape stays informative.
 */
export function redactCredentials(value: string): string {
  return value.replace(CREDENTIAL, (_full, key: string) => `${key}[redacted]`);
}

/**
 * Collapse CR/LF runs to a single space so a multi-line command renders on one
 * line, then trim surrounding whitespace.
 */
function toSingleLine(value: string): string {
  return value
    .replace(/[\r\n]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Bound a string to `maxChars` code units, tail-truncating with U+2026 so the
 * total is at most `maxChars` (schema `maxLength`, plan invariant).
 */
function toCharCap(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * Reduce a raw command to a bounded, single-line, redacted identity: drop
 * newlines, scrub credentials and absolute paths, then cap the length. This is
 * what the seed carries — never the unredacted command (plan invariant).
 */
export function redactCommandIdentity(command: string, maxChars: number): string {
  return toCharCap(redactAbsolutePaths(redactCredentials(toSingleLine(command))), maxChars);
}

/**
 * Reduce captured command output to a bounded, redacted head: scrub
 * credentials and absolute paths, then byte-cap it so the digest + head never
 * carry raw full output (plan invariant).
 */
export function redactOutputHead(output: Buffer, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const scrubbed = redactAbsolutePaths(redactCredentials(output.toString("utf8")));
  return boundedUtf8Head(scrubbed, maxBytes);
}
