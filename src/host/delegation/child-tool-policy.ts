/**
 * Child tool allowlist builder (spec §7.3, issue #17 §7.3).
 *
 * Children are auxiliary sessions that must NOT receive handoff, end,
 * ask_user, or delegate — only the parent can transition the FSM.
 * The allowlist is the single source of truth used by BOTH hosts
 * (StubHost and ProductionHost); any drift between hosts is a bug.
 *
 * `read_only` children receive read-only tools only (no write access).
 * `worktree` children additionally receive edit, write, run (the restricted
 * argv-based runner — not bash).
 *
 * The `run` tool is registered for `worktree` children only; it never
 * appears in the `read_only` allowlist.
 *
 * @see buildChildToolsAllowlist
 * @see createRunTool
 */

import type { Role } from "../../index.js";

/** Tools available to read-only children (spec §7.3). */
const READ_ONLY_TOOLS = Object.freeze(["read", "grep", "find", "ls", "report_result"] as const);

/** Tools available to worktree children (spec §7.4, §5 decision 2). */
const WORKTREE_TOOLS = Object.freeze([
  "read",
  "grep",
  "find",
  "ls",
  "edit",
  "write",
  "run",
  "report_result",
] as const);

/**
 * The tools NEVER available to any child session (spec §7.3).
 * This list documents the hard boundary; it is enforced by construction
 * (both allowlists are defined without these names).
 */
const FORBIDDEN_TOOLS = Object.freeze(["handoff", "end", "ask_user", "delegate", "bash"] as const);

export interface BuildChildToolsAllowlistArgs {
  readonly workspace: "read_only" | "worktree";
  readonly role: Role;
}

/**
 * Build the tool allowlist for a child session given its workspace mode.
 *
 * - `read_only`: `["read", "grep", "find", "ls", "report_result"]`
 * - `worktree`:  `["read", "grep", "find", "ls", "edit", "write", "run", "report_result"]`
 *
 * `report_result` is always present in both modes. `handoff`, `end`,
 * `ask_user`, `delegate`, and `bash` are NEVER in either allowlist.
 */
export function buildChildToolsAllowlist(args: BuildChildToolsAllowlistArgs): readonly string[] {
  switch (args.workspace) {
    case "read_only":
      return READ_ONLY_TOOLS;
    case "worktree":
      return WORKTREE_TOOLS;
    // istanbul ignore next: exhaustive at the type level
    default:
      // Defensive: if a new workspace mode is added in the future,
      // fail explicitly rather than silently returning everything.
      throw new Error(`Unknown workspace mode: ${String(args.workspace satisfies never)}`);
  }
}

/**
 * Check whether a tool name is in the forbidden list.
 * Used by `createRunTool` for defensive validation of the tool name.
 */
export function isForbiddenTool(name: string): boolean {
  return (FORBIDDEN_TOOLS as readonly string[]).includes(name);
}
