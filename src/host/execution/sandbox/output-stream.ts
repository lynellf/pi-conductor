/** Backpressured stream capture and retained-byte verification for Issue #106 §7. */
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { Writable } from "node:stream";

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const READ_BUFFER_BYTES = 64 * 1024;

/** Minimal positioned file interface used by capture and fault injection. */
export interface SandboxOutputFile {
  readonly write: (
    bytes: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ readonly bytesWritten: number }>;
  readonly read: (
    bytes: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ readonly bytesRead: number }>;
  readonly stat: () => Promise<Stats>;
  readonly sync: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/** One bounded, presentation-only preview kept out of durable metadata. */
export interface SandboxOutputPreview {
  readonly encoding: "utf8" | "base64";
  readonly data: string;
  readonly byteCount: number;
  readonly truncated: boolean;
}

/** Verified retained state for one output file. */
export interface ObservedSandboxOutput {
  readonly byteCount: number;
  readonly retainedVerified: boolean;
  readonly sha256?: string;
  readonly preview: SandboxOutputPreview;
}

/** Shared combined-cap and termination-request state for stdout and stderr. */
export class SandboxOutputCaptureState {
  remaining: number;
  failure: "cap" | "storage" | undefined;
  readonly captureFailure: Promise<"cap" | "storage">;
  private resolveFailure!: (category: "cap" | "storage") => void;
  constructor(maxBytes: number) {
    this.remaining = maxBytes;
    this.captureFailure = new Promise((resolve) => {
      this.resolveFailure = resolve;
    });
  }
  reserve(length: number): number {
    if (this.failure !== undefined) return 0;
    const accepted = Math.min(length, this.remaining);
    this.remaining -= accepted;
    if (accepted < length) this.fail("cap");
    return accepted;
  }
  fail(category: "cap" | "storage"): void {
    if (this.failure !== undefined) return;
    this.failure = category;
    this.resolveFailure(category);
  }
}

/** Writable that drains after failure and verifies the retained file after sync. */
export class SandboxOutputWritable extends Writable {
  private position = 0;
  private durable = true;
  constructor(
    private readonly file: SandboxOutputFile,
    private readonly capture: SandboxOutputCaptureState,
  ) {
    super();
  }
  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    const accepted = this.capture.reserve(bytes.length);
    void this.persist(bytes.subarray(0, accepted)).then(() => done());
  }
  override _final(done: (error?: Error | null) => void): void {
    void this.file.sync().then(
      () => done(),
      () => {
        this.durable = false;
        this.capture.fail("storage");
        done();
      },
    );
  }
  async observe(previewLimit: number): Promise<ObservedSandboxOutput> {
    let observedSize: number | undefined;
    try {
      const before = await this.file.stat();
      observedSize = before.size;
      assertRegularOutput(before);
      const hash = createHash("sha256");
      const scratch = Buffer.allocUnsafe(READ_BUFFER_BYTES);
      const preview = Buffer.alloc(Math.min(before.size, previewLimit));
      let position = 0;
      while (position < before.size) {
        const result = await this.file.read(
          scratch,
          0,
          Math.min(scratch.length, before.size - position),
          position,
        );
        const requested = Math.min(scratch.length, before.size - position);
        if (
          !Number.isSafeInteger(result.bytesRead) ||
          result.bytesRead <= 0 ||
          result.bytesRead > requested
        )
          throw new Error("invalid sandbox output read progress");
        const bytes = scratch.subarray(0, result.bytesRead);
        hash.update(bytes);
        if (position < preview.length)
          bytes.copy(preview, position, 0, Math.min(bytes.length, preview.length - position));
        position += result.bytesRead;
      }
      if (before.size !== this.position || !sameFile(before, await this.file.stat()))
        throw new Error("sandbox output changed during verification");
      return {
        byteCount: before.size,
        retainedVerified: this.durable,
        ...(this.durable ? { sha256: hash.digest("hex") } : {}),
        preview: encodeSandboxOutputPreview(preview, before.size > preview.length),
      };
    } catch {
      this.capture.fail("storage");
      return {
        byteCount: observedSize ?? this.position,
        retainedVerified: false,
        preview: encodeSandboxOutputPreview(Buffer.alloc(0), this.position > 0),
      };
    }
  }
  async closeFile(): Promise<boolean> {
    try {
      await this.file.close();
      return true;
    } catch {
      this.capture.fail("storage");
      return false;
    }
  }
  private async persist(bytes: Buffer): Promise<void> {
    let offset = 0;
    try {
      while (offset < bytes.length) {
        const requested = bytes.length - offset;
        const result = await this.file.write(bytes, offset, requested, this.position);
        if (
          !Number.isSafeInteger(result.bytesWritten) ||
          result.bytesWritten <= 0 ||
          result.bytesWritten > requested
        )
          throw new Error("invalid sandbox output write progress");
        this.position += result.bytesWritten;
        offset += result.bytesWritten;
      }
    } catch {
      this.capture.fail("storage");
    }
  }
}

/** Encode bytes as UTF-8 only when the selected byte range is complete valid UTF-8. */
export function encodeSandboxOutputPreview(
  bytes: Buffer,
  truncated: boolean,
): SandboxOutputPreview {
  const text = bytes.toString("utf8");
  const utf8 = Buffer.from(text, "utf8").equals(bytes);
  return Object.freeze({
    encoding: utf8 ? "utf8" : "base64",
    data: utf8 ? text : bytes.toString("base64"),
    byteCount: bytes.length,
    truncated,
  });
}

function assertRegularOutput(stat: Stats): void {
  const owner = process.getuid?.();
  if (
    owner === undefined ||
    !stat.isFile() ||
    stat.uid !== owner ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size > MAX_OUTPUT_BYTES
  )
    throw new Error("sandbox output file is unsafe");
}
function sameFile(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}
