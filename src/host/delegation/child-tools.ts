/**
 * Path-confined child file tools (spec §7.4).
 *
 * These replace pi's built-in file tools for auxiliary sessions. The root is
 * the primary checkout for read-only work and the generated worktree for
 * writable work. This is a tool-policy boundary, not an OS sandbox.
 */

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const readParameters = Type.Object({ path: Type.String() });
const grepParameters = Type.Object({ pattern: Type.String(), path: Type.String() });
const findParameters = Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()) });
const lsParameters = Type.Object({ path: Type.Optional(Type.String()) });
const editParameters = Type.Object({
  path: Type.String(),
  oldText: Type.String(),
  newText: Type.String(),
});
const writeParameters = Type.Object({ path: Type.String(), content: Type.String() });

type ToolResult = {
  readonly content: { readonly type: "text"; readonly text: string }[];
  readonly details: Record<string, never>;
  readonly terminate: false;
};

function text(text: string): ToolResult["content"][number] {
  return { type: "text", text };
}

function error(message: string): ToolResult {
  return { content: [text(message)], details: {}, terminate: false };
}

function confinedPath(
  root: string,
  requested: string,
): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string } {
  const rootPath = resolve(root);
  const target = resolve(rootPath, requested);
  const escaped = relative(rootPath, target);
  if (escaped === ".." || escaped.startsWith(`..${sep}`) || escaped.startsWith(sep)) {
    return { ok: false, reason: `Path "${requested}" escapes the confined workspace` };
  }
  // Reject traversal syntax even when a caller happens to resolve it back
  // inside the root. This keeps the child contract unambiguous.
  if (requested.split(/[\\/]/u).some((segment) => segment === "..")) {
    return { ok: false, reason: `Path "${requested}" contains a traversal segment` };
  }
  return { ok: true, path: target };
}

function pathFrom(
  params: { readonly path?: unknown },
  root: string,
):
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly result: ToolResult } {
  if (typeof params.path !== "string" || params.path.length === 0) {
    return { ok: false, result: error("path must be a non-empty string") };
  }
  const checked = confinedPath(root, params.path);
  return checked.ok ? checked : { ok: false, result: error(checked.reason) };
}

/** Build the confined file tools for one child workspace. */
export function buildConfinedTools(workspace: "read_only" | "worktree", root: string) {
  const tools = [
    createReadTool(root),
    createGrepTool(root),
    createFindTool(root),
    createLsTool(root),
  ];
  if (workspace === "worktree") {
    tools.push(createEditTool(root), createWriteTool(root));
  }
  return tools;
}

function createReadTool(root: string) {
  return defineTool({
    name: "read",
    label: "read",
    description: "Read a file inside the child workspace.",
    parameters: readParameters,
    execute: async (_id, params) => {
      const checked = pathFrom(params, root);
      if (!checked.ok) return checked.result;
      try {
        return {
          content: [text(await readFile(checked.path, "utf8"))],
          details: {},
          terminate: false,
        };
      } catch (cause: unknown) {
        return error(`read failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    },
  });
}

function createGrepTool(root: string) {
  return defineTool({
    name: "grep",
    label: "grep",
    description: "Search a file inside the child workspace.",
    parameters: grepParameters,
    execute: async (_id, params) => {
      const checked = pathFrom(params, root);
      if (!checked.ok) return checked.result;
      if (params.pattern.length === 0) return error("pattern must be non-empty");
      let pattern: RegExp;
      try {
        pattern = new RegExp(params.pattern, "u");
      } catch (cause: unknown) {
        return error(
          `invalid regular expression: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      try {
        const lines = (await readFile(checked.path, "utf8")).split("\n");
        const matches = lines.flatMap((line, index) =>
          pattern.test(line) ? [`${index + 1}: ${line}`] : [],
        );
        return {
          content: [text(matches.length > 0 ? matches.join("\n") : "(no matches)")],
          details: {},
          terminate: false,
        };
      } catch (cause: unknown) {
        return error(`grep failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    },
  });
}

function createFindTool(root: string) {
  return defineTool({
    name: "find",
    label: "find",
    description: "Find files inside the child workspace.",
    parameters: findParameters,
    execute: async (_id, params) => {
      if (params.pattern.length === 0) return error("pattern must be non-empty");
      const checked = pathFrom({ path: params.path ?? "." }, root);
      if (!checked.ok) return checked.result;
      try {
        const files = await findFiles(root, checked.path, params.pattern);
        return {
          content: [text(files.length > 0 ? files.join("\n") : "(no matches)")],
          details: {},
          terminate: false,
        };
      } catch (cause: unknown) {
        return error(`find failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    },
  });
}

async function findFiles(root: string, directory: string, pattern: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await findFiles(root, child, pattern)));
    else if (entry.name.includes(pattern)) output.push(relative(resolve(root), child));
  }
  return output;
}

function createLsTool(root: string) {
  return defineTool({
    name: "ls",
    label: "ls",
    description: "List a directory inside the child workspace.",
    parameters: lsParameters,
    execute: async (_id, params) => {
      const checked = pathFrom({ path: params.path ?? "." }, root);
      if (!checked.ok) return checked.result;
      try {
        const info = await stat(checked.path);
        if (!info.isDirectory()) return error("path is not a directory");
        const entries = await readdir(checked.path);
        return {
          content: [text(entries.length > 0 ? entries.join("\n") : "(empty)")],
          details: {},
          terminate: false,
        };
      } catch (cause: unknown) {
        return error(`ls failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    },
  });
}

function createEditTool(root: string) {
  return defineTool({
    name: "edit",
    label: "edit",
    description: "Replace text in a file inside the child worktree.",
    parameters: editParameters,
    execute: async (_id, params) => {
      const checked = pathFrom(params, root);
      if (!checked.ok) return checked.result;
      try {
        const original = await readFile(checked.path, "utf8");
        const occurrences = original.split(params.oldText).length - 1;
        if (occurrences !== 1)
          return error(`oldText must occur exactly once; found ${occurrences}`);
        await writeFile(checked.path, original.replace(params.oldText, params.newText), "utf8");
        return { content: [text("edited")], details: {}, terminate: false };
      } catch (cause: unknown) {
        return error(`edit failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    },
  });
}

function createWriteTool(root: string) {
  return defineTool({
    name: "write",
    label: "write",
    description: "Write a file inside the child worktree.",
    parameters: writeParameters,
    execute: async (_id, params) => {
      const checked = pathFrom(params, root);
      if (!checked.ok) return checked.result;
      try {
        await writeFile(checked.path, params.content, "utf8");
        return { content: [text("written")], details: {}, terminate: false };
      } catch (cause: unknown) {
        return error(`write failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    },
  });
}
