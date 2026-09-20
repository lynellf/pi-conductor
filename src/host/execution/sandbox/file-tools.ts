/** Descriptor-anchored sandbox file tools sharing the child operation gate (#106 §4). */
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { ChildToolName } from "../../../manifest/subagent-tool-policy.js";
import type { SandboxAdmissionRecord } from "../../../persistence/sandbox-admission.js";
import type { SandboxProjectMaterializationDescriptor } from "../../../persistence/sandbox-materialization.js";
import type { SandboxOperationGate } from "./operation-gate.js";
import {
  findProjectFiles,
  grepProjectFiles,
  SandboxSearchWorkerTerminationError,
} from "./project-file-search.js";
import { type SandboxProjectFileView, withSandboxProjectFileView } from "./project-file-view.js";
import { verifySandboxProjectBase } from "./project-materialization.js";

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 64 * 1024;
const DEFAULT_READ_LINES = 2_000;
const MAX_RESULTS = 1_000;
const readSchema = Type.Object(
  {
    path: Type.String(),
    offset: Type.Optional(Type.Integer()),
    limit: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
);
const writeSchema = Type.Object(
  { path: Type.String(), content: Type.String() },
  { additionalProperties: false },
);
const editSchema = Type.Object(
  {
    path: Type.String(),
    edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
  },
  { additionalProperties: false },
);
const lsSchema = Type.Object(
  {
    path: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
);
const findSchema = Type.Object(
  {
    pattern: Type.String(),
    path: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
);
const grepSchema = Type.Object(
  {
    pattern: Type.String(),
    path: Type.Optional(Type.String()),
    glob: Type.Optional(Type.String()),
    ignoreCase: Type.Optional(Type.Boolean()),
    literal: Type.Optional(Type.Boolean()),
    context: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
    limit: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
);
/** Inputs bound to one admitted child; no caller-provided filesystem root exists. */
export interface SandboxFileToolsOptions {
  readonly gate: SandboxOperationGate;
  readonly admission: SandboxAdmissionRecord;
  readonly project: SandboxProjectMaterializationDescriptor;
  readonly runStateDir: string;
  /** Exact file subset for configured child authority; omitted means all six files. */
  readonly effectiveTools?: readonly ChildToolName[];
}
type ProjectWork<T> = (view: SandboxProjectFileView, signal: AbortSignal) => Promise<T>;
/** Build the six `/workspace` tools backed only by private descriptor-anchored trees. */
export function createSandboxFileTools(
  options: SandboxFileToolsOptions,
): readonly ToolDefinition[] {
  const gate = options.gate;
  const admission = structuredClone(options.admission);
  const project = structuredClone(options.project);
  const runStateDir = options.runStateDir;
  const run = async <T>(signal: AbortSignal | undefined, work: ProjectWork<T>): Promise<T> => {
    const caller = signal ?? new AbortController().signal;
    return gate.run(caller, async (gateSignal) => {
      try {
        const verifiedProject = await verifySandboxProjectBase(project, {
          admission,
          runStateDir,
          expectedRunId: gate.owner.runId,
          expectedChildId: gate.owner.childId,
        });
        abort(gateSignal);
        const result = await withSandboxProjectFileView(
          verifiedProject.basePath,
          verifiedProject.writablePath,
          admission.policy.writableRoots,
          (view) => work(view, gateSignal),
        );
        abort(gateSignal);
        return result;
      } catch (cause) {
        if (cause instanceof SandboxSearchWorkerTerminationError) gate.seal(cause);
        throw cause;
      }
    });
  };
  const tools = [
    defineTool({
      name: "read",
      label: "read",
      description: "Read a file in /workspace.",
      parameters: readSchema,
      execute: async (_id, input: Static<typeof readSchema>, signal) =>
        text(
          await run(signal, async (view) =>
            readText(
              await view.read(filePath(input.path), MAX_FILE_BYTES),
              input.offset,
              input.limit,
            ),
          ),
        ),
    }),
    defineTool({
      name: "write",
      label: "write",
      description: "Write a file in /workspace when it is authorized writable.",
      parameters: writeSchema,
      execute: async (_id, input: Static<typeof writeSchema>, signal) => {
        const path = filePath(input.path);
        const content = boundedContent(input.content);
        await run(signal, (view) => view.write(path, content));
        return text(`Wrote ${path}`);
      },
    }),
    defineTool({
      name: "edit",
      label: "edit",
      description: "Apply exact text edits to an authorized writable file.",
      parameters: editSchema,
      execute: async (_id, input: Static<typeof editSchema>, signal) => {
        const path = filePath(input.path);
        await run(signal, async (view) =>
          view.write(
            path,
            boundedContent(
              applyEdits((await view.read(path, MAX_FILE_BYTES)).toString("utf8"), input.edits),
            ),
          ),
        );
        return text(`Edited ${path}`);
      },
    }),
    defineTool({
      name: "ls",
      label: "ls",
      description: "List files in /workspace.",
      parameters: lsSchema,
      execute: async (_id, input: Static<typeof lsSchema>, signal) =>
        text(
          (
            await run(signal, async (view) =>
              list(await view.files(), directoryPath(input.path), resultLimit(input.limit)),
            )
          ).join("\n") || "No files",
        ),
    }),
    defineTool({
      name: "find",
      label: "find",
      description: "Find files in /workspace by glob.",
      parameters: findSchema,
      execute: async (_id, input: Static<typeof findSchema>, signal) =>
        text(
          (
            await run(signal, async (view, gateSignal) =>
              findProjectFiles(
                view,
                directoryPath(input.path),
                input.pattern,
                resultLimit(input.limit),
                gateSignal,
              ),
            )
          ).join("\n") || "No files found matching pattern",
        ),
    }),
    defineTool({
      name: "grep",
      label: "grep",
      description: "Search file contents in /workspace with bounded regex evaluation.",
      parameters: grepSchema,
      execute: async (_id, input: Static<typeof grepSchema>, signal) =>
        text(
          (
            await run(signal, async (view, gateSignal) =>
              grep(await view.files(), view, input, gateSignal),
            )
          ).join("\n") || "No matches found",
        ),
    }),
  ] as ToolDefinition[];
  return options.effectiveTools === undefined
    ? tools
    : tools.filter((tool) => options.effectiveTools?.includes(tool.name as ChildToolName));
}

function abort(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("sandbox operation aborted");
}
function text(value: string) {
  return { content: [{ type: "text" as const, text: value }], details: {} };
}
function filePath(path: string): string {
  if (path === "/workspace") throw new Error("sandbox path must name a file");
  if (path.startsWith("/workspace/")) path = path.slice("/workspace/".length);
  if (!valid(path)) throw new Error("sandbox path must be a non-empty relative literal path");
  return path;
}
function directoryPath(path: string | undefined): string {
  if (path === undefined || path === ".") return "";
  return filePath(path);
}
function valid(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 4096 &&
    !/[\\\0]/.test(path) &&
    path
      .split("/")
      .every(
        (part) =>
          part !== "" &&
          part !== "." &&
          part !== ".." &&
          part !== ".git" &&
          part !== ".pi-conductor",
      )
  );
}
function under(path: string, directory: string): boolean {
  return directory === "" || path === directory || path.startsWith(`${directory}/`);
}
function resultLimit(value: number | undefined): number {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
    throw new Error("limit must be a positive integer");
  return Math.min(value ?? MAX_RESULTS, MAX_RESULTS);
}
function readText(bytes: Buffer, offset: number | undefined, limit: number | undefined): string {
  const start = offset === undefined ? 1 : checkedLine(offset);
  const count = limit === undefined ? DEFAULT_READ_LINES : checkedLine(limit);
  const lines = bytes.toString("utf8").split(/\r?\n/);
  const selected = lines.slice(start - 1, start - 1 + count).join("\n");
  return preview(selected, start - 1 + count < lines.length);
}
function checkedLine(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("line values must be positive integers");
  return value;
}
function list(
  files: readonly { readonly path: string }[],
  directory: string,
  limit: number,
): readonly string[] {
  const entries = new Set<string>();
  for (const file of files)
    if (under(file.path, directory)) {
      const rest = directory === "" ? file.path : file.path.slice(directory.length + 1);
      entries.add(rest.split("/")[0] ?? rest);
    }
  return [...entries].sort().slice(0, limit);
}
function applyEdits(
  content: string,
  edits: readonly { readonly oldText: string; readonly newText: string }[],
): string {
  const changes = edits
    .map((edit) => {
      const at = content.indexOf(edit.oldText);
      if (edit.oldText.length === 0 || at < 0 || content.indexOf(edit.oldText, at + 1) >= 0)
        throw new Error("each edit oldText must occur exactly once");
      return { ...edit, at };
    })
    .sort((a, b) => b.at - a.at);
  for (let index = 1; index < changes.length; index++)
    if (
      (changes[index]?.at ?? 0) + (changes[index]?.oldText.length ?? 0) >
      (changes[index - 1]?.at ?? 0)
    )
      throw new Error("edits must not overlap");
  return changes.reduce(
    (result, change) =>
      `${result.slice(0, change.at)}${change.newText}${result.slice(change.at + change.oldText.length)}`,
    content,
  );
}
async function grep(
  files: readonly { readonly path: string }[],
  view: { read(path: string, maxBytes: number): Promise<Buffer> },
  input: Static<typeof grepSchema>,
  signal: AbortSignal,
): Promise<readonly string[]> {
  if (
    input.context !== undefined &&
    (!Number.isSafeInteger(input.context) || input.context < 0 || input.context > 100)
  )
    throw new Error("grep context must be an integer from 0 through 100");
  const directory = directoryPath(input.path);
  return grepProjectFiles(view, files, directory, input, resultLimit(input.limit), signal);
}

function boundedContent(content: string): Buffer {
  const bytes = Buffer.from(content);
  if (bytes.length > MAX_FILE_BYTES) throw new Error("sandbox file exceeds 67108864 bytes");
  return bytes;
}

function preview(value: string, omittedLines: boolean): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= MAX_PREVIEW_BYTES && !omittedLines) return value;
  const notice = omittedLines
    ? "\n[preview truncated after 2000 lines or 65536 bytes]"
    : "\n[preview truncated at 65536 bytes]";
  const available = MAX_PREVIEW_BYTES - Buffer.byteLength(notice);
  let body = bytes.subarray(0, available).toString("utf8");
  while (Buffer.byteLength(body) > available) body = body.slice(0, -1);
  return `${body}${notice}`;
}
