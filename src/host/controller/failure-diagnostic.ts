/** Bounded controller failure detail without stdout, environment, stack, or object inspection. */
const MAX_DIAGNOSTIC_BYTES = 4 * 1024;
const MAX_CAUSE_DEPTH = 3;

/** Format safe Error identity and a short cause chain for durable operator diagnostics. */
export function formatControllerFailure(value: unknown): string {
  if (!(value instanceof Error)) return primitiveDiagnostic(value);
  const parts: string[] = [];
  let current: Error | undefined = value;
  for (let depth = 0; current !== undefined && depth < MAX_CAUSE_DEPTH; depth += 1) {
    parts.push(`${depth === 0 ? "" : "caused by: "}${errorIdentity(current)}`);
    current = safeCause(current);
  }
  return truncateUtf8(parts.join("\n"), MAX_DIAGNOSTIC_BYTES);
}

function errorIdentity(error: Error): string {
  const name = safeString(() => error.name) || "Error";
  const code = safeCode(error);
  const message = safeString(() => error.message) || "controller operation failed";
  return `${name}${code === null ? "" : ` [${code}]`}: ${message}`;
}

function safeCause(error: Error): Error | undefined {
  try {
    return error.cause instanceof Error ? error.cause : undefined;
  } catch {
    return undefined;
  }
}

function safeCode(error: Error): string | null {
  try {
    const code = (error as Error & { readonly code?: unknown }).code;
    return typeof code === "string" || typeof code === "number" ? String(code) : null;
  } catch {
    return null;
  }
}

function safeString(read: () => unknown): string {
  try {
    const value = read();
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function primitiveDiagnostic(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  )
    return truncateUtf8(`Unknown controller failure: ${String(value)}`, MAX_DIAGNOSTIC_BYTES);
  return "Unknown controller failure";
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "…";
  const target = maxBytes - Buffer.byteLength(suffix, "utf8");
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= target) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low)}${suffix}`;
}
