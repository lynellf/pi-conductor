/** Path-confined child tools — delegation lite §6. */

import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  type AgentToolResult,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);
const ALLOWED_COMMANDS = new Set(["git", "pnpm", "npm", "node", "npx", "grep", "find", "ls"]);
const ALLOWED_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "add",
  "commit",
  "branch",
  "log",
  "show",
  "rev-parse",
]);
const SHELL_METACHARACTERS = /[|&;<>()$`]/;

/** Context used to build a confined child tool surface. */
export interface ChildToolOptions {
  readonly worktreePath: string;
  readonly runId: string;
  readonly childId: string;
  readonly parentRole: string;
  readonly taskId: string;
}

/** Build the child file and argv tools, all confined to its generated worktree (§6). */
export function buildChildTools(opts: ChildToolOptions): ToolDefinition[] {
  const root = resolve(opts.worktreePath);
  const tools = [
    confinePathTool(createReadToolDefinition(root), root),
    confinePathTool(createGrepToolDefinition(root), root),
    confinePathTool(createFindToolDefinition(root), root),
    confinePathTool(createLsToolDefinition(root), root),
    confinePathTool(createEditToolDefinition(root), root),
    confinePathTool(createWriteToolDefinition(root), root),
    buildConstrainedRunTool(opts),
  ];
  // The SDK's `customTools` boundary erases each definition's parameter
  // schema. Preserve the factories' precise types above, then erase only here.
  return tools as unknown as ToolDefinition[];
}

interface RunDetails {
  readonly error: string | null;
  readonly exitCode: number | null;
}

const runSchema = Type.Object(
  {
    argv: Type.Array(Type.String(), { minItems: 1 }),
    cwd: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

function buildConstrainedRunTool(opts: ChildToolOptions): ToolDefinition {
  const root = resolve(opts.worktreePath);
  const expectedBranch = `conductor/${opts.runId}/${opts.childId}`;

  return defineTool<typeof runSchema, RunDetails>({
    name: "run",
    label: "run",
    description: `Run an allowlisted argv command in ${root}; Git is limited to ${expectedBranch}.`,
    parameters: runSchema,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<RunDetails>> {
      const failure = validateRun(params.argv, params.cwd, root);
      if (failure !== null) return toolError(failure);

      const command = params.argv[0];
      if (command === undefined) return toolError("run requires a non-empty argv array");
      if (!ALLOWED_COMMANDS.has(command)) {
        return toolError(`command '${command}' is not permitted`);
      }
      if (command === "git") {
        const gitFailure = validateGit(params.argv.slice(1));
        if (gitFailure !== null) return toolError(gitFailure);
      }

      const cwd = resolveChildCwd(params.cwd, root);
      try {
        const { stdout, stderr } = await execFileAsync(command, params.argv.slice(1), {
          cwd,
          signal,
          maxBuffer: 1024 * 1024,
        });
        return {
          content: [{ type: "text", text: [stdout, stderr].filter(Boolean).join("\n") || "ok" }],
          details: { error: null, exitCode: 0 },
          terminate: false,
        };
      } catch (cause) {
        const error = cause as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
        const output = [error.stdout, error.stderr, error.message].filter(Boolean).join("\n");
        return {
          content: [{ type: "text", text: output }],
          details: {
            error: error.message,
            exitCode: typeof error.code === "number" ? error.code : null,
          },
          terminate: false,
        };
      }
    },
  });
}

function validateRun(
  argv: readonly string[],
  cwd: string | undefined,
  root: string,
): string | null {
  if (argv.length === 0) return "run requires a non-empty argv array";
  if (cwd !== undefined) {
    if (
      isAbsolutePath(cwd) ||
      hasTraversal(cwd) ||
      !isWithinRoot(resolveChildCwd(cwd, root), root)
    ) {
      return "cwd must be a relative path inside the child worktree";
    }
  }
  for (const arg of argv) {
    if (SHELL_METACHARACTERS.test(arg)) return `shell metacharacters are not permitted: '${arg}'`;
    const value = optionValue(arg);
    if (isAbsolutePath(value) || hasTraversal(value)) {
      return `outside path is not permitted: '${arg}'`;
    }
  }
  return null;
}

function validateGit(args: readonly string[]): string | null {
  const subcommand = args[0];
  if (subcommand === undefined || !ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
    return "git requires an allowed inspection or commit subcommand";
  }
  for (const arg of args) {
    if (
      arg === "-C" ||
      arg.startsWith("-C") ||
      arg.startsWith("--git-dir") ||
      arg.startsWith("--work-tree")
    ) {
      return `git option '${arg}' is not permitted`;
    }
  }
  if (subcommand === "branch" && args.slice(1).some((arg) => arg !== "--show-current")) {
    return "git branch only permits '--show-current'";
  }
  if (
    subcommand === "rev-parse" &&
    args.slice(1).some((arg) => arg !== "HEAD" && arg !== "--abbrev-ref")
  ) {
    return "git rev-parse only permits HEAD inspection";
  }
  return null;
}

function optionValue(arg: string): string {
  const equals = arg.indexOf("=");
  return equals === -1 ? arg : arg.slice(equals + 1);
}

function resolveChildCwd(cwd: string | undefined, root: string): string {
  return resolve(root, cwd ?? ".");
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
    content: [{ type: "text", text }],
    details: undefined as TDetails,
    terminate: false,
  };
}

function toolError(text: string): AgentToolResult<RunDetails> {
  return {
    content: [{ type: "text" as const, text }],
    details: { error: text, exitCode: null },
    terminate: false,
  };
}
