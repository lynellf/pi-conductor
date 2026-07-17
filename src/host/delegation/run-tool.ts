/** Path-confined child file tools — delegation lite §6. */

import { realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import {
  type AgentToolResult,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";

/** Context used to build a confined child tool surface. */
export interface ChildToolOptions {
  readonly worktreePath: string;
}

/** The only built-in tool names enabled for a child SDK session (§6). */
export const CHILD_FILE_TOOL_NAMES = ["read", "grep", "find", "ls", "edit", "write"] as const;

/** Build the child file tools, all confined to its generated worktree (§6). */
export function buildChildTools(opts: ChildToolOptions): ToolDefinition[] {
  const root = resolve(opts.worktreePath);
  const tools = [
    confinePathTool(createReadToolDefinition(root), root),
    confinePathTool(createGrepToolDefinition(root), root),
    confinePathTool(createFindToolDefinition(root), root),
    confinePathTool(createLsToolDefinition(root), root),
    confinePathTool(createEditToolDefinition(root), root),
    confinePathTool(createWriteToolDefinition(root), root),
  ];
  // The SDK's `customTools` boundary erases each definition's parameter
  // schema. Preserve the factories' precise types above, then erase only here.
  return tools as unknown as ToolDefinition[];
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function hasTraversal(value: string): boolean {
  return value.split(/[\\/]/).includes("..");
}

function isWithinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function confinePathTool<TParams extends TSchema, TDetails, TState>(
  tool: ToolDefinition<TParams, TDetails, TState>,
  root: string,
): ToolDefinition<TParams, TDetails, TState> {
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const path = (params as Static<TParams> & { path?: unknown }).path;
      const failure = await validateChildPath(path, root);
      if (failure !== null) return fileToolError<TDetails>(failure);
      return tool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

async function validateChildPath(path: unknown, root: string): Promise<string | null> {
  if (path !== undefined && typeof path !== "string") {
    return "path must be a string inside the child worktree";
  }
  const requested = path ?? ".";
  if (isAbsolutePath(requested) || requested.startsWith("~") || hasTraversal(requested)) {
    return "path must be relative and inside the child worktree";
  }

  const rootReal = await realpath(root);
  let candidate = resolve(rootReal, requested);
  if (!isWithinRoot(candidate, rootReal)) {
    return "path must be inside the child worktree";
  }

  for (;;) {
    try {
      const resolved = await realpath(candidate);
      return isWithinRoot(resolved, rootReal) ? null : "path resolves outside the child worktree";
    } catch (cause) {
      if (!isNotFound(cause)) throw cause;
      const parent = dirname(candidate);
      if (parent === candidate) return "path must be inside the child worktree";
      candidate = parent;
    }
  }
}

function isNotFound(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

function fileToolError<TDetails>(text: string): AgentToolResult<TDetails> {
  return {
    content: [{ type: "text" as const, text }],
    details: undefined as TDetails,
    terminate: false,
  };
}
