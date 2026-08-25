/**
 * Path-confined file tools for role sessions — spec §6, T4.
 *
 * Generalizes the issue #24 child confinement factory (`buildChildTools`) to
 * role sessions: built-in file tool definitions are replaced via
 * `customTools` with path-confined variants (reject absolute/`..` paths;
 * `realpath` containment check on the nearest existing ancestor).
 *
 * The key difference from the child factory is that a role has one default
 * root (its workspace). Declared additional roots are exposed only through
 * the explicit virtual `mounts/<index>/...` namespace.
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

import type { Projection } from "./mounts.js";

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
 * Takes the role's declared tools and projection, and returns confined
 * `ToolDefinition` entries. Workspace-relative paths retain the SDK's
 * normal behavior. A declared mount is addressable only as
 * `mounts/<declared-mount-index>/...`; a validated virtual path is translated
 * to that mount's physical root just before calling the SDK definition.
 *
 * The confinement checks reject absolute, home-relative, and traversal paths,
 * resolve the nearest existing ancestor via `realpath`, and check containment
 * against the selected root. `edit` and `write` reject read-only mounts before
 * calling the SDK tool.
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

  const workspaceRoot = projection.workspaceRoot;
  const confinedToolDefs: ToolDefinition[] = [];
  const activeNames: string[] = [];

  for (const toolName of wanted) {
    switch (toolName) {
      case "read":
        confinedToolDefs.push(
          confinePathTool(
            createReadToolDefinition(workspaceRoot),
            projection,
            false,
          ) as ToolDefinition,
        );
        activeNames.push("read");
        break;
      case "grep":
        confinedToolDefs.push(
          confinePathTool(
            createGrepToolDefinition(workspaceRoot),
            projection,
            false,
          ) as ToolDefinition,
        );
        activeNames.push("grep");
        break;
      case "find":
        confinedToolDefs.push(
          confinePathTool(
            createFindToolDefinition(workspaceRoot),
            projection,
            false,
          ) as ToolDefinition,
        );
        activeNames.push("find");
        break;
      case "ls":
        confinedToolDefs.push(
          confinePathTool(
            createLsToolDefinition(workspaceRoot),
            projection,
            false,
          ) as ToolDefinition,
        );
        activeNames.push("ls");
        break;
      case "edit":
        confinedToolDefs.push(
          confinePathTool(
            createEditToolDefinition(workspaceRoot),
            projection,
            true,
          ) as ToolDefinition,
        );
        activeNames.push("edit");
        break;
      case "write":
        confinedToolDefs.push(
          confinePathTool(
            createWriteToolDefinition(workspaceRoot),
            projection,
            true,
          ) as ToolDefinition,
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
  return value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value);
}

function hasTraversal(value: string): boolean {
  return value.split(/[\\/]/).includes("..");
}

type RoutedPath =
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "routed";
      readonly sdkPath: string;
      readonly writable: boolean;
      readonly virtualMount: boolean;
    };

async function routePathInProjection(path: unknown, projection: Projection): Promise<RoutedPath> {
  if (path !== undefined && typeof path !== "string") {
    return { kind: "error", message: "path must be a string inside the projection" };
  }
  const requested = path ?? ".";
  if (isAbsolutePath(requested) || requested.startsWith("~") || hasTraversal(requested)) {
    return { kind: "error", message: "path must be relative and inside the projection" };
  }

  const mountIndex = virtualMountIndex(requested);
  if (mountIndex === null) {
    const workspaceRootReal = await realpath(projection.workspaceRoot);
    const candidate = resolve(workspaceRootReal, requested);
    if (!isWithinRoot(candidate, workspaceRootReal)) {
      return { kind: "error", message: "path resolves outside the workspace" };
    }
    const failure = await validateNearestExistingAncestor(candidate, workspaceRootReal);
    return failure === null
      ? { kind: "routed", sdkPath: requested, writable: true, virtualMount: false }
      : { kind: "error", message: failure };
  }

  const mount = projection.mounts[mountIndex];
  if (mount === undefined) {
    return { kind: "error", message: "declared mount index is not available" };
  }

  let mountRootReal: string;
  try {
    mountRootReal = await realpath(mount.path);
  } catch (cause) {
    if (isNotFound(cause)) {
      return { kind: "error", message: "declared mount is unavailable" };
    }
    throw cause;
  }
  const relativeMountPath = requested.split(/[\\/]/).slice(2);
  const candidate = resolve(mountRootReal, ...relativeMountPath);
  if (!isWithinRoot(candidate, mountRootReal)) {
    return { kind: "error", message: "path resolves outside the declared mount" };
  }
  const failure = await validateNearestExistingAncestor(candidate, mountRootReal);
  return failure === null
    ? { kind: "routed", sdkPath: candidate, writable: mount.writable, virtualMount: true }
    : { kind: "error", message: failure };
}

function virtualMountIndex(requested: string): number | null {
  const segments = requested.split(/[\\/]/);
  if (
    segments[0] !== "mounts" ||
    segments[1] === undefined ||
    !/^(0|[1-9]\d*)$/.test(segments[1])
  ) {
    return null;
  }
  const index = Number(segments[1]);
  return Number.isSafeInteger(index) ? index : null;
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
  projection: Projection,
  writes: boolean,
): ToolDefinition<TParams, TDetails, TState> {
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const pathArg = (params as Static<TParams> & { path?: unknown }).path;
      const routed = await routePathInProjection(pathArg, projection);
      if (routed.kind === "error") return fileToolError<TDetails>(routed.message);
      if (writes && !routed.writable) {
        return fileToolError<TDetails>("path is inside a read-only mount");
      }
      if (!routed.virtualMount) {
        return tool.execute(toolCallId, params, signal, onUpdate, ctx);
      }
      const routedParams = {
        ...(params as Static<TParams> & object),
        path: routed.sdkPath,
      } as unknown as Static<TParams>;
      return tool.execute(toolCallId, routedParams, signal, onUpdate, ctx);
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
