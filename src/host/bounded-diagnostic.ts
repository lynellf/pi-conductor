/** Bounded host diagnostics with valid UTF-8 boundaries. */
export interface BoundedDiagnostic {
  readonly output: string;
  readonly truncated: boolean;
}

/** Cap text by UTF-8 bytes without cutting a code point. */
export function capErrorDiagnostic(text: string, limitBytes = 4 * 1024): BoundedDiagnostic {
  let output = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > limitBytes) return { output, truncated: true };
    output += character;
    bytes += size;
  }
  return { output, truncated: false };
}
