/** Path-confined child tools — delegation lite §6. */

import { execFile } from "node:child_process";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  type AgentToolResult,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
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

/** Build the argv-only child `run` tool; built-in file tools use the child cwd (§6). */
export function buildChildTools(opts: ChildToolOptions): ToolDefinition[] {
  return [buildConstrainedRunTool(opts)];
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

function toolError(text: string): AgentToolResult<RunDetails> {
  return {
    content: [{ type: "text" as const, text }],
    details: { error: text, exitCode: null },
    terminate: false,
  };
}
