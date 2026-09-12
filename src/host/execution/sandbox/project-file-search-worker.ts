/** Isolated bounded regex/glob search worker; receives captured bytes only (#106 §4). */

import { parentPort, workerData } from "node:worker_threads";
import { Value } from "typebox/value";
import type {
  ProjectFileSearchRequest,
  ProjectFileSearchResponse,
} from "./project-file-search-contract.js";

const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
const contract: typeof import("./project-file-search-contract.js") = await import(
  `./project-file-search-contract${extension}`
);
const { projectFileSearchRequestSchema, projectFileSearchResponseSchema } = contract;

type FindRequest = Extract<ProjectFileSearchRequest, { kind: "find" }>;
type GrepRequest = Extract<ProjectFileSearchRequest, { kind: "grep" }>;

const port = parentPort;
if (port === null) throw new Error("sandbox search worker requires a message port");

try {
  if (!Value.Check(projectFileSearchRequestSchema, workerData))
    throw new Error("sandbox search worker received an invalid request");
  const request = Value.Parse(projectFileSearchRequestSchema, workerData);
  post(request.kind === "find" ? find(request) : grep(request));
} catch (cause) {
  post({ error: cause instanceof Error ? cause.message : "sandbox search failed" });
}

function post(response: ProjectFileSearchResponse): void {
  if (!Value.Check(projectFileSearchResponseSchema, response))
    throw new Error("sandbox search worker produced an invalid response");
  port?.postMessage(response);
}

function find(request: FindRequest): string[] {
  return request.files
    .filter((file) => glob(request.pattern, file.matchPath))
    .slice(0, request.limit)
    .map((file) => file.path);
}

function grep(request: GrepRequest): string[] {
  const expression = request.literal
    ? undefined
    : new RegExp(request.pattern, request.ignoreCase ? "i" : "");
  const needle = request.ignoreCase ? request.pattern.toLowerCase() : request.pattern;
  const result: string[] = [];
  const emitted = new Set<string>();
  for (const file of request.files) {
    if (request.glob !== undefined && !glob(request.glob, file.matchPath)) continue;
    const lines = file.text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? "";
      const matches =
        expression === undefined
          ? (request.ignoreCase ? line.toLowerCase() : line).includes(needle)
          : expression.test(line);
      if (matches) {
        const first = Math.max(0, index - request.context);
        const last = Math.min(lines.length - 1, index + request.context);
        for (let contextIndex = first; contextIndex <= last; contextIndex++) {
          const key = `${file.path}:${contextIndex}`;
          if (emitted.has(key)) continue;
          emitted.add(key);
          const separator = contextIndex === index ? ":" : "-";
          result.push(`${file.path}:${contextIndex + 1}${separator}${lines[contextIndex] ?? ""}`);
          if (result.length >= request.limit) return boundOutput(result);
        }
      }
    }
  }
  return boundOutput(result);
}

function glob(pattern: string, path: string): boolean {
  return matchSegments(pattern.split("/"), path.split("/"), 0, 0);
}

function matchSegments(
  pattern: readonly string[],
  path: readonly string[],
  patternIndex: number,
  pathIndex: number,
): boolean {
  if (patternIndex === pattern.length) return pathIndex === path.length;
  if (pattern[patternIndex] === "**")
    return (
      matchSegments(pattern, path, patternIndex + 1, pathIndex) ||
      (pathIndex < path.length && matchSegments(pattern, path, patternIndex, pathIndex + 1))
    );
  return (
    pathIndex < path.length &&
    matchSegment(pattern[patternIndex] ?? "", path[pathIndex] ?? "") &&
    matchSegments(pattern, path, patternIndex + 1, pathIndex + 1)
  );
}

function matchSegment(pattern: string, value: string): boolean {
  let row = Array.from({ length: value.length + 1 }, (_, index) => index === 0);
  for (const token of pattern) {
    const next = [row[0] === true && token === "*"];
    for (let index = 1; index <= value.length; index++)
      next.push(
        token === "*"
          ? next[index - 1] === true || row[index] === true
          : row[index - 1] === true && (token === "?" || token === value[index - 1]),
      );
    row = next;
  }
  return row[value.length] === true;
}

function boundOutput(lines: readonly string[]): string[] {
  const maximum = 64 * 1024;
  const notice = "[output truncated at 65536 bytes]";
  if (Buffer.byteLength(lines.join("\n")) <= maximum) return [...lines];
  const result: string[] = [];
  let used = Buffer.byteLength(notice) + 1;
  for (const line of lines) {
    const bytes = Buffer.byteLength(line) + (result.length === 0 ? 0 : 1);
    if (used + bytes > maximum) break;
    result.push(line);
    used += bytes;
  }
  result.push(notice);
  return result;
}
