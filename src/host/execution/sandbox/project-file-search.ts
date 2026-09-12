/** Bounded captured-data search coordination; worker settlement remains inside the caller gate. */

import { Worker } from "node:worker_threads";
import { Value } from "typebox/value";
import {
  type ProjectFileSearchRequest,
  projectFileSearchRequestSchema,
  projectFileSearchResponseSchema,
} from "./project-file-search-contract.js";

const MAX_SEARCH_BYTES = 16 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 500;

export interface SearchFileView {
  readonly files: () => Promise<readonly { readonly path: string }[]>;
  readonly read: (path: string, maxBytes: number) => Promise<Buffer>;
}
type SearchFile = ProjectFileSearchRequest["files"][number];

export async function findProjectFiles(
  view: SearchFileView,
  directory: string,
  pattern: string,
  limit: number,
  signal: AbortSignal,
): Promise<readonly string[]> {
  const files = (await view.files())
    .filter((file) => under(file.path, directory))
    .map((file) => ({
      path: file.path,
      matchPath: directory === "" ? file.path : file.path.slice(directory.length + 1),
      text: "",
    }));
  return run({ kind: "find", files, pattern, limit }, signal);
}
export async function grepProjectFiles(
  view: Pick<SearchFileView, "read">,
  files: readonly { readonly path: string }[],
  directory: string,
  input: {
    readonly pattern: string;
    readonly ignoreCase?: boolean;
    readonly literal?: boolean;
    readonly glob?: string;
    readonly context?: number;
  },
  limit: number,
  signal: AbortSignal,
): Promise<readonly string[]> {
  const captured = await capture(
    view,
    files.filter((file) => under(file.path, directory)),
  );
  return run(
    {
      kind: "grep",
      files: captured,
      pattern: input.pattern,
      ignoreCase: input.ignoreCase === true,
      literal: input.literal === true,
      context: input.context ?? 0,
      ...(input.glob === undefined ? {} : { glob: input.glob }),
      limit,
    },
    signal,
  );
}
async function capture(
  view: Pick<SearchFileView, "read">,
  files: readonly { readonly path: string }[],
): Promise<SearchFile[]> {
  let size = 0;
  const captured: SearchFile[] = [];
  for (const file of files) {
    if (size === MAX_SEARCH_BYTES) throw new Error("sandbox search input exceeds 16777216 bytes");
    const bytes = await view.read(file.path, MAX_SEARCH_BYTES - size);
    size += bytes.length;
    if (size > MAX_SEARCH_BYTES) throw new Error("sandbox search input exceeds 16777216 bytes");
    captured.push({ path: file.path, matchPath: file.path, text: bytes.toString("utf8") });
  }
  return captured;
}
async function run(
  request: ProjectFileSearchRequest,
  signal: AbortSignal,
): Promise<readonly string[]> {
  if (signal.aborted) throw new Error("sandbox operation aborted");
  if (!Value.Check(projectFileSearchRequestSchema, request))
    throw new Error("sandbox search request violated its internal contract");
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  const worker = new Worker(new URL(`./project-file-search-worker${extension}`, import.meta.url), {
    workerData: request,
    execArgv: [],
  });
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = async (value: readonly string[] | Error): Promise<void> => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      try {
        await worker.terminate();
      } catch (cause) {
        reject(new SandboxSearchWorkerTerminationError(cause));
        return;
      }
      value instanceof Error ? reject(value) : resolve(value);
    };
    const onAbort = (): void => {
      void finish(new Error("sandbox operation aborted"));
    };
    const timer = setTimeout(() => {
      void finish(new Error("sandbox search exceeded 500ms"));
    }, SEARCH_TIMEOUT_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      void finish(new Error("sandbox operation aborted"));
      return;
    }
    worker.once("message", (value: unknown) => {
      if (!Value.Check(projectFileSearchResponseSchema, value)) {
        void finish(new Error("sandbox search worker returned an invalid result"));
        return;
      }
      void finish(Array.isArray(value) ? value : new Error(value.error));
    });
    worker.once("error", (cause) => {
      void finish(cause);
    });
    worker.once("exit", (code) => {
      if (!done) void finish(new Error(`sandbox search worker exited without a result (${code})`));
    });
  });
}

/** A failed worker termination leaves its filesystem-operation lifetime unknown. */
export class SandboxSearchWorkerTerminationError extends Error {
  constructor(cause: unknown) {
    super("sandbox search worker did not terminate", { cause });
    this.name = "SandboxSearchWorkerTerminationError";
  }
}
function under(path: string, directory: string): boolean {
  return directory === "" || path === directory || path.startsWith(`${directory}/`);
}
