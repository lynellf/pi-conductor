import { StringDecoder } from "node:string_decoder";

/** Bounded UTF-8 output state for one supervised stream. */
export interface OutputCapture {
  text: string;
  truncated: boolean;
  capturedBytes: number;
  readonly decoder: StringDecoder;
}

/** Create an empty stream capture with a stateful UTF-8 decoder. */
export function createOutputCapture(): OutputCapture {
  return { text: "", truncated: false, capturedBytes: 0, decoder: new StringDecoder("utf8") };
}

/** Append a bounded byte chunk without splitting a multi-byte UTF-8 character. */
export function appendOutput(
  state: OutputCapture,
  total: { bytes: number },
  chunk: Buffer,
  limit: number,
): void {
  if (total.bytes >= limit) {
    state.truncated = true;
    return;
  }
  const remaining = limit - total.bytes;
  const capturedBytes = Math.min(chunk.byteLength, remaining);
  state.text += state.decoder.write(chunk.subarray(0, capturedBytes));
  total.bytes += capturedBytes;
  state.capturedBytes += capturedBytes;
  state.text = truncateUtf8(state.text, state.capturedBytes);
  if (chunk.byteLength > remaining) state.truncated = true;
}

/** Flush a stream decoder after the child closes. */
export function finishOutput(state: OutputCapture): string {
  // Do not flush StringDecoder: an incomplete trailing sequence must be
  // discarded rather than expanded to U+FFFD beyond the byte budget.
  return truncateUtf8(state.text, state.capturedBytes);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = value.length;
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end -= 1;
  return value.slice(0, end);
}
