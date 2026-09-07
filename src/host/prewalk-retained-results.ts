/** Collect paired, whole text read/search results from durable guide history (Prewalk §R7). */
import { relative, resolve } from "node:path";
import type { PrewalkRetainedToolResult } from "./prewalk-projection.js";
import type { PrewalkDeliveryEntry } from "./prewalk-seed-delivery.js";

type ToolName = PrewalkRetainedToolResult["tool_name"];
interface ReadCall {
  readonly name: ToolName;
  readonly path: string;
}

/** Resolve workspace references without reading current files or replaying guide calls. */
export function collectPrewalkRetainedToolResults(
  entries: readonly PrewalkDeliveryEntry[],
  cwd: string,
): readonly PrewalkRetainedToolResult[] {
  const calls = new Map<string, ReadCall>();
  const seenIds = new Set<string>();
  const duplicates = new Set<string>();
  const results: PrewalkRetainedToolResult[] = [];
  for (const [index, entry] of entries.entries()) {
    const message = object(entry.message);
    if (message === null) continue;
    if (
      message.role === "assistant" &&
      message.stopReason !== "error" &&
      message.stopReason !== "aborted" &&
      Array.isArray(message.content)
    ) {
      for (const raw of message.content) {
        const call = object(raw);
        if (call?.type !== "toolCall" || typeof call.id !== "string") continue;
        if (seenIds.has(call.id)) {
          duplicates.add(call.id);
          calls.delete(call.id);
          continue;
        }
        seenIds.add(call.id);
        if (!retainable(call.name)) continue;
        const args = object(call.arguments);
        if (args === null || (args.path !== undefined && typeof args.path !== "string")) continue;
        if (call.name === "read" && typeof args.path !== "string") continue;
        const path = workspacePath(cwd, typeof args.path === "string" ? args.path : ".");
        if (path !== null) calls.set(call.id, { name: call.name, path });
      }
    }
    if (message.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
    const call = calls.get(message.toolCallId);
    calls.delete(message.toolCallId);
    if (call === undefined || message.toolName !== call.name || message.isError === true) continue;
    const text = wholeText(message.content);
    if (text === null) continue; // Never turn an image/mixed result into a misleading partial read.
    const paths = referencedPaths(call, text, cwd);
    if (paths === null) continue; // A result referencing outside the workspace is not eligible.
    results.push({
      tool_call_id: message.toolCallId,
      tool_name: call.name,
      referenced_paths: paths,
      content: text,
      ts: index,
    });
  }
  return results.filter((result) => !duplicates.has(result.tool_call_id));
}

function referencedPaths(call: ReadCall, text: string, cwd: string): readonly string[] | null {
  if (call.name === "read") return [call.path];
  const paths = new Set([call.path]);
  // Pi 0.80.6 tools/grep.js emits path:line: text / path-line- context;
  // find.js and ls.js emit one path per line relative to the requested root.
  for (const line of text.split("\n")) {
    const target = call.name === "grep" ? /^(.*?)(?::\d+:|-\d+-) /u.exec(line)?.[1] : line;
    if (!target || target.startsWith("[")) continue;
    const path = workspacePath(cwd, resolve(cwd, call.path, target));
    if (path === null) return null;
    paths.add(path);
  }
  return [...paths];
}

function wholeText(content: unknown): string | null {
  if (!Array.isArray(content) || content.length === 0) return null;
  const texts: string[] = [];
  for (const item of content) {
    const block = object(item);
    if (block?.type !== "text" || typeof block.text !== "string") return null;
    texts.push(block.text);
  }
  return texts.join("\n");
}

function workspacePath(cwd: string, path: string): string | null {
  if (path.startsWith("~") || path.includes("\0")) return null;
  const normalized = relative(cwd, resolve(cwd, path));
  return normalized === ".." || normalized.startsWith("../") ? null : normalized || ".";
}

function retainable(name: unknown): name is ToolName {
  return name === "read" || name === "grep" || name === "find" || name === "ls";
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
