/**
 * Restricted argv-based `run` tool for worktree children (spec §5 decision 2,
 * §7.4, issue #17 §5 decision 2, §7.4).
 *
 * NOT a sandbox — it is a tool policy that restricts the command surface.
 * The child process is NOT isolated from arbitrary network, credential, or
 * port access. The allowlist reduces, but does not eliminate, the risk of
 * unintended filesystem mutations.
 *
 * Policy:
 * - Uses `node:child_process.execFile` (never `exec` or `spawn` with shell)
 *   with argv arrays — no shell interpolation.
 * - Rejects absolute paths outside the worktree.
 * - Rejects `..` escapes.
 * - Rejects shell metacharacters in command strings (anything not in the
 *   tight allowlist `[A-Za-z0-9_./=:-]`).
 * - Restricts top-level commands to an allowlist.
 * - For `git` operations, restricts to the conductor-owned worktree path
 *   and branch prefix.
 *
 * The tool is NOT registered for `read_only` children (only worktree children
 * receive it).
 */

import { execFile as execFileNode } from "node:child_process";
import { resolve as pathResolve, sep as pathSep, relative } from "node:path";
import { promisify } from "node:util";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const execFile = promisify(execFileNode);

/** Top-level commands allowed in worktree children (spec §7.4). */
const ALLOWED_COMMANDS: readonly string[] = [
  "git",
  "pnpm",
  "node",
  "npm",
  "ls",
  "cat",
  "grep",
  "find",
  "wc",
  "echo",
  "mkdir",
  "rm",
  "cp",
  "mv",
] as const;

/** Characters allowed in command arguments (tight allowlist). */
const SAFE_ARG_PATTERN = /^[A-Za-z0-9_./=:@+-]+$/;
const runParameters = Type.Object({
  command: Type.Array(Type.String(), { minItems: 1 }),
  cwd: Type.Optional(Type.String()),
});

/** Git sub-commands that require path confinement (spec §7.4). */
const ALLOWED_GIT_SUBCOMMANDS: readonly string[] = [
  "status",
  "diff",
  "log",
  "show",
  "ls-files",
  "add",
  "commit",
  "rev-parse",
] as const;

export interface CreateRunToolArgs {
  readonly worktreePath: string;
  readonly branch: string;
  readonly onError?: (msg: string) => void;
}

/** Rejection reasons used in tool result errors. */
export type RunToolRejectionReason =
  | "disallowed_command"
  | "unsafe_arg"
  | "path_outside_worktree"
  | "escape_sequence"
  | "git_branch_violation"
  | "exec_failed";

function textContent(text: string) {
  return { type: "text" as const, text };
}

function errorResult(text: string): {
  content: { type: "text"; text: string }[];
  details: Record<string, never>;
  terminate: boolean;
} {
  return { content: [textContent(text)], details: {}, terminate: false };
}

/**
 * Create the restricted `run` tool for a worktree child.
 *
 * Registered ONLY for `worktree` children (never `read_only`).
 */
