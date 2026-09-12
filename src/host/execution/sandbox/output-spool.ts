/** Bounded private command-output capture for Issue #106 §7. */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { Value } from "typebox/value";
import {
  type SandboxOutputAttribution,
  type SandboxOutputFinalRecord,
  sandboxOutputAttributionSchema,
  sandboxOutputFinalRecordSchema,
} from "../../../persistence/sandbox-output.js";
import {
  assertPrivateAdmissionDirectory,
  syncAdmissionDirectoryChain,
} from "./admission-metadata.js";
import { writeOutputMetadata } from "./output-metadata.js";
import {
  type ObservedSandboxOutput,
  SandboxOutputCaptureState,
  type SandboxOutputFile,
  type SandboxOutputPreview,
  SandboxOutputWritable,
} from "./output-stream.js";
import { canonicalTrustedSnapshotParent } from "./runtime-capture.js";

export type { SandboxOutputFile, SandboxOutputPreview } from "./output-stream.js";

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 64 * 1024;

/** Inputs for one execution-owned private output spool. */
export interface CreateSandboxOutputSpoolOptions {
  readonly runStateDir: string;
  readonly runId: string;
  readonly childId: string;
  readonly executionId: string;
  readonly supervisionId: string;
  readonly maxBytes: number;
  readonly previewBytes?: number;
  /** Fault-injection seam; production callers omit it. */
  readonly testWrapFile?: (
    file: SandboxOutputFile,
    stream: "stdout" | "stderr",
  ) => SandboxOutputFile;
  /** Fault-injection seam; production callers omit it. */
  readonly testWriteMetadata?: typeof writeOutputMetadata;
}

/** Presentation previews for both output streams. */
export interface SandboxOutputPreviews {
  readonly stdout: SandboxOutputPreview;
  readonly stderr: SandboxOutputPreview;
}

/** Durable settlement failed; retained files remain bound to this opaque reference. */
export class SandboxOutputPersistenceError extends Error {
  constructor(
    readonly outputRef: string,
    readonly retainedByteCounts: Readonly<{ stdout: number; stderr: number }>,
    options: ErrorOptions,
  ) {
    super("sandbox output settlement could not be persisted", options);
    this.name = "SandboxOutputPersistenceError";
  }
}

/** Output handle returned before spawn and settled after both pipes drain. */
export interface SandboxOutputSpool {
  readonly outputRef: string;
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly attribution: SandboxOutputAttribution;
  readonly captureFailure: Promise<"cap" | "storage">;
  readonly finalize: () => Promise<SandboxOutputFinalRecord>;
  readonly previews: () => SandboxOutputPreviews;
}

/** Create private output files and persist immutable owner attribution. */
export async function createSandboxOutputSpool(
  options: CreateSandboxOutputSpoolOptions,
): Promise<SandboxOutputSpool> {
  assertBound(options.maxBytes, 1, MAX_OUTPUT_BYTES, "output cap");
  const previewLimit = options.previewBytes ?? MAX_PREVIEW_BYTES;
  assertBound(previewLimit, 0, MAX_PREVIEW_BYTES, "preview bound");
  const outputRef = randomUUID();
  const attribution: SandboxOutputAttribution = Object.freeze({
    schemaVersion: 1,
    outputRef,
    runId: options.runId,
    childId: options.childId,
    executionId: options.executionId,
    supervisionId: options.supervisionId,
    maxBytes: options.maxBytes,
  });
  if (!Value.Check(sandboxOutputAttributionSchema, attribution))
    throw new Error("sandbox output attribution is not persistable");

  const runState = await canonicalTrustedSnapshotParent(options.runStateDir);
  const root = join(runState, "sandbox-output");
  await createPrivateDirectory(root);
  const directory = join(root, outputRef);
  await mkdir(directory, { mode: 0o700 });
  const writeMetadata = options.testWriteMetadata ?? writeOutputMetadata;
  let stdoutHandle: FileHandle | undefined;
  let stderrHandle: FileHandle | undefined;
  try {
    await assertPrivateAdmissionDirectory(directory);
    stdoutHandle = await createOutputFile(join(directory, "stdout.bin"));
    stderrHandle = await createOutputFile(join(directory, "stderr.bin"));
    await writeMetadata(join(directory, "attribution.json"), attribution);
    await syncAdmissionDirectoryChain(directory, root, runState);
    const state = new SandboxOutputCaptureState(options.maxBytes);
    const stdout = new SandboxOutputWritable(
      options.testWrapFile?.(adapt(stdoutHandle), "stdout") ?? adapt(stdoutHandle),
      state,
    );
    const stderr = new SandboxOutputWritable(
      options.testWrapFile?.(adapt(stderrHandle), "stderr") ?? adapt(stderrHandle),
      state,
    );
    stdoutHandle = undefined;
    stderrHandle = undefined;
    let previewResult: SandboxOutputPreviews | undefined;
    let finalized: Promise<SandboxOutputFinalRecord> | undefined;
    return {
      outputRef,
      stdout,
      stderr,
      attribution,
      captureFailure: state.captureFailure,
      finalize: () =>
        (finalized ??= settleOutput(
          directory,
          outputRef,
          stdout,
          stderr,
          state,
          previewLimit,
          writeMetadata,
          (previews) => {
            previewResult = previews;
          },
        )),
      previews: () => {
        if (previewResult === undefined) throw new Error("sandbox output is not finalized");
        return previewResult;
      },
    };
  } catch (cause) {
    await Promise.allSettled([stdoutHandle?.close(), stderrHandle?.close()]);
    throw cause;
  }
}

