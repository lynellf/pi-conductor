/**
 * Path-confined file tools for role sessions — spec §6, T4.
 *
 * Generalizes the issue #24 child confinement factory (`buildChildTools`) to
 * role sessions: built-in file tool definitions are replaced via
 * `customTools` with path-confined variants (reject absolute/`..` paths;
 * `realpath` containment check on the nearest existing ancestor).
 *
 * The key difference from the child factory:
 *   - Children are confined to a *single* worktree.
 *   - Roles are confined to a *multi-root projection* (workspace root +
 *     additional mounts), as specified in the manifest's `workspace.mounts`.
 *
 * See `tests/host/confine-tools.test.ts` for the full test suite.
 */

import { realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";

import { type Projection, type ProjectionMount, pathInProjection } from "./mounts.js";

/**
 * File tool names that can be confined for a role session.
 * Mirrors `CHILD_FILE_TOOL_NAMES` from `run-tool.ts` (issue #24) but is
 * scoped to the role surface — the role's declared `tools` determines
 * which of these are actually exposed (filtering is done by the caller).
 */
export const ROLE_FILE_TOOL_NAMES = ["read", "grep", "find", "ls", "edit", "write"] as const;

/**
 * Result of confinement factory: the set of confined tool definitions,
 * the set of tool names that will be active, and the guarantee level
 * implied by the tool set.
 */
export interface ConfinedToolsResult {
  /** Confined tool definitions to pass as `customTools` to `createAgentSession`. */
  readonly tools: ToolDefinition[];
  /** Active tool names after confinement (subset of the role's declared tools). */
  readonly activeNames: readonly string[];
  /** Whether the tool set is read-only (no edit/write — spec §6: read-only role). */
  readonly isReadOnly: boolean;
}

/**
 * Build a set of path-confined file tools for a role session.
 *
 * Takes the role's declared tools, the role's projection (workspace root
 * + mounts), and returns a set of confined `ToolDefinition` entries that
 * enforce path containment against all projection roots.
 *
 * The confinement checks:
 *   1. Reject absolute paths (starting with `/` or `X:\`).
 *   2. Reject paths containing `..` segments.
 *   3. Resolve the path within the nearest existing ancestor (via `realpath`)
 *      and check containment in the projection.
 *   4. If the resolved path escapes all projection roots, the tool returns
 *      an error result without writing to the capture buffer.
 *
 * Only the tools declared by the role in the manifest are exposed —
 * other file tools (edit/write) are simply not included.
 *
 * @param projection - the role's projection (workspace root + mounts).
 * @param declaredTools - the role's declared tool names (subset of manifest).
 * @returns confined tools, active names, and read-only flag.
 *
 * @remarks
 * The SDK's `customTools` boundary erases each definition's parameter
 * schema. The factories preserve their precise types, then erase only
 * at the return boundary — same pattern as `run-tool.ts` (issue #24).
 *
 * @see spec §6 (tool policy and guarantee levels)
 */
export function buildConfinedTools(
  projection: Projection,
  declaredTools: readonly string[] = [],
): ConfinedToolsResult {
  // Filter to only file tools the role declared, deduplicated.
  const wanted = Array.from(
    new Set(declaredTools.filter((t) => (ROLE_FILE_TOOL_NAMES as readonly string[]).includes(t))),
  );

  if (wanted.length === 0) {
    return { tools: [], activeNames: [], isReadOnly: true };
  }

  // Build projection roots array for containment checks.
  const roots: string[] = [projection.workspaceRoot];
  for (const mount of projection.mounts) {
    roots.push(mount.path);
  }

  const confinedToolDefs: ToolDefinition[] = [];
  const activeNames: string[] = [];
  const wsRoot = roots[0]!; // roots always has at least the workspace root.

  for (const toolName of wanted) {
    switch (toolName) {
      case "read":
        confinedToolDefs.push(
          confinePathTool(createReadToolDefinition(wsRoot), roots) as ToolDefinition,
        );
        activeNames.push("read");
        break;
      case "grep":
        confinedToolDefs.push(
          confinePathTool(createGrepToolDefinition(wsRoot), roots) as ToolDefinition,
        );
        activeNames.push("grep");
        break;
      case "find":
        confinedToolDefs.push(
          confinePathTool(createFindToolDefinition(wsRoot), roots) as ToolDefinition,
        );
        activeNames.push("find");
        break;
      case "ls":
        confinedToolDefs.push(
          confinePathTool(createLsToolDefinition(wsRoot), roots) as ToolDefinition,
        );
        activeNames.push("ls");
        break;
      case "edit":
        confinedToolDefs.push(
          confinePathTool(createEditToolDefinition(wsRoot), roots) as ToolDefinition,
        );
        activeNames.push("edit");
        break;
      case "write":
        confinedToolDefs.push(
          confinePathTool(createWriteToolDefinition(wsRoot), roots) as ToolDefinition,
        );
        activeNames.push("write");
        break;
    }
  }

  return {
    tools: confinedToolDefs,
    activeNames: Object.freeze(activeNames),
    isReadOnly: !wanted.includes("edit") && !wanted.includes("write"),
  };
}

// ─── Confinement enforcement (generalized from run-tool.ts) ──────────────

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function hasTraversal(value: string): boolean {
  return value.split(/[\\/]/).includes("..");
}

async function validatePathInProjection(
  path: unknown,
  roots: readonly string[],
): Promise<string | null> {
  if (path !== undefined && typeof path !== "string") {
    return "path must be a string inside the projection";
  }
  const requested = path ?? ".";
  if (isAbsolutePath(requested) || requested.startsWith("~") || hasTraversal(requested)) {
    return "path must be relative and inside the projection";
  }

  // Resolve the workspace root (first root) as the base for candidate path.
  const workspaceRootReal = await realpath(roots[0]!);
  const candidate = resolve(workspaceRootReal, requested);

  // Check if candidate is within the workspace root (primary root).
  if (isWithinRoot(candidate, workspaceRootReal)) {
    // Now verify the nearest existing ancestor via realpath.
    return validateNearestExistingAncestor(candidate, workspaceRootReal);
  }

  // Check against mount roots (skip the workspace root, already checked).
  for (const mountRoot of roots.slice(1)) {
    try {
      const mountRootReal = await realpath(mountRoot);
      if (isWithinRoot(candidate, mountRootReal)) {
        return validateNearestExistingAncestor(candidate, mountRootReal);
      }
    } catch {
      // Mount root doesn't exist yet — skip it; containment will fail later.
    }
  }

  return "path resolves outside the projection roots";
}

async function validateNearestExistingAncestor(
  candidate: string,
  nearestRoot: string,
): Promise<string | null> {
  for (;;) {
    try {
      const resolved = await realpath(candidate);
      return isWithinRoot(resolved, nearestRoot) ? null : "path resolves outside the projection";
    } catch (cause) {
      if (!isNotFound(cause)) throw cause;
      const parent = dirname(candidate);
      if (parent === candidate) return "path must be inside the projection";
      candidate = parent;
    }
  }
}

function isWithinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function isNotFound(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

function confinePathTool<TParams extends TSchema, TDetails, TState>(
  tool: ToolDefinition<TParams, TDetails, TState>,
  projection: readonly string[],
): ToolDefinition<TParams, TDetails, TState> {
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const pathArg = (params as Static<TParams> & { path?: string }).path;
      const failure = await validatePathInProjection(pathArg, projection);
      if (failure !== null) return fileToolError<TDetails>(failure);
      return tool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

function fileToolError<TDetails>(text: string): AgentToolResult<TDetails> {
  return {
    content: [{ type: "text" as const, text }],
    details: undefined as TDetails,
    terminate: false,
  };
}
