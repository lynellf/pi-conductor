/** Isolated public-SDK file-tool execution — September controls issue #76. */

import { readFileSync, realpathSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import { runSupervisedProcess, type SupervisedProcessOptions } from "./supervised-process.js";

const FILE_TOOL_NAMES = ["read", "write", "edit", "ls", "find", "grep"] as const;
const MAX_WORKER_OUTPUT_BYTES = 64 * 1024 * 1024;

const fileToolContentSchema = Type.Union([
  Type.Object({ type: Type.Literal("text"), text: Type.String() }),
  Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() }),
]);
const fileToolResultSchema = Type.Object({
  content: Type.Array(fileToolContentSchema),
  details: Type.Optional(Type.Unknown()),
  terminate: Type.Optional(Type.Boolean()),
});
type FileToolResult = Static<typeof fileToolResultSchema>;

type FileToolName = (typeof FILE_TOOL_NAMES)[number];

/** Vision metadata forwarded to the SDK's read-tool context. */
export interface FileToolWorkerModel {
  readonly input: readonly string[];
}

/** Supervision settings owned by the caller; the worker supplies executable and stdin. */
export type FileToolWorkerSupervision = Omit<
  SupervisedProcessOptions,
  "args" | "command" | "cwd" | "file" | "stdin"
>;

/** Input for one isolated public-SDK file-tool invocation. */
export interface FileToolWorkerInput {
  readonly toolName: FileToolName;
  readonly toolCallId: string;
  readonly params: unknown;
  readonly cwd: string;
  readonly model?: FileToolWorkerModel;
  readonly supervision: FileToolWorkerSupervision;
}

type WorkerErrorCode =
  | "file-tool-worker-failed"
  | "file-tool-worker-output-truncated"
  | "file-tool-worker-protocol";

/** Typed failure returned when an isolated SDK file-tool call cannot produce a result. */
export class FileToolWorkerError extends Error {
  readonly code: WorkerErrorCode;

  constructor(code: WorkerErrorCode, message: string) {
    super(message);
    this.name = "FileToolWorkerError";
    this.code = code;
  }
}

interface WorkerEnvelope {
  readonly sdkUrl: string;
  readonly toolName: FileToolName;
  readonly toolCallId: string;
  readonly params: unknown;
  readonly cwd: string;
  readonly model?: FileToolWorkerModel;
}

const FIXED_BOOTSTRAP = `
const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
try {
  const sdk = await import(input.sdkUrl);
  const factories = {
    read: sdk.createReadToolDefinition,
    write: sdk.createWriteToolDefinition,
    edit: sdk.createEditToolDefinition,
    ls: sdk.createLsToolDefinition,
    find: sdk.createFindToolDefinition,
    grep: sdk.createGrepToolDefinition,
  };
  const factory = factories[input.toolName];
  if (typeof factory !== "function") throw new Error("unsupported file tool");
  const tool = factory(input.cwd);
  const context = input.model === undefined
    ? { model: undefined }
    : { model: { input: input.model.input } };
  // The parent SDK session validates tool arguments before crossing this transport boundary.
  const result = await tool.execute(input.toolCallId, input.params, undefined, undefined, context);
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(JSON.stringify({ workerError: { code: "file-tool-worker-failed", message } }));
  process.exitCode = 1;
}
`;

function resolveSdkFromPackageExports(): string {
  const packageJsonPath = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
  if (packageJsonPath === undefined) throw new Error("Pi SDK package was not found");
  const packageRoot = dirname(realpathSync(packageJsonPath));
  const packageJson: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (typeof packageJson !== "object" || packageJson === null || !("exports" in packageJson)) {
    throw new Error("Pi SDK package has no exports map");
  }
  const exportsMap = packageJson.exports;
  if (typeof exportsMap !== "object" || exportsMap === null || !("." in exportsMap)) {
    throw new Error("Pi SDK package has no root export");
  }
  const rootExport = exportsMap["."];
  const importTarget =
    typeof rootExport === "string"
      ? rootExport
      : typeof rootExport === "object" && rootExport !== null && "import" in rootExport
        ? rootExport.import
        : undefined;
  if (typeof importTarget !== "string") throw new Error("Pi SDK root import export is missing");
  return pathToFileURL(resolve(packageRoot, importTarget)).href;
}

function isFileToolName(value: string): value is FileToolName {
  return (FILE_TOOL_NAMES as readonly string[]).includes(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedDiagnostic(value: string): string {
  const limit = 4 * 1024;
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= limit) return value;
  return `${bytes.subarray(0, limit).toString("utf8")}… [diagnostic truncated]`;
}

function parseWorkerOutput(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): FileToolResult {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new FileToolWorkerError(
      "file-tool-worker-protocol",
      `worker returned invalid JSON: ${errorMessage(error)}${stderr ? ` (${boundedDiagnostic(stderr)})` : ""}`,
    );
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "workerError" in value &&
    typeof value.workerError === "object" &&
    value.workerError !== null &&
    "message" in value.workerError &&
    typeof value.workerError.message === "string"
  ) {
    throw new FileToolWorkerError("file-tool-worker-failed", value.workerError.message);
  }
  if (exitCode !== 0) {
    throw new FileToolWorkerError(
      "file-tool-worker-failed",
      `worker exited with code ${String(exitCode)}${stderr ? `: ${boundedDiagnostic(stderr)}` : ""}`,
    );
  }
  if (!Value.Check(fileToolResultSchema, value)) {
    throw new FileToolWorkerError("file-tool-worker-protocol", "worker returned an invalid result");
  }
  return value;
}

/** Execute one of the six SDK file tools in a fresh, supervised Node worker. */
export async function runFileToolWorker(input: FileToolWorkerInput): Promise<FileToolResult> {
  if (!isFileToolName(input.toolName)) {
    throw new FileToolWorkerError("file-tool-worker-protocol", "unsupported file tool");
  }
  if (!input.cwd) throw new FileToolWorkerError("file-tool-worker-protocol", "cwd is required");

  let sdkUrl: string;
  try {
    // Node's public ESM resolver is authoritative. Vite's SSR transform omits
    // import.meta.resolve, so the local package export is a test/build fallback.
    sdkUrl =
      typeof import.meta.resolve === "function"
        ? import.meta.resolve("@earendil-works/pi-coding-agent")
        : resolveSdkFromPackageExports();
  } catch (error) {
    throw new FileToolWorkerError(
      "file-tool-worker-protocol",
      `could not resolve the public pi SDK: ${errorMessage(error)}`,
    );
  }

  let stdin: string;
  try {
    const envelope: WorkerEnvelope = {
      sdkUrl,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      params: input.params,
      cwd: input.cwd,
      ...(input.model === undefined ? {} : { model: input.model }),
    };
    stdin = JSON.stringify(envelope);
  } catch (error) {
    throw new FileToolWorkerError(
      "file-tool-worker-protocol",
      `could not encode worker input: ${errorMessage(error)}`,
    );
  }

  const result = await runSupervisedProcess({
    ...input.supervision,
    file: process.execPath,
    args: ["--input-type=module", "--eval", FIXED_BOOTSTRAP],
    stdin,
    cwd: input.cwd,
    outputLimitBytes: MAX_WORKER_OUTPUT_BYTES,
  });
  if (result.truncated) {
    throw new FileToolWorkerError(
      "file-tool-worker-output-truncated",
      "file-tool worker output exceeded the 64 MiB bound",
    );
  }
  return parseWorkerOutput(result.stdout, result.stderr, result.exitCode);
}