async function settleOutput(
  directory: string,
  outputRef: string,
  stdout: SandboxOutputWritable,
  stderr: SandboxOutputWritable,
  state: SandboxOutputCaptureState,
  previewLimit: number,
  writeMetadata: typeof writeOutputMetadata,
  publishPreviews: (previews: SandboxOutputPreviews) => void,
): Promise<SandboxOutputFinalRecord> {
  try {
    await Promise.all([finished(stdout), finished(stderr)]);
  } catch {
    state.fail("storage");
  }
  const [stdoutInitial, stderrInitial] = await Promise.all([
    stdout.observe(previewLimit),
    stderr.observe(previewLimit),
  ]);
  const [stdoutClosed, stderrClosed] = await Promise.all([stdout.closeFile(), stderr.closeFile()]);
  const stdoutObserved = withCloseConfidence(stdoutInitial, stdoutClosed);
  const stderrObserved = withCloseConfidence(stderrInitial, stderrClosed);
  const streamRecord = (value: ObservedSandboxOutput) =>
    value.retainedVerified
      ? { byteCount: value.byteCount, retainedVerified: true as const, sha256: value.sha256 }
      : { byteCount: value.byteCount, retainedVerified: false as const };
  const complete =
    state.failure === undefined &&
    stdoutObserved.retainedVerified &&
    stderrObserved.retainedVerified;
  const record = {
    schemaVersion: 1 as const,
    outputRef,
    capture: complete ? ("complete" as const) : ("incomplete" as const),
    ...(!complete && { failure: { category: state.failure ?? ("storage" as const) } }),
    stdout: streamRecord(stdoutObserved),
    stderr: streamRecord(stderrObserved),
  };
  if (!Value.Check(sandboxOutputFinalRecordSchema, record))
    throw new Error("sandbox output settlement is not persistable");
  try {
    await writeMetadata(join(directory, "final.json"), record);
  } catch (cause) {
    state.fail("storage");
    throw new SandboxOutputPersistenceError(
      outputRef,
      { stdout: stdoutObserved.byteCount, stderr: stderrObserved.byteCount },
      { cause },
    );
  }
  const persisted = Object.freeze(record) as SandboxOutputFinalRecord;
  publishPreviews(
    Object.freeze({ stdout: stdoutObserved.preview, stderr: stderrObserved.preview }),
  );
  return persisted;
}

function withCloseConfidence(
  observed: ObservedSandboxOutput,
  closed: boolean,
): ObservedSandboxOutput {
  return closed
    ? observed
    : {
        byteCount: observed.byteCount,
        retainedVerified: false,
        preview: observed.preview,
      };
}

async function createPrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
  }
  await assertPrivateAdmissionDirectory(path);
}
async function createOutputFile(path: string): Promise<FileHandle> {
  return open(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
}
function adapt(file: FileHandle): SandboxOutputFile {
  return {
    write: async (bytes, offset, length, position) => file.write(bytes, offset, length, position),
    read: async (bytes, offset, length, position) => file.read(bytes, offset, length, position),
    stat: () => file.stat(),
    sync: () => file.sync(),
    close: () => file.close(),
  };
}
function assertBound(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`${label} is invalid`);
}