export function createRunTool(args: CreateRunToolArgs) {
  const { worktreePath, branch, onError } = args;
  const normalizedWorktreePath = pathResolve(worktreePath);

  return defineTool({
    name: "run",
    label: "run",
    description: `Restricted command runner for worktree child (confined to ${worktreePath})`,
    parameters: runParameters,
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      if (!Value.Check(runParameters, params)) {
        return errorResult("command must be a non-empty array of strings");
      }
      const p = params as Static<typeof runParameters>;
      const command = p.command;

      // Validate command shape.
      if (!Array.isArray(command) || command.length === 0) {
        return errorResult("command must be a non-empty array");
      }

      for (const arg of command) {
        if (typeof arg !== "string") {
          return errorResult("all command elements must be strings");
        }
      }

      // Cast after validation.
      const cmd = command as string[];
      const topLevel = cmd[0] as string;

      // Check top-level command allowlist.
      if (!ALLOWED_COMMANDS.includes(topLevel)) {
        logError(`disallowed command: ${topLevel}`);
        return errorResult(
          `Command "${topLevel}" is not allowed. Allowed commands: ${ALLOWED_COMMANDS.join(", ")}`,
        );
      }

      // Check for shell metacharacters in all args.
      for (const arg of cmd) {
        if (!SAFE_ARG_PATTERN.test(arg)) {
          logError(`unsafe arg in command: ${arg}`);
          return errorResult(
            `Argument "${arg}" contains unsafe characters. Only [A-Za-z0-9_./=:@+-] are allowed.`,
          );
        }
      }

      // Check for `..` escape sequences in all args.
      for (const arg of cmd) {
        if (arg.includes("..")) {
          logError(`escape sequence in arg: ${arg}`);
          return errorResult("Argument must not contain '..' path escape sequences");
        }
      }

      // Absolute argv paths must remain inside this generated worktree.
      for (const arg of cmd.slice(1)) {
        if (arg.startsWith("/")) {
          const rel = relative(normalizedWorktreePath, pathResolve(arg));
          if (rel === ".." || rel.startsWith(`..${pathSep}`) || rel.startsWith(pathSep)) {
            logError(`path outside worktree in argv: ${arg}`);
            return errorResult(`Argument "${arg}" resolves outside the worktree`);
          }
        }
      }

      // Reject git -C, --git-dir, --work-tree which can escape the worktree.
      // These flags change the repository root, bypassing our cwd containment check.
      for (let i = 0; i < cmd.length; i++) {
        const arg = cmd[i] as string;
        // -C must be followed by a path argument.
        if (arg === "-C" && i + 1 < cmd.length) {
          const targetPath = cmd[i + 1] as string;
          // Reject -C that targets a path outside the worktree.
          const normalizedTarget = pathResolve(targetPath);
          if (
            !normalizedTarget.startsWith(`${normalizedWorktreePath}/`) &&
            normalizedTarget !== normalizedWorktreePath
          ) {
            logError(`git -C escapes worktree: ${targetPath}`);
            return errorResult(`git -C is not allowed to change directory outside the worktree`);
          }
        }
        // Never allow repository-root overrides. A worktree's `.git` file can
        // point at the primary checkout, so even a lexically-contained value
        // would bypass the generated worktree boundary.
        if (
          arg === "--git-dir" ||
          arg === "--work-tree" ||
          arg.startsWith("--git-dir=") ||
          arg.startsWith("--work-tree=")
        ) {
          logError(`${arg} is not permitted`);
          return errorResult(`${arg} is not permitted for child Git commands`);
        }
        // Also reject -C with = syntax (e.g., git -C=/tmp/repo).
        if (arg.startsWith("-C=")) {
          const targetPath = arg.slice(3);
          const normalizedTarget = pathResolve(targetPath);
          if (
            !normalizedTarget.startsWith(`${normalizedWorktreePath}/`) &&
            normalizedTarget !== normalizedWorktreePath
          ) {
            logError(`git -C= escapes worktree`);
            return errorResult(`git -C is not allowed to change directory outside the worktree`);
          }
        }
      }

      // Path confinement: working directory must be inside the worktree.
      // Use path.resolve to normalize paths so .. escapes are detected.
      const effectiveCwd = pathResolve(p.cwd ?? worktreePath);
      // Check that effectiveCwd is contained within worktreePath (not equal to or parent of it).
      if (
        !effectiveCwd.startsWith(`${normalizedWorktreePath}/`) &&
        effectiveCwd !== normalizedWorktreePath
      ) {
        logError(`path outside worktree: ${effectiveCwd}`);
        return errorResult(
          `Working directory "${effectiveCwd}" must be within the worktree "${normalizedWorktreePath}"`,
        );
      }

      // For git commands, allow only inspection and commits on the generated branch.
      if (topLevel === "git") {
        const subcommand = cmd[1];
        const branchFlag = cmd.indexOf("-b");
        const requestedBranch = branchFlag >= 0 ? cmd[branchFlag + 1] : undefined;
        if (
          (subcommand === "checkout" || subcommand === "switch" || subcommand === "branch") &&
          requestedBranch !== undefined &&
          !requestedBranch.startsWith("conductor/")
        ) {
          return errorResult(`Git branch "${requestedBranch}" must start with "conductor/".`);
        }
        if (subcommand === undefined || !ALLOWED_GIT_SUBCOMMANDS.includes(subcommand)) {
          logError(`git subcommand is not allowed: ${subcommand ?? ""}`);
          return errorResult(
            "Only bounded inspection, staging, and commit Git commands are allowed",
          );
        }
        if (!/^conductor\/child-[0-9a-f]{1,64}$/u.test(branch)) {
          logError(`invalid conductor branch: ${branch}`);
          return errorResult("Child branch is not conductor-owned");
        }
        // If the command contains a `-b` flag followed by a branch, validate it.
        const branchIdx = cmd.indexOf("-b");
        if (branchIdx >= 0 && cmd[branchIdx + 1] !== undefined) {
          const requestedBranch = cmd[branchIdx + 1] as string;
          if (!requestedBranch.startsWith("conductor/")) {
            logError(`git branch violation: ${requestedBranch}`);
            return errorResult(
              `Git branch "${requestedBranch}" must start with "conductor/". Only conductor-owned branches are allowed.`,
            );
          }
        }
        // Disallow direct references to non-conductor branches.
        for (let i = 1; i < cmd.length; i++) {
          const arg = cmd[i] as string;
          if (arg.startsWith("refs/heads/") && !arg.startsWith("refs/heads/conductor/")) {
            logError(`git branch ref violation: ${arg}`);
            return errorResult(
              `Git ref "${arg}" is not allowed. Only conductor-owned refs are permitted.`,
            );
          }
        }
      }

      // Execute the command.
      try {
        const result = await execFile(topLevel, cmd.slice(1), {
          cwd: effectiveCwd,
          timeout: 60_000,
        });
        return {
          content: [textContent(result.stdout || "(no output)")],
          details: {},
          terminate: false,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(`exec failed: ${msg}`);
        return errorResult(`Command failed: ${msg}`);
      }
    },
  });

  function logError(msg: string): void {
    if (onError) onError(msg);
  }
}
